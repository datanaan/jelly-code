/**
 * Code Analysis Runner
 *
 * Orchestrates the full code analysis pipeline:
 * 1. Parse source code (Tree-sitter, 14 languages) via ingestion pipeline
 * 2. Write to three backends:
 *    - Neo4j (graph traversal — nodes + relations + communities + processes)
 *    - Typesense (full-text search)
 *    - Qdrant (vector search)
 *
 * The ingestion pipeline is loaded dynamically at runtime because it's
 * excluded from TypeScript compilation (strict mode incompatibilities
 * from the jelly-code source). tsx handles the .ts files directly.
 */

import { execSync, execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { StoreSet, CodeNode, Relation, SearchDocument } from '../store/interfaces.js';
import { EPOCH } from '../store/bitemporal-model.js';
import type { PipelineResult } from '../types/pipeline.js';
import { BM25Search } from './search/bm25-index.js';
import { EmbeddingPipeline } from './embeddings/embedding-pipeline.js';
import type { RepoCacheManager } from './repo-cache.js';
import { logger } from './logger.js';

// Searchable node types for Typesense indexing
const SEARCHABLE_TYPES = new Set(['Function', 'Class', 'Method', 'Interface', 'File']);

// Absolute path to the ingestion pipeline source (.ts), resolved from the compiled
// dist/ output.  The pipeline is excluded from tsc (strict mode incompatibilities
// in jelly-code code) so we must load the .ts file directly at runtime via tsx.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(__dirname, '..', '..', 'src', 'core', 'ingestion', 'pipeline.ts');

/**
 * Raw output from runPipelineFromRepo — returns a graph object, not the flat
 * arrays that runAnalyze expects.  We convert it below.
 */
interface RawPipelineOutput {
  graph: {
    nodes: Array<{ id: string; label: string; properties: Record<string, unknown> }>;
    relationships: Array<{
      id: string; sourceId: string; targetId: string; type: string;
      confidence: number; reason: string; step?: number;
    }>;
  };
  totalFileCount?: number;
  communityResult?: {
    communities: Array<{
      id: string; label: string; heuristicLabel: string; keywords: string[];
      description: string; cohesion: number; symbolCount: number;
    }>;
    memberships?: Array<unknown>;
    stats?: { totalCommunities: number; modularity: number };
  };
  processResult?: {
    processes: Array<{
      id: string; label: string; processType: string; stepCount: number;
      communities: string[]; entryPointId?: string;
    }>;
    stats?: { totalProcesses: number };
  };
}

function convertPipelineOutput(raw: RawPipelineOutput): PipelineResult {
  const nodes = (raw.graph.nodes || []).map(n => ({
    id: n.id,
    type: n.label,
    name: (n.properties?.name as string) || n.id,
    filePath: (n.properties?.filePath as string) || '',
    ...n.properties,
  }));

  const relations = (raw.graph.relationships || []).map(r => ({
    sourceId: r.sourceId,
    targetId: r.targetId,
    type: r.type,
    confidence: r.confidence,
    reason: r.reason,
    step: r.step,
  }));

  const communities = raw.communityResult?.communities || [];
  const processes = raw.processResult?.processes || [];

  return { nodes, relations, communities, processes };
}

/**
 * Default pipeline runner that loads the ingestion pipeline at runtime.
 *
 * The ingestion module is excluded from tsc compilation due to strict mode
 * issues in the jelly-code source code. We use Function() to prevent TypeScript
 * from statically analyzing the import path. At runtime, tsx resolves and
 * executes the .ts files directly.
 *
 * The pipeline returns { graph, communityResult, processResult } — we convert
 * it to the PipelineResult format that runAnalyze expects.
 */
export const defaultPipelineRunner = async (
  repoPath: string,
  onProgress?: (phase: string, percent: number) => void,
  options?: Record<string, unknown>,
): Promise<PipelineResult> => {
  // Dynamic import via string to avoid TypeScript static analysis
  // (pipeline.ts is excluded from tsc compilation due to strict mode
  // incompatibilities in jelly-code source code)
  let mod: { runPipelineFromRepo: Function };
  try {
    mod = await import(/* @vite-ignore */ PIPELINE_PATH);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PIPELINE_LOAD_FAILED: Cannot dynamically load pipeline at ${PIPELINE_PATH}. ` +
      `This usually means tsx is not properly resolving the .ts file at runtime. ` +
      `Error: ${msg}`
    );
  }
  try {
    const raw = await mod.runPipelineFromRepo(repoPath, (progress: { phase: string; percent: number; message: string }) => {
      logger.info({ phase: progress.phase, percent: progress.percent, message: progress.message }, 'Pipeline progress');
      if (onProgress) onProgress(progress.phase, progress.percent);
    }, options) as RawPipelineOutput;
    return convertPipelineOutput(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PIPELINE_RUN_FAILED: Pipeline execution failed for ${repoPath}. Error: ${msg}`
    );
  }
};

