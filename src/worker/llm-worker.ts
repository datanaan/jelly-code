/**
 * BullMQ worker for LLM-derivation and LLM-enrichment queues.
 *
 * Concurrency controlled by worker option (BullMQ-level) — this worker
 * processes one job at a time per concurrency slot. Inside a job, nodes
 * are processed sequentially; intra-job parallelism comes from running
 * multiple worker instances or raising concurrency.
 */
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../core/redis-connection.js';
import {
  llmDerivationQueue,
  llmEnrichmentQueue,
  type DerivationJobData,
  type EnrichmentJobData,
} from '../core/queue-setup.js';
import type { StoreSet } from '../store/interfaces.js';
import type { WikiService } from '../wiki/service.js';
import type { ILLMClient } from '../llm/interface.js';
import type { DerivationRules } from '../wiki/derivation-rules.js';
import { WikiDerivationEngine } from '../wiki/derivation-engine.js';
import { logger } from '../core/logger.js';
import { BrokenCircuitError } from 'cockatiel';

export interface LLMWorkerDeps {
  stores: StoreSet;
  wikiService: WikiService;
  pool: ILLMClient;
  rules: DerivationRules;
}

export interface DerivationJobResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * Create the job handler (extracted for unit test without BullMQ).
 */
export function createLLMDerivationHandler(deps: LLMWorkerDeps) {
  return async (job: Job<DerivationJobData>): Promise<DerivationJobResult> => {
    const { projectId, nodes } = job.data;
    if (!deps.rules.enabled) {
      logger.info({ projectId, count: nodes.length }, '[llm-worker] derivation disabled, skipping');
      return { processed: 0, skipped: nodes.length, errors: 0 };
    }

    // Fetch node details from graph (one query instead of N)
    const rows = await deps.stores.graph.query(
      `MATCH (n {projectId: $projectId})
       WHERE n.id IN $nodeIds
       RETURN n.id AS id, n.name AS name, n.type AS type,
              n.filePath AS filePath, n.content AS content`,
      { projectId, nodeIds: nodes },
    ) ?? [];

    // No nodes found — nothing to process
    if (rows.length === 0) {
      return { processed: 0, skipped: 0, errors: 0 };
    }

    const engine = new WikiDerivationEngine(deps.wikiService, deps.pool, deps.rules);
    let processed = 0;
    let errors = 0;
    let circuitsAllOpen = false;

    for (let i = 0; i < rows.length; i++) {
      // If all LLM circuits are open, skip remaining nodes (fast-fail)
      if (circuitsAllOpen) {
        errors += rows.length - i;
        break;
      }

      const row = rows[i];
      try {
        const node = {
          id: row.id as string,
          name: (row.name as string) ?? '',
          type: (row.type as string) ?? '',
          filePath: (row.filePath as string) ?? '',
          content: (row.content as string) ?? undefined,
          matchedRule: 'worker-batch',
        };
        const created = await engine.deriveOne(projectId, node);
        if (created) processed++;
      } catch (err) {
        errors++;
        logger.warn(
          { projectId, nodeId: row.id, err: err instanceof Error ? err.message : String(err) },
          '[llm-worker] deriveOne failed',
        );
        // Detect all-circuits-open via BrokenCircuitError from cockatiel
        if (err instanceof BrokenCircuitError) {
          circuitsAllOpen = true;
        }
      }
      await job.updateProgress({ done: i + 1, total: rows.length });
    }

    logger.info({ projectId, jobId: job.id, processed, errors, circuitsAllOpen }, '[llm-worker] derivation batch done');
    return { processed, skipped: nodes.length - processed - errors, errors };
  };
}

export function createLLMWorker(deps: LLMWorkerDeps): Worker[] {
  const concurrency = parseInt(process.env.LLM_WORKER_CONCURRENCY || '2', 10);
  const handler = createLLMDerivationHandler(deps);

  const derivationWorker = new Worker<DerivationJobData, DerivationJobResult>(
    'llm-derivation',
    handler,
    {
      connection: getRedisConnection(),
      concurrency,
      limiter: {
        max: parseInt(process.env.LLM_RATE_LIMIT_PER_MIN || '240', 10),
        duration: 60_000,
      },
    },
  );

  // Enrichment worker (community enrichment — reuses LLM pool)
  const enrichmentWorker = new Worker<EnrichmentJobData>(
    'llm-enrichment',
    createLLMEnrichmentHandler(deps),
    {
      connection: getRedisConnection(),
      concurrency,
      limiter: {
        max: parseInt(process.env.LLM_RATE_LIMIT_PER_MIN || '240', 10),
        duration: 60_000,
      },
    },
  );

  return [derivationWorker, enrichmentWorker];
}

/**
 * Enrichment handler: processes a batch of community IDs.
 * Fetches community data from graph, calls LLM via pool, writes enrichment back.
 */
export function createLLMEnrichmentHandler(deps: LLMWorkerDeps) {
  return async (job: Job<EnrichmentJobData>): Promise<{ processed: number; errors: number }> => {
    const { projectId, communityIds } = job.data;
    if (!deps.rules.enabled) {
      return { processed: 0, errors: 0 };
    }

    // Fetch community + member info from graph
    const rows = await deps.stores.graph.query(
      `MATCH (c:Community {projectId: $projectId})
       WHERE c.id IN $communityIds
       OPTIONAL MATCH (n)-[r:IN_COMMUNITY]->(c)
       WITH c, collect({ name: n.name, filePath: n.filePath, type: n.type }) AS members
       RETURN c.id AS id, c.heuristicLabel AS heuristicLabel, c.label AS label,
              members[0..20] AS members`,
      { projectId, communityIds },
    );

    let processed = 0;
    let errors = 0;
    let circuitsAllOpen = false;
    for (let i = 0; i < rows.length; i++) {
      if (circuitsAllOpen) {
        errors += rows.length - i;
        break;
      }

      const row = rows[i];
      try {
        const members = (row.members as any[]) ?? [];
        if (members.length === 0) continue;

        const memberList = members.slice(0, 20).map(m => `${m.name} (${m.type})`).join(', ');
        const prompt = `Analyze this code cluster and provide a semantic name and short description.

Heuristic: "${row.heuristicLabel ?? row.label}"
Members: ${memberList}

Reply with JSON only:
{"name": "2-4 word semantic name", "description": "One sentence describing purpose"}`;

        const response = await deps.pool.generate(prompt);
        const jsonMatch = response.match(/\{[\sS]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          await deps.stores.graph.query(
            `MATCH (c:Community {id: $cid, projectId: $projectId})
             SET c.semanticName = $name, c.description = $description, c.enrichedAt = datetime()`,
            { cid: row.id, projectId, name: parsed.name ?? row.heuristicLabel, description: parsed.description ?? '' },
          );
        }
        processed++;
      } catch (err) {
        errors++;
        logger.warn(
          { projectId, communityId: row.id, err: err instanceof Error ? err.message : String(err) },
          '[llm-worker] community enrichment failed',
        );
        if (err instanceof BrokenCircuitError) {
          circuitsAllOpen = true;
        }
      }
      await job.updateProgress({ done: i + 1, total: rows.length });
    }

    logger.info({ projectId, jobId: job.id, processed, errors, circuitsAllOpen }, '[llm-worker] enrichment batch done');
    return { processed, errors };
  };
}
