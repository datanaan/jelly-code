/**
 * Incremental Analysis Runner
 *
 * Orchestrates incremental code analysis:
 * 1. Fetch/update the persistent clone
 * 2. Detect changes since last analysis
 * 3. Supersede stale data for changed files (P1-T3: soft delete via valid_to)
 * 4. Run the full pipeline (MERGE ensures unchanged files are idempotent)
 * 5. Update Project node with new commit hash
 *
 * P1-T3 Bi-temporal supersede:
 *   Instead of hard-deleting nodes/edges, we SET valid_to on old CODE_RELATION
 *   edges. This preserves the full history of code relationships.
 *   New edges created by the pipeline will have valid_from = now.
 *   Legacy edges (no bi-temporal attrs) are handled via coalesce in read queries.
 *
 * Falls back to full analysis when:
 * - No previous commit hash exists
 * - Change detection fails
 * - The change set is empty (should not happen, but defensive)
 */

import type { StoreSet } from '../store/interfaces.js';
import type { PipelineResult } from '../types/pipeline.js';
import type { RepoCacheManager } from './repo-cache.js';
import { detectChanges } from './change-detector.js';
import type { ChangeSet } from './change-detector.js';
import { findReverseDependencies } from './reverse-dependency-finder.js';
import { runAnalyze, writePipelineResultToStores, defaultPipelineRunner, runTemporalStep } from './run-analyze.js';
import { IncrementalFallbackError } from './incremental-fallback-error.js';
import { rebuildCommunities } from './community-rebuilder.js';
import type { PipelineOptions } from './ingestion/pipeline.js';
import { WikiGraph } from '../wiki/graph.js';
import { checkEntityFreshness } from '../wiki/entity-freshness.js';
import type { EntityFreshnessState } from '../wiki/entity-freshness.js';

/**
 * P1-T3: Bi-temporal constants for supersede.
 *
 * When we soft-delete edges during incremental analysis, we:
 *   1. SET valid_to = supersedeTime, txn_to = now on old CODE_RELATION edges
 *   2. Leave the nodes themselves (they'll be re-MERGED by the pipeline)
 *   3. New edges created by the pipeline will have valid_from = supersedeTime
 *
 * Backward compat: legacy edges without valid_from are matched by
 * coalesce(valid_from, EPOCH) — see bitemporal-queries.ts T2.
 */
const SUPERSEDE_TIME = new Date().toISOString();

export interface StaleWikiEntity {
  entityId: string;
  entityName: string;
  status: EntityFreshnessState;
}

export interface IncrementalResult {
  mode: 'incremental' | 'full';
  nodeCount: number;
  relationCount: number;
  communityCount: number;
  processCount: number;
  changeSet?: {
    modified: number;
    deleted: number;
    added: number;
  };
  fallbackReason?: string;
  /** Wiki entities that are stale/orphaned/unbound after this incremental run (P0c-T6) */
  staleWikiEntities: StaleWikiEntity[];
}

/**
 * Run incremental analysis for a project.
 *
 * Fetches the Project's gitUrl and localPath from Neo4j, updates the clone,
 * detects changes, and only re-indexes the changed portions.
 */