export interface RunAnalyzeOptions {
  /** Maximum number of worker threads for parallel parsing */
  maxWorkers?: number;
  /** Whether to include test files in the analysis */
  includeTests?: boolean;
  /** Languages to exclude from parsing */
  excludeLanguages?: string[];
  /** Custom pipeline runner (for testing or custom pipelines) */
  pipelineRunner?: (repoPath: string, onProgress?: (phase: string, percent: number) => void, options?: Record<string, unknown>) => Promise<PipelineResult>;
  /** Git URL to clone before analysis (alternative to repoPath). Cloned to temp dir, cleaned up after. */
  gitUrl?: string;
  /** RepoCacheManager for persistent clone caching (Phase 1). When provided with gitUrl, uses persistent clone instead of temp dir. */
  repoCache?: RepoCacheManager;
  /** Progress callback — called during analysis phases (e.g., "parsing", "indexing", "temporal") */
  onProgress?: (phase: string, percent: number) => void;
  /**
   * v1.3.0 Phase 3 T3-4 (D1 fix): WikiService for auto-derivation.
   * When provided, auto-derive triggers after pipeline completion:
   *   1. Load derivation rules (user file or default)
   *   2. Select code nodes via CodeEntitySelector
   *   3. Derive WikiEntity objects via WikiDerivationEngine
   * When absent, auto-derive is skipped (graceful degradation).
   */
  wikiService?: import('../wiki/service.js').WikiService;
  /** v1.4.0: dispatch derivation synchronously (legacy path, for tests).
   * Default: false (async dispatch via JobDispatcher + llm-derivation queue). */
  syncDerivation?: boolean;
  /** v1.4.0: override LLM client (primarily for tests with mocked LLM). */
  llmClient?: import('../llm/interface.js').ILLMClient;
}

