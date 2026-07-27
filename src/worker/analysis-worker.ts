/**
 * BullMQ Worker for code analysis.
 *
 * Processes 'analyze' queue jobs — runs the full or incremental analysis pipeline.
 * Designed to run as a standalone process: `node dist/worker/analysis-worker.js`
 *
 * Design decisions:
 * - Tree-sitter WASM (~15MB) is loaded once at worker start, not per-job
 * - Job timeout is set at queue level (10 min default, env override)
 * - EMPTY_RESULT and incremental fallback errors are thrown to BullMQ for retry
 * - On completion, triggers search-sync queue for async TS/QD indexing
 * - TaskManager is updated via events (markAnalyzing/markReady/markError)
 * - The worker has its own TaskManager instance for standalone mode
 * - When running as part of the server (server/index.ts), the worker uses
 *   the server's TaskManager via the stores and callback mechanism
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../core/redis-connection.js';
import { searchSyncQueue } from '../core/queue-setup.js';
import { runAnalyze } from '../core/run-analyze.js';
import type { WikiService } from '../wiki/service.js';
import type { AnalysisLevel } from '../prediction/types.js';
import { runIncrementalAnalyze } from '../core/run-incremental.js';
import { createStoreSet } from '../store/factory.js';
import { createTaskManager } from '../task/index.js';
import { RepoCacheManager } from '../core/repo-cache.js';
import { logger } from '../core/logger.js';

export interface AnalysisJobData {
  projectId: string;
  gitUrl?: string;
  repoPath?: string;
  forceLevel?: string;
  /** If true, auto-switch to incremental if lastCommit exists */
  canAutoIncremental?: boolean;
  /** Last known commit for auto-incremental detection */
  storedLastCommit?: string;
}

export interface AnalysisJobResult {
  nodeCount: number;
  relationCount: number;
  communityCount: number;
  processCount: number;
  mode: 'full' | 'incremental' | 'l0';
}

/**
 * Create and configure the analysis worker.
 */