export async function runIncrementalAnalyze(
  projectId: string,
  stores: StoreSet,
  repoCache: RepoCacheManager,
  options?: {
    pipelineRunner?: (repoPath: string, onProgress?: (phase: string, percent: number) => void, options?: PipelineOptions) => Promise<PipelineResult>;
    onProgress?: (phase: string, percent: number) => void;
    /** Pre-computed change set from scheduler, avoids calling detectChanges twice */
    precomputedChangeSet?: ChangeSet;
  },
): Promise<IncrementalResult> {
  // 1. Get project info from Neo4j
  const result = await stores.graph.query(
    'MATCH (p:Project {id: $projectId}) RETURN p.gitUrl AS gitUrl, p.localPath AS localPath, p.lastCommit AS lastCommit',
    { projectId },
  );
  const project = result[0] as Record<string, unknown> | undefined;

  if (!project?.gitUrl) {
    throw new Error(`Project ${projectId} not found or has no gitUrl stored. Run full analyze first.`);
  }

  const incrementalStartMs = Date.now();
  const gitUrl = project.gitUrl as string;

  // 2. Update clone
  const localPath = await repoCache.ensureClone(gitUrl, projectId);

  // 3. Detect changes (use precomputed if available, e.g. from scheduler)
  const changeSet = options?.precomputedChangeSet ?? await (async () => {
    console.time('[timing] detectChanges');
    const cs = await detectChanges(localPath, stores.graph, projectId);
    console.timeEnd('[timing] detectChanges');
    return cs;
  })();

  // 4. If no change data, fall back to full analysis
  if (!changeSet) {
    console.log(`[incremental] No previous analysis found, running full analysis for ${projectId}`);
    await stores.graph.clearProject(projectId);
    const stats = await runAnalyze('', projectId, stores, {
      gitUrl,
      repoCache,
      pipelineRunner: options?.pipelineRunner,
      onProgress: options?.onProgress,
    });
    return { mode: 'full', ...stats, staleWikiEntities: await checkWikiFreshness(projectId, stores) };
  }

  // 5. If no changes detected
  const totalChanges = changeSet.modified.length + changeSet.deleted.length + changeSet.added.length;
  if (totalChanges === 0) {
    console.log(`[incremental] No changes detected for ${projectId}`);
    const staleWikiEntities = await checkWikiFreshness(projectId, stores);
    return {
      mode: 'incremental',
      nodeCount: 0,
      relationCount: 0,
      communityCount: 0,
      processCount: 0,
      changeSet: { modified: 0, deleted: 0, added: 0 },
      staleWikiEntities,
    };
  }

  console.log(`[incremental] Processing ${totalChanges} changed files for ${projectId}`);

  // 5.5. Query reverse dependencies BEFORE deletion (critical: old relationships must still exist)
  // Must include deleted files (e.g. rename: old path A.ts is in deleted, files that import A.ts
  // won't be found if we don't include deleted in the query)
  const changedFilesForDeps = [
    ...changeSet.modified,
    ...changeSet.added,
    ...changeSet.deleted,
  ];
  console.time('[timing] findReverseDependencies');
  const reverseDepResult = await findReverseDependencies(
    changedFilesForDeps, stores, projectId, 2,
  );
  console.timeEnd('[timing] findReverseDependencies');
  console.log(`[incremental] Reverse deps: ${reverseDepResult.reverseDeps.length} files`);

  // P2-7 explosion guard: if filesToReparse > 50% of totalFiles, fall back to full rebuild
  const totalReparse = reverseDepResult.filesToReparse.size;
  if (totalReparse > 0) {
    try {
      const projectRows = await stores.graph.query(
        'MATCH (p:Project {id: $projectId}) RETURN p.totalFiles AS totalFiles',
        { projectId },
      );
      const totalFiles = (projectRows[0]?.totalFiles as number) || 0;
      if (totalFiles > 0 && totalReparse > totalFiles * 0.5) {
        console.log(`[incremental] Explosion guard: ${totalReparse} files to reparse > 50% of ${totalFiles} total. Falling back to full rebuild.`);
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.fallbackCount = COALESCE(p.fallbackCount, 0) + 1,
               p.lastFallbackReason = $reason,
               p.lastFallbackAt = datetime()`,
          { projectId, reason: `explosion_guard: ${totalReparse} > 0.5*${totalFiles}` },
        );
        await stores.graph.clearProject(projectId);
        const stats = await runAnalyze('', projectId, stores, {
          gitUrl, repoCache,
          pipelineRunner: options?.pipelineRunner,
          onProgress: options?.onProgress,
        });
        return { mode: 'full', ...stats, fallbackReason: `explosion_guard: ${totalReparse} > 0.5*${totalFiles}`, staleWikiEntities: await checkWikiFreshness(projectId, stores) };
      }
    } catch (err) {
      console.warn(`[incremental] Explosion guard check failed (non-fatal, proceeding with incremental): ${err instanceof Error ? err.message : err}`);
    }
  }

  // 6. Supersede stale data for modified + deleted + reverse-dependent files
  // P1-T3: Instead of hard DELETE (which destroys history), we SET valid_to
  // on old CODE_RELATION edges. This preserves the bi-temporal history.
  // Nodes themselves are left in place — the pipeline MERGEs (upserts) them.
  const filesToDelete = [
    ...changeSet.modified,
    ...changeSet.deleted,
    ...reverseDepResult.reverseDeps,
  ];
  for (const filePath of filesToDelete) {
    // 6a. Get node IDs first (needed for Qdrant vector deletion)
    let nodeIds: string[] = [];
    try {
      nodeIds = await stores.graph.findNodeIdsByFilePath(projectId, filePath);
      console.log(`[incremental] Found ${nodeIds.length} nodes for ${filePath}`);
    } catch (err) {
      console.warn(`[incremental] Failed to find nodes for ${filePath}: ${err instanceof Error ? err.message : err}`);
    }

    // 6b. P1-T3: Soft-delete CODE_RELATION edges (SET valid_to, not DETACH DELETE)
    // This preserves history: old edges are closed (valid_to = now) and the
    // pipeline will create new edges with valid_from = now.
    try {
      if (nodeIds.length > 0) {
        const now = new Date().toISOString();
        // Close all currently-valid CODE_RELATION edges for these nodes
        await stores.graph.query(
          `MATCH (n) WHERE n.projectId = $projectId AND n.filePath = $filePath
             AND (n:Function OR n:Class OR n:Method OR n:File OR n:Section OR n:Property OR n:CodeElement)
           MATCH (n)-[r:CODE_RELATION]-(m)
           WHERE r.valid_to IS NULL
           SET r.valid_to = $supersedeTime, r.txn_to = $txnTime`,
          { projectId, filePath, supersedeTime: now, txnTime: now },
        );
        console.log(`[incremental] Neo4j: superseded CODE_RELATION edges for ${filePath}`);
      }
    } catch (err) {
      console.warn(`[incremental] Failed to supersede graph edges for ${filePath}: ${err instanceof Error ? err.message : err}`);
    }

    // 6b2. Delete associated Route and Tool nodes (P4: route/tool hybrid cleanup)
    // Route/Tool are metadata nodes — hard delete is appropriate here.
    // Their CODE_RELATION edges were already superseded in 6b above.
    try {
      await stores.graph.query(
        `MATCH (r:Route)-[:HANDLES_ROUTE]-(f:File {filePath: $filePath, projectId: $projectId})
         DETACH DELETE r`,
        { filePath, projectId },
      );
      await stores.graph.query(
        `MATCH (t:Tool)-[:HANDLES_TOOL]-(f:File {filePath: $filePath, projectId: $projectId})
         DETACH DELETE t`,
        { filePath, projectId },
      );
    } catch (err) {
      console.warn(`[incremental] Failed to delete route/tool data for ${filePath}: ${err instanceof Error ? err.message : err}`);
    }

    // 6c. Delete from Typesense (by filePath)
    try {
      const searchDeleted = await stores.search.deleteDocumentsByFilePath(projectId, filePath);
      console.log(`[incremental] Typesense: deleted ${searchDeleted} docs for ${filePath}`);
    } catch (err) {
      console.warn(`[incremental] Failed to delete search data for ${filePath}: ${err instanceof Error ? err.message : err}`);
    }

    // 6d. Delete from Qdrant (by node IDs — uses pre-deletion IDs)
    try {
      if (nodeIds.length > 0) {
        const vectorDeleted = await stores.vector.deleteVectorsByNodeIds(projectId, nodeIds);
        console.log(`[incremental] Qdrant: deleted ${vectorDeleted} vectors for ${filePath}`);
      }
    } catch (err) {
      console.warn(`[incremental] Failed to delete vector data for ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 7. Run pipeline with onlyFiles (P2 incremental mode)
  const effectiveRunner = options?.pipelineRunner || defaultPipelineRunner;
  const pipelineOptions: PipelineOptions = {
    onlyFiles: [...reverseDepResult.filesToReparse],
    externalSymbolStore: stores.graph,
    projectId,
  };
  console.log(`[incremental] Files to reparse: ${reverseDepResult.filesToReparse.size}`);

  let pipelineResult: PipelineResult;
  let fallbackReason: string | undefined;

  // Track incremental attempt count regardless of outcome
  await stores.graph.query(
    `MATCH (p:Project {id: $projectId})
     SET p.totalIncrementalAttempts = COALESCE(p.totalIncrementalAttempts, 0) + 1`,
    { projectId },
  );

  try {
    console.time('[timing] pipeline');
    pipelineResult = await effectiveRunner(localPath, options?.onProgress, pipelineOptions as Record<string, unknown>);
    console.timeEnd('[timing] pipeline');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Use name check instead of instanceof — vitest ESM can create multiple
    // class instances where instanceof fails across module boundaries.
    if (err instanceof IncrementalFallbackError || (err as Error)?.name === 'IncrementalFallbackError') {
      console.warn(`[incremental] Fallback to full: ${errMsg}`);
      fallbackReason = errMsg;
      // Track fallback count, reason, and timestamp
      await stores.graph.query(
        `MATCH (p:Project {id: $projectId})
         SET p.fallbackCount = COALESCE(p.fallbackCount, 0) + 1,
             p.lastFallbackReason = $reason,
             p.lastFallbackAt = datetime()`,
        { projectId, reason: (err as Error).message },
      );
      // Fallback to full rebuild
      await stores.graph.clearProject(projectId);
      const stats = await runAnalyze('', projectId, stores, {
        gitUrl,
        repoCache,
        pipelineRunner: options?.pipelineRunner,
        onProgress: options?.onProgress,
      });
      return { mode: 'full', ...stats, fallbackReason, staleWikiEntities: await checkWikiFreshness(projectId, stores) };
    }
    throw err;
  }

  // 8. Write results to all stores
  const headCommit = repoCache.getHeadCommit(localPath);
  console.time('[timing] writePipelineResultToStores');
  const stats = await writePipelineResultToStores(
    pipelineResult,
    projectId,
    stores,
    gitUrl,
    localPath,
    headCommit,
  );
  console.timeEnd('[timing] writePipelineResultToStores');

  // 9a. Temporal incremental: append new commits since last analysis
  let temporalFreshness = 'stale';
  try {
    console.time('[timing] temporalStep');
    await runTemporalStep(localPath, projectId, stores, options?.onProgress, changeSet.fromCommit);
    console.timeEnd('[timing] temporalStep');
    temporalFreshness = 'partial'; // appended OK, but not a full temporal recalc
    console.log(`[incremental] Temporal: appended commits since ${changeSet.fromCommit}`);
  } catch (err) {
    console.warn(`[incremental] Temporal incremental failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // 9b. Community threshold check: rebuild if enough changes accumulated
  let communityRecalculated = false;
  try {
    const projectInfo = await stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       RETURN p.communitiesFreshness AS cf, p.lastCommunityRebuildAt AS lcra,
              p.accumulatedChanges AS ac, p.totalFiles AS tfCount`,
      { projectId },
    );
    const accumulatedChanges = (projectInfo[0]?.ac as number || 0) + reverseDepResult.filesToReparse.size;
    const daysSinceCommunityRebuild = projectInfo[0]?.lcra
      ? (Date.now() - new Date(projectInfo[0].lcra as string).getTime()) / 86400000
      : Infinity;

    // Ratio-based threshold: max(50, totalFiles * 0.05) — scales with repo size
    const COMMUNITY_CHANGE_MIN = 50;
    const COMMUNITY_CHANGE_RATIO = 0.05;
    const COMMUNITY_STALE_DAYS = 7;
    const totalFiles = (projectInfo[0]?.tfCount as number) || 0;
    const COMMUNITY_CHANGE_THRESHOLD = Math.max(
      COMMUNITY_CHANGE_MIN,
      Math.floor(Math.max(totalFiles, 1) * COMMUNITY_CHANGE_RATIO),
    );

    const shouldRebuild = accumulatedChanges >= COMMUNITY_CHANGE_THRESHOLD || daysSinceCommunityRebuild >= COMMUNITY_STALE_DAYS;

    if (shouldRebuild) {
      console.log(`[incremental] Rebuilding communities (accumulated=${accumulatedChanges}, threshold=${COMMUNITY_CHANGE_THRESHOLD}, days=${daysSinceCommunityRebuild.toFixed(1)})`);
      console.time('[timing] rebuildCommunities');
      await rebuildCommunities(stores, projectId, pipelineResult);
      console.timeEnd('[timing] rebuildCommunities');
      communityRecalculated = true;
    } else {
      // Mark stale and track accumulated changes
      await stores.graph.query(
        `MATCH (p:Project {id: $projectId})
         SET p.communitiesFreshness = 'stale',
             p.accumulatedChanges = $ac`,
        { projectId, ac: accumulatedChanges },
      );
    }
  } catch (err) {
    console.warn(`[incremental] Community check failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    // On error, conservatively mark communities as stale
    await stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       SET p.communitiesFreshness = 'stale'`,
      { projectId },
    );
  }

  // 9c. Update freshness fields + duration
  const incrementalDurationMs = Date.now() - incrementalStartMs;
  await stores.graph.query(
    `MATCH (p:Project {id: $projectId})
     SET p.symbolsFreshness = 'fresh',
         p.communitiesFreshness = CASE
           WHEN $communityRecalculated THEN 'fresh'
           ELSE p.communitiesFreshness
         END,
         p.temporalFreshness = $temporalFreshness,
         p.lastIncrementalAt = datetime(),
         p.consecutiveIncremental = COALESCE(p.consecutiveIncremental, 0) + 1,
         p.lastIncrementalDuration = $duration`,
    { projectId, communityRecalculated, temporalFreshness, duration: incrementalDurationMs },
  );

  console.log(`[incremental] Incremental analysis complete: ${stats.nodeCount} nodes, ${stats.relationCount} relations`);

  const staleWikiEntities = await checkWikiFreshness(projectId, stores);

  return {
    mode: 'incremental',
    ...stats,
    changeSet: {
      modified: changeSet.modified.length,
      deleted: changeSet.deleted.length,
      added: changeSet.added.length,
    },
    staleWikiEntities,
  };
}

/**
 * Check wiki entity freshness for a project (P0c-T6).
 *
 * This is a defensive integration — any error from the freshness check is
 * caught and logged. The function always returns an array (empty on error),
 * never throwing, so the main incremental result is preserved.
 *
 * Uses WikiGraph to list entities and checkEntityFreshness to evaluate each.
 * Only entities with non-fresh status (stale, orphaned, unbound) are included
 * in the returned array.
 *
 * @param projectId - The project to check
 * @param stores - The store set
 * @returns Array of stale wiki entities (empty if no entities or error)
 */
async function checkWikiFreshness(projectId: string, stores: StoreSet): Promise<StaleWikiEntity[]> {
  try {
    const wikiGraph = new WikiGraph(stores.graph);
    const entities = await wikiGraph.listEntities(projectId);

    const staleEntities: StaleWikiEntity[] = [];
    for (const entity of entities) {
      try {
        const result = await checkEntityFreshness(projectId, entity, stores.graph);
        if (result.state !== 'fresh') {
          staleEntities.push({
            entityId: entity.id,
            entityName: entity.name,
            status: result.state,
          });
        }
      } catch {
        // Individual entity check failed — skip it, don't fail the whole check
      }
    }

    if (staleEntities.length > 0) {
      console.log(`[incremental] Wiki freshness: ${staleEntities.length}/${entities.length} entities need attention`);
    }

    return staleEntities;
  } catch (err) {
    // Freshness check is non-fatal — log and return empty array
    console.warn(`[incremental] Wiki freshness check failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// getDefaultPipelineRunner removed — run-analyze.ts's exported defaultPipelineRunner is used directly.
// checkWikiFreshness is the P0c-T6 integration point: after any incremental or full run,
// wiki entity freshness is evaluated and attached to IncrementalResult.