export async function runAnalyze(
  repoPath: string,
  projectId: string,
  stores: StoreSet,
  options?: RunAnalyzeOptions,
): Promise<{
  nodeCount: number;
  relationCount: number;
  communityCount: number;
  processCount: number;
}> {
  const gitUrl = options?.gitUrl;
  const repoCache = options?.repoCache;
  let tempDir: string | undefined;
  let effectivePath = repoPath;
  let localPath: string | undefined;
  let lastCommit: string | undefined;

  // If gitUrl provided, clone or use cached clone
  if (gitUrl) {
    // Validate gitUrl to prevent command injection via execSync
    // Strict validation: only https://, ssh://git@, git@ prefix
    const GIT_URL_RE = /^((https?:\/\/|ssh:\/\/git@|git@)[\w.-]+[:/][\w./-]+\.git)$/;
    if (!GIT_URL_RE.test(gitUrl)) {
      throw new Error(`Invalid gitUrl: does not match allowed format. Only https://, ssh://git@, and git@ URLs ending in .git are allowed.`);
    }

    if (repoCache) {
      // Phase 1: persistent clone cache
      localPath = await repoCache.ensureClone(gitUrl, projectId);
      effectivePath = localPath;
    } else {
      // Legacy: temp directory clone
      // Use execFile instead of execSync to avoid shell injection
      tempDir = mkdtempSync(join(tmpdir(), 'jelly-code-'));
      logger.info({ gitUrl, tempDir }, 'Cloning repository');
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', '--depth', '1', gitUrl as string, tempDir as string], {
          timeout: 300_000, // 5 min clone timeout
          maxBuffer: 10 * 1024 * 1024,
        }, (err: Error | null) => {
          if (err) reject(new Error(`git clone failed: ${err.message}`));
          else resolve();
        });
      });
      effectivePath = tempDir;
    }
  } else if (repoPath) {
    // Local path: save path and try to detect lastCommit for later re-use
    localPath = repoPath;
    try {
      lastCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
    } catch {
      // Not a git repo or git not available — non-fatal
    }
  }

  logger.info({ projectId, path: effectivePath }, 'Starting analysis');

  try {
    // ========================================
    // Step 1: Run the parsing pipeline
    // ========================================
    const pipelineRunner = options?.pipelineRunner ?? defaultPipelineRunner;
    const result = await pipelineRunner(effectivePath, options?.onProgress);

    logger.info({ projectId, nodeCount: result.nodes.length, relationCount: result.relations.length },
      'Pipeline extracted');

    options?.onProgress?.('indexing', 50);

    // Get HEAD commit if using persistent clone
    if (localPath) {
      try {
        lastCommit = execSync('git rev-parse HEAD', { cwd: localPath, encoding: 'utf-8' }).trim();
      } catch {
        // Non-fatal
      }
    }

    // ========================================
    // Step 2+: Write pipeline result to all stores
    // ========================================
    const stats = await writePipelineResultToStores(
      result, projectId, stores,
      gitUrl, localPath, lastCommit,
    );

    logger.info({ projectId, nodeCount: stats.nodeCount, relationCount: stats.relationCount },
      'Analysis pipeline completed');

    // ========================================
    // Empty result gate: if pipeline produced zero nodes/relations,
    // mark as error instead of success. This prevents users from
    // seeing "100% complete" but getting empty search results.
    // ========================================
    if (stats.nodeCount === 0 && stats.relationCount === 0) {
      logger.error({ projectId, code: 'EMPTY_RESULT' },
        'Pipeline produced zero nodes — marking as error');
      throw new Error('EMPTY_RESULT: Pipeline produced zero nodes. This usually means tree-sitter parsing failed entirely.');
    }

    // ========================================
    // Step 5: Temporal analysis (optional, requires git history)
    // ========================================
    if (process.env.ENABLE_TEMPORAL !== 'false') {
      await runTemporalStep(effectivePath, projectId, stores, options?.onProgress);
    }

    // ========================================
    // Step 6: v1.4.0 Wiki auto-derivation (async dispatch by default)
    // Triggers when wikiService is provided. Gracefully skips otherwise.
    // - syncDerivation=true → legacy for-loop path (for tests with mocked LLM)
    // - default → dispatch to llm-derivation queue via JobDispatcher
    // ========================================
    if (options?.wikiService) {
      try {
        const { loadRulesWithFallback } = await import('../wiki/derivation-rules.js');
        const { CodeEntitySelector } = await import('../wiki/code-entity-selector.js');

        const defaultRulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'derivation-rules.json');
        const rules = loadRulesWithFallback(effectivePath, defaultRulesPath);

        const selector = new CodeEntitySelector(rules, stores.graph);
        const nodes = await selector.selectNodes(projectId);

        if (nodes.length > 0 && rules.enabled !== false) {
          if (options.syncDerivation) {
            // Legacy sync path (for tests with mocked LLM)
            const { WikiDerivationEngine } = await import('../wiki/derivation-engine.js');
            const engine = new WikiDerivationEngine(
              options.wikiService,
              options.llmClient ?? stores.llm,
              rules,
            );
            const deriveResult = await engine.deriveEntities(projectId, nodes);
            logger.info(
              { projectId, derived: deriveResult.derived, skipped: deriveResult.skipped, errors: deriveResult.errors.length, mode: 'sync' },
              'Wiki derivation (sync mode)',
            );
          } else {
            // v1.4.0: Async dispatch (production path)
            const { JobDispatcher } = await import('./resilience/job-dispatcher.js');
            const { llmDerivationQueue } = await import('./queue-setup.js');
            const dispatcher = new JobDispatcher();
            const batchSize = rules.dispatchBatchSize ?? 10;
            const dispatchResult = await dispatcher.dispatch(
              llmDerivationQueue,
              nodes,
              (batch) => ({ projectId, nodes: batch.map(n => n.id) }),
              { batchSize, jobIdPrefix: `derive-${projectId}-${lastCommit ?? 'nogit'}` },
            );
            logger.info(
              { projectId, batches: dispatchResult.batches, nodes: dispatchResult.dispatched, mode: 'async' },
              'Wiki derivation dispatched',
            );
          }
        }
      } catch (err) {
        logger.warn(
          { projectId, error: err instanceof Error ? err.message : String(err) },
          'Wiki auto-derivation failed (non-fatal)',
        );
      }
    }

    options?.onProgress?.('complete', 100);

    return stats;
  } finally {
    // Clean up temp directory if we cloned (legacy path only)
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        logger.info({ tempDir }, 'Cleaned up temp dir');
      } catch {
        logger.warn({ tempDir }, 'Failed to clean up temp dir');
      }
    }
  }
}