export function createAnalysisWorker(
  stores: ReturnType<typeof createStoreSet>,
  repoCache?: RepoCacheManager,
  taskManager?: ReturnType<typeof createTaskManager>,
  wikiService?: WikiService,
): Worker {
  const worker = new Worker<AnalysisJobData, AnalysisJobResult>(
    'analyze',
    async (job) => {
      const { projectId, gitUrl, repoPath, canAutoIncremental, storedLastCommit } = job.data;
      const effectiveRepoPath = repoPath || '';

      logger.info({ projectId, jobId: job.id }, 'Worker starting analysis');

      // Update TaskManager (if available)
      if (taskManager) {
        taskManager.markAnalyzing(projectId);
      }

      // Update progress to 0%
      await job.updateProgress(0);

      try {
        // Auto-incremental path
        if (canAutoIncremental && storedLastCommit && repoCache) {
          logger.info({ projectId, lastCommit: storedLastCommit }, 'Auto-switching to incremental');
          if (taskManager) {
            taskManager.updateProgress(projectId, { phase: 'incremental', percent: 0 });
          }
          await job.updateProgress(10);

          const incResult = await runIncrementalAnalyze(projectId, stores, repoCache, {
            onProgress: (phase, percent) => {
              if (taskManager) {
                taskManager.updateProgress(projectId, { phase, percent });
              }
            },
          });

          await job.updateProgress(90);

          // Mark TaskManager as ready
          if (taskManager) {
            taskManager.markReady(projectId);
          }

          logger.info({
            projectId,
            mode: incResult.mode,
            nodeCount: incResult.nodeCount,
            changeSet: incResult.changeSet,
          }, 'Incremental analysis completed');

          // Trigger search-sync
          await searchSyncQueue.add('sync', { projectId });

          await job.updateProgress(100);
          return {
            nodeCount: incResult.nodeCount,
            relationCount: incResult.relationCount,
            communityCount: incResult.communityCount,
            processCount: incResult.processCount,
            mode: incResult.mode,
          };
        }

        // Full analysis path
        logger.info({ projectId }, 'Running full analysis');

        // Determine analysis level
        let cachedFileCount: number | undefined;
        if (!job.data.forceLevel) {
          try {
            const proj = await stores.graph.query(
              'MATCH (p:Project {id: $id}) RETURN p.totalFiles AS totalFiles',
              { id: projectId },
            );
            if (proj[0]?.totalFiles !== undefined && proj[0]?.totalFiles !== null) {
              cachedFileCount = Number(proj[0].totalFiles);
            }
          } catch { /* project might not exist yet */ }
        }

        const { determineAnalysisLevel } = await import('../prediction/level-strategy.js');
        const { AnalysisLevel } = await import('../prediction/types.js');
        const { analyzeLevel0 } = await import('../prediction/level0-analyzer.js');

        const forceLevel = job.data.forceLevel as string | undefined;
        const levelDecision = await determineAnalysisLevel(
          effectiveRepoPath,
          {
            forceLevel: forceLevel as unknown as AnalysisLevel | undefined,
            cachedFileCount,
          },
        );

        logger.info({ projectId, level: levelDecision.level, reason: levelDecision.reason },
          'Level decision');

        await job.updateProgress(20);

        if (levelDecision.level === AnalysisLevel.L0_GIT_LOG) {
          // L0: lightweight git-log-only analysis
          logger.info({ projectId }, 'Running L0 analysis');
          const stats = await analyzeLevel0(effectiveRepoPath, projectId, stores);

          if (taskManager) {
            taskManager.markReady(projectId);
          }

          logger.info({
            projectId,
            commitCount: stats.commitCount,
            fileCount: stats.fileCount,
            couplingPairs: stats.couplingPairs,
          }, 'L0 analysis completed');

          await job.updateProgress(100);
          return {
            nodeCount: stats.fileCount,
            relationCount: stats.couplingPairs,
            communityCount: 0,
            processCount: 0,
            mode: 'l0',
          };
        }

        // L2: full AST + git + embeddings
        const stats = await runAnalyze(
          effectiveRepoPath,
          projectId,
          stores,
          {
            gitUrl: gitUrl || undefined,
            repoCache,
            // v1.3.0 Phase 3 T3-4: pass wikiService for auto-derivation
            wikiService,
            onProgress: (phase: string, percent: number) => {
              if (taskManager) {
                taskManager.updateProgress(projectId, { phase, percent });
              }
              job.updateProgress(Math.min(Math.round(percent / 2) + 20, 90));
            },
          },
        );

        // Mark TaskManager as ready
        if (taskManager) {
          taskManager.markReady(projectId);
        }

        logger.info({
          projectId,
          nodeCount: stats.nodeCount,
          relationCount: stats.relationCount,
        }, 'Full analysis completed');

        // Trigger search-sync (async TS/QD indexing)
        await searchSyncQueue.add('sync', { projectId });

        await job.updateProgress(100);

        return {
          nodeCount: stats.nodeCount,
          relationCount: stats.relationCount,
          communityCount: stats.communityCount,
          processCount: stats.processCount,
          mode: 'full',
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);

        // Update TaskManager on failure
        if (taskManager) {
          taskManager.markError(projectId, msg);
        }

        logger.error({ projectId, error: msg }, 'Worker analysis FAILED');

        // Re-throw so BullMQ handles retry/DLQ
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: parseInt(process.env.WORKER_CONCURRENCY || '3', 10),
      limiter: {
        max: parseInt(process.env.WORKER_MAX_PER_MIN || '10', 10),
        duration: 60_000,
      },
      autorun: true,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, projectId: job.data.projectId, returnValue: job.returnvalue },
      'Worker job completed');
  });

  worker.on('failed', (job, error) => {
    if (job) {
      logger.error({
        jobId: job.id,
        projectId: job.data.projectId,
        error: error.message,
        attemptsMade: job.attemptsMade,
      }, 'Worker job failed');
    } else {
      logger.error({ error: error.message }, 'Worker job failed (no job context)');
    }
  });

  worker.on('error', (error) => {
    logger.error({ error: error.message }, 'Worker error');
  });

  worker.on('active', (job) => {
    logger.info({ jobId: job.id, projectId: job.data.projectId }, 'Worker job active');
  });

  return worker;
}

// ========================================
// Standalone entry point
// ========================================

/**
 * When run directly as `node dist/worker/analysis-worker.js`, starts the worker
 * in standalone mode with its own stores and TaskManager.
 */
async function main(): Promise<void> {
  logger.info('Starting analysis worker in standalone mode');

  const { loadConfig } = await import('../config/index.js');
  const config = loadConfig();
  const stores = await createStoreSet(config);
  const taskManager = createTaskManager();
  const repoCache = new RepoCacheManager({ cacheDir: '/tmp/jelly-repo-cache', fullClone: false, cloneTimeout: 120000, fetchTimeout: 60000 });

  const worker = createAnalysisWorker(stores, repoCache, taskManager);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down analysis worker...');
    await worker.close();
    process.exitCode = 0;
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Analysis worker ready');
}

// Only run main if this is the entry point (not imported)
const isMainModule = process.argv[1]?.endsWith('analysis-worker.js') ||
  process.argv[1]?.endsWith('analysis-worker.ts');
if (isMainModule) {
  main().catch((err) => {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Worker startup failed');
    // Use process.exitCode instead of process.exit to avoid vitest interception
    process.exitCode = 1;
  });
}