/**
 * Write pipeline result to all three stores (Neo4j, Typesense, Qdrant).
 * Shared between runAnalyze and runIncrementalAnalyze.
 */
export async function writePipelineResultToStores(
  result: PipelineResult,
  projectId: string,
  stores: StoreSet,
  gitUrl?: string,
  localPath?: string,
  lastCommit?: string,
): Promise<{
  nodeCount: number;
  relationCount: number;
  communityCount: number;
  processCount: number;
}> {
  // ========================================
  // Step 2: Add projectId and write to Neo4j
  // ========================================
  const nodes: CodeNode[] = result.nodes.map(n => ({
    ...n,
    projectId,
  }));

  // P1-T4: Bi-temporal attributes on edges.
  //
  // Full analysis stamps every CODE_RELATION edge with:
  //   valid_from = commit timestamp (or EPOCH if no git context)
  //   valid_to   = NULL (currently valid)
  //   txn_from   = now (when we indexed this)
  //   txn_to     = NULL (current view)
  //
  // This ensures edges created by full analysis are bi-temporal from
  // the start, enabling time-travel queries and proper supersede in
  // incremental mode (P1-T3). Legacy edges (pre-P1-T4) are handled
  // via coalesce in read queries — no forced migration needed.
  const nowIso = new Date().toISOString();
  const validFrom = lastCommit ? nowIso : EPOCH;

  const relations: Relation[] = result.relations.map(r => ({
    id: `${r.sourceId}-${r.type}-${r.targetId}`,
    ...r,
    projectId,
    valid_from: validFrom,
    valid_to: null,
    txn_from: nowIso,
    txn_to: null,
  }));

  // Write nodes (batched)
  await stores.graph.batchCreateNodes(nodes);
  logger.info({ projectId, count: nodes.length }, 'Neo4j nodes written');

  // Write relations (batched)
  await stores.graph.batchCreateRelations(relations);
  logger.info({ projectId, count: relations.length }, 'Neo4j relations written');

  // Write communities as nodes
  const communityNodes: CodeNode[] = result.communities.map(c => ({
    id: c.id,
    type: 'Community',
    projectId,
    name: c.label,
    filePath: '',
    heuristicLabel: c.heuristicLabel,
    keywords: c.keywords,
    description: c.description,
    cohesion: c.cohesion,
    symbolCount: c.symbolCount,
  }));
  await stores.graph.batchCreateNodes(communityNodes);

  // Write processes as nodes
  const processNodes: CodeNode[] = result.processes.map(p => ({
    id: p.id,
    type: 'Process',
    projectId,
    name: p.label,
    filePath: '',
    label: p.label,
    processType: p.processType,
    stepCount: p.stepCount,
    communities: p.communities,
    entryPointId: p.entryPointId,
  }));
  await stores.graph.batchCreateNodes(processNodes);

  // Create/update Project node with source URL, commit tracking, and freshness metadata
  const setExtra: string[] = [];
  const uniqueFileCount = new Set(nodes.map(n => n.filePath)).size;
  const params: Record<string, unknown> = {
    projectId,
    nodeCount: nodes.length,
    relationCount: relations.length,
    totalFiles: uniqueFileCount,
  };
  if (gitUrl) { setExtra.push('p.gitUrl = $gitUrl'); params.gitUrl = gitUrl; }
  if (localPath) { setExtra.push('p.localPath = $localPath'); params.localPath = localPath; }
  if (lastCommit) { setExtra.push('p.lastCommit = $lastCommit'); params.lastCommit = lastCommit; }
  if (uniqueFileCount > 0) { setExtra.push('p.totalFiles = $totalFiles'); }

  // Freshness fields: full analysis sets all to fresh
  setExtra.push(
    "p.symbolsFreshness = 'fresh'",
    "p.communitiesFreshness = 'fresh'",
    "p.temporalFreshness = 'fresh'",
    'p.lastFullRebuildAt = datetime()',
    'p.consecutiveIncremental = 0',
    'p.accumulatedChanges = 0',
    'p.fallbackCount = 0',
    'p.totalIncrementalAttempts = 0',
  );

  await stores.graph.query(
    `MERGE (p:Project {id: $projectId})
     SET p.analyzedAt = datetime(), p.nodeCount = $nodeCount, p.relationCount = $relationCount
         ${setExtra.length ? ', ' + setExtra.join(', ') : ''}`,
    params,
  );

  // ========================================
  // Step 3: Write to Typesense (full-text search)
  // ========================================
  await stores.search.ensureCollection(projectId);

  const searchableDocs: SearchDocument[] = nodes
    .filter(n => SEARCHABLE_TYPES.has(n.type))
    .map(n => ({
      id: n.id,
      name: n.name,
      content: (n.content || '').substring(0, 5000),  // Limit content size
      filePath: n.filePath,
      nodeType: n.type,
    }));

  if (searchableDocs.length > 0) {
    await stores.search.indexDocuments(projectId, searchableDocs);
    logger.info({ projectId, count: searchableDocs.length }, 'Typesense documents indexed');
  }

  // ========================================
  // Step 4: Write to Qdrant (vector search)
  // ========================================
  const embeddableNodes = nodes.filter(n =>
    ['Function', 'Class', 'Method', 'Interface'].includes(n.type) &&
    (n.content || n.description)
  );

  if (embeddableNodes.length > 0) {
    const embeddingPipeline = new EmbeddingPipeline(stores.vector);
    await embeddingPipeline.indexEmbeddings(projectId, embeddableNodes);
    logger.info({ projectId, count: embeddableNodes.length }, 'Qdrant vectors indexed');
  }

  return {
    nodeCount: nodes.length,
    relationCount: relations.length,
    communityCount: result.communities.length,
    processCount: result.processes.length,
  };
}

/**
 * Step 5: Temporal analysis — extract git history, build commit/author/ownership data.
 *
 * Uses dynamic imports because the temporal modules are optional and may not
 * be needed in all deployments. Failure is non-fatal: the main analysis still
 * succeeds.
 */
export async function runTemporalStep(
  repoPath: string,
  projectId: string,
  stores: StoreSet,
  onProgress?: (phase: string, percent: number) => void,
  since?: string,
): Promise<void> {
  try {
    const { extractGitLog } = await import('../temporal/git-extractor.js');
    const { detectRenames } = await import('../temporal/rename-detector.js');
    const { mapFileChangesToNodes } = await import('../temporal/commit-parser.js');
    const {
      writeCommits,
      writeAuthors,
      writeChangedInRelations,
      writeAuthoredByRelations,
      writeEvolvedFromRelations,
    } = await import('../temporal/temporal-writer.js');
    type CommitData = import('../temporal/types.js').CommitData;
    type AuthorInfo = import('../temporal/types.js').AuthorInfo;
    type ChangedInRelation = import('../temporal/types.js').ChangedInRelation;
    type AuthoredByRelation = import('../temporal/types.js').AuthoredByRelation;
    type FileChange = import('../temporal/types.js').FileChange;

    await onProgress?.('temporal', 0);

    // Extract git log — pass since for incremental mode (full history for full analysis)
    const gitOptions = since ? { since } : {};
    const { commits, isGitRepo } = extractGitLog(repoPath, gitOptions);
    if (!isGitRepo) {
      logger.info({ projectId }, 'Not a git repository, skipping temporal analysis');
      await onProgress?.('temporal', 100);
      return;
    }

    if (commits.length === 0) {
      logger.info({ projectId }, 'No commits found, skipping temporal analysis');
      await onProgress?.('temporal', 100);
      return;
    }

    await onProgress?.('temporal', 30);

    // Extract authors from commits
    const authorMap = new Map<string, { name: string; email: string; commits: Set<string>; days: Set<string> }>();
    for (const commit of commits) {
      const key = commit.authorEmail;
      if (!authorMap.has(key)) {
        authorMap.set(key, { name: commit.author, email: commit.authorEmail, commits: new Set(), days: new Set() });
      }
      const a = authorMap.get(key)!;
      a.commits.add(commit.hash);
      a.days.add(commit.timestamp.substring(0, 10));
    }

    const authors: AuthorInfo[] = Array.from(authorMap.entries()).map(([, data]) => ({
      name: data.name,
      email: data.email,
      commitCount: data.commits.size,
      activeDays: data.days.size,
    }));

    await onProgress?.('temporal', 50);

    // Map file changes to graph nodes.
    // Pre-load ALL file→nodeId mappings in one batch to avoid N sequential full-table scans.
    const allFilePaths = commits.flatMap(c => c.changedFiles.map(f => f.filePath));
    const fileToNodeMap = await stores.graph.findNodeIdsByFilePaths(projectId, allFilePaths);

    const allChangedInRelations: ChangedInRelation[] = [];
    let totalUnmapped = 0;

    for (const commit of commits) {
      if (commit.changedFiles.length === 0) continue;

      const mapped: ChangedInRelation[] = [];
      const unmapped: FileChange[] = [];

      for (const change of commit.changedFiles) {
        const nodeIds = fileToNodeMap.get(change.filePath);
        if (!nodeIds || nodeIds.length === 0) {
          unmapped.push(change);
        } else {
          for (const nodeId of nodeIds) {
            mapped.push({
              nodeId,
              commitHash: '',
              changeType: change.changeType,
              additions: change.additions ?? 0,
              deletions: change.deletions ?? 0,
              timestamp: '',
            });
          }
        }
      }

      totalUnmapped += unmapped.length;

      // Fill commitHash and timestamp from the parent commit
      for (const rel of mapped) {
        rel.commitHash = commit.hash;
        rel.timestamp = commit.timestamp;
        allChangedInRelations.push(rel);
      }
    }

    await onProgress?.('temporal', 70);

    // Build authored-by relations (aggregated ownership per node+author)
    const authoredByMap = new Map<string, { nodeId: string; authorEmail: string; changeCount: number; lastChangeAt: string }>();
    for (const change of allChangedInRelations) {
      // Find the commit to get the author
      const commit = commits.find(c => c.hash === change.commitHash);
      if (!commit) continue;
      const key = `${change.nodeId}\0${commit.authorEmail}`;
      const existing = authoredByMap.get(key);
      if (existing) {
        existing.changeCount++;
        if (change.timestamp > existing.lastChangeAt) existing.lastChangeAt = change.timestamp;
      } else {
        authoredByMap.set(key, {
          nodeId: change.nodeId,
          authorEmail: commit.authorEmail,
          changeCount: 1,
          lastChangeAt: change.timestamp,
        });
      }
    }

    // Calculate ownership percentages
    const nodeTotalChanges = new Map<string, number>();
    for (const data of authoredByMap.values()) {
      nodeTotalChanges.set(data.nodeId, (nodeTotalChanges.get(data.nodeId) || 0) + data.changeCount);
    }

    const authoredByRelations: AuthoredByRelation[] = Array.from(authoredByMap.values()).map(data => ({
      nodeId: data.nodeId,
      authorEmail: data.authorEmail,
      projectId,
      changeCount: data.changeCount,
      lastChangeAt: data.lastChangeAt,
      ownership: nodeTotalChanges.get(data.nodeId)! > 0
        ? data.changeCount / nodeTotalChanges.get(data.nodeId)!
        : 0,
    }));

    // Detect renames (pass since for incremental mode)
    const renames = await detectRenames(repoPath, since);

    await onProgress?.('temporal', 90);

    // Write everything to Neo4j
    await writeCommits(commits, projectId, stores.graph);
    await writeAuthors(authors, stores.graph);

    // C2: Apply author deduplication — merge duplicate authors by normalized key
    // After writing raw authors, deduplicate and update the graph store
    try {
      const { deduplicateAuthors } = await import('../core/author-dedup.js');
      const deduped = deduplicateAuthors(authors);
      if (deduped.length < authors.length) {
        logger.info({ projectId, rawCount: authors.length, dedupedCount: deduped.length },
          'Author deduplication applied');
        // Update each deduped author's canonical name in Neo4j
        for (const d of deduped) {
          if (d.aliases.length > 0) {
            for (const email of d.emails) {
              await stores.graph.query(
                `MATCH (a:Author {id: $email})
                 SET a.canonicalName = $canonicalName,
                     a.aliases = $aliases,
                     a.deduped = true`,
                { email, canonicalName: d.canonicalName, aliases: d.aliases },
              );
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ projectId, err }, 'Author deduplication failed (non-fatal)');
    }

    await writeChangedInRelations(allChangedInRelations, projectId, stores.graph);
    await writeAuthoredByRelations(authoredByRelations, stores.graph);
    await writeEvolvedFromRelations(renames, projectId, stores.graph);

    logger.info(
      { projectId, commitCount: commits.length, authorCount: authors.length,
        changeCount: allChangedInRelations.length, renameCount: renames.length,
        unmapped: totalUnmapped || undefined },
      'Temporal analysis completed',
    );

    // ========================================
    // Step 5e: Evolution coupling computation
    // ========================================
    await onProgress?.('computing_coupling', 0);

    const { buildCoOccurrenceMatrix } = await import('../coupling/co-occurrence.js');
    const { calculateCouplingMetrics, filterNoisyCouplings } = await import('../coupling/coupling-calculator.js');
    const { writeCoChangedRelations } = await import('../coupling/coupling-writer.js');

    // Reuse the fileToNodeMap already pre-loaded above (Step 5d)
    // No additional queries needed.

    // Build commitsTouchingNode: count commits touching each node
    const commitsTouchingNode = new Map<string, Set<string>>();
    for (const rel of allChangedInRelations) {
      if (!commitsTouchingNode.has(rel.nodeId)) {
        commitsTouchingNode.set(rel.nodeId, new Set());
      }
      commitsTouchingNode.get(rel.nodeId)!.add(rel.commitHash);
    }
    const commitsTouchingNodeCounts = new Map<string, number>();
    for (const [nodeId, commitSet] of commitsTouchingNode) {
      commitsTouchingNodeCounts.set(nodeId, commitSet.size);
    }

    const coOccurrence = buildCoOccurrenceMatrix(commits, fileToNodeMap);
    const metrics = calculateCouplingMetrics(coOccurrence, commitsTouchingNodeCounts, commits.length);
    const filtered = filterNoisyCouplings(metrics);
    await writeCoChangedRelations(filtered, projectId, stores.graph, commits.length);

    logger.info(
      { projectId, coOccurrence: coOccurrence.length, filtered: filtered.length },
      'Coupling analysis completed',
    );

    await onProgress?.('computing_coupling', 100);

    await onProgress?.('temporal', 100);
  } catch (err) {
    logger.warn({ projectId, err }, 'Temporal analysis failed (non-fatal)');
    // Temporal failure is non-fatal — analysis still succeeds
    await onProgress?.('temporal', 100);
  }
}

/**
 * Validate that a repoPath is safe to use — prevents path traversal attacks.
 * Checks:
 * 1. Path must be absolute
 * 2. Path must not contain '..'
 * 3. Path must be within REPO_ALLOWED_BASE (default: /data)
 */
export function validateRepoPath(p: string): string {
  if (!p || typeof p !== 'string') {
    throw new Error('repoPath must be a non-empty string');
  }
  if (!path.isAbsolute(p)) {
    throw new Error('repoPath must be an absolute path');
  }
  const normalized = path.normalize(p);
  if (normalized.includes('..') || normalized.includes('..\\')) {
    throw new Error('repoPath contains path traversal (..)');
  }
  const allowedBase = process.env.REPO_ALLOWED_BASE || '/data';
  if (!normalized.startsWith(allowedBase)) {
    throw new Error(`repoPath must be under ${allowedBase}`);
  }
  return normalized;
}
