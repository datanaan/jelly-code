/**
 * BullMQ Worker for project deletion and stale node cleanup.
 *
 * Handles two types of cleanup jobs:
 * 1. 'cleanup' — Full project deletion (Neo4j + Typesense + Qdrant)
 * 2. 'stale-cleanup' — Delete stale nodes from Neo4j (incremental stale markers)
 *
 * Runs asynchronously so the API can return immediately.
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../core/redis-connection.js';
import { createStoreSet } from '../store/factory.js';
import { logger } from '../core/logger.js';

export interface CleanupJobData {
  projectId: string;
  /** For stale-cleanup: node IDs to delete */
  ids?: string[];
}

export interface StaleCleanupJobData {
  projectId: string;
  ids: string[];
}

/**
 * Create and configure the cleanup worker.
 */
export function createCleanupWorker(
  stores: ReturnType<typeof createStoreSet>,
): Worker {
  const worker = new Worker<CleanupJobData>(
    'cleanup',
    async (job) => {
      const { projectId, ids } = job.data;

      if (ids && ids.length > 0) {
        // Stale cleanup: delete specific stale nodes
        logger.info({ projectId, count: ids.length }, 'Cleanup: deleting stale nodes');

        try {
          await stores.graph.query(
            `MATCH (n {projectId: $projectId})
             WHERE n.id IN $ids AND n.stale = true
             DETACH DELETE n`,
            { projectId, ids },
          );
          logger.info({ projectId, count: ids.length }, 'Cleanup: stale nodes deleted');
        } catch (e) {
          logger.error({
            projectId,
            error: e instanceof Error ? e.message : String(e),
          }, 'Cleanup: stale node deletion failed');
          throw e;  // BullMQ will retry
        }
      } else {
        // Full project deletion
        logger.info({ projectId }, 'Cleanup: starting full project deletion');

        // Neo4j: delete all project nodes
        try {
          await stores.graph.query(
            'MATCH (n {projectId: $projectId}) DETACH DELETE n',
            { projectId },
          );
          logger.info({ projectId }, 'Cleanup: Neo4j data deleted');
        } catch (e) {
          logger.error({
            projectId,
            error: e instanceof Error ? e.message : String(e),
          }, 'Cleanup: Neo4j deletion failed');
          throw e;  // BullMQ will retry
        }

        // Typesense: delete collection
        try {
          await stores.search.deleteCollection(projectId);
          logger.info({ projectId }, 'Cleanup: Typesense collection deleted');
        } catch (e) {
          logger.warn({
            projectId,
            error: e instanceof Error ? e.message : String(e),
          }, 'Cleanup: Typesense deletion failed (non-fatal)');
        }

        // Qdrant: delete collection or points
        try {
          await stores.vector.deleteCollection(projectId);
          logger.info({ projectId }, 'Cleanup: Qdrant collection deleted');
        } catch (e) {
          logger.warn({
            projectId,
            error: e instanceof Error ? e.message : String(e),
          }, 'Cleanup: Qdrant deletion failed (non-fatal)');
        }

        logger.info({ projectId }, 'Cleanup: full project deletion completed');
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,  // Serialize cleanup to avoid conflicts
      autorun: true,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, projectId: job.data.projectId },
      'Cleanup job completed');
  });

  worker.on('failed', (job, error) => {
    if (job) {
      logger.error({
        jobId: job.id,
        projectId: job.data.projectId,
        error: error.message,
        attemptsMade: job.attemptsMade,
      }, 'Cleanup job failed');
    }
  });

  return worker;
}

// ========================================
// Standalone entry point
// ========================================

async function main(): Promise<void> {
  logger.info('Starting cleanup worker in standalone mode');
  const { loadConfig } = await import('../config/index.js');
  const config = loadConfig();
  const stores = await createStoreSet(config);
  const worker = createCleanupWorker(stores);

  const shutdown = async () => {
    logger.info('Shutting down cleanup worker...');
    await worker.close();
    process.exitCode = 0;
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Cleanup worker ready');
}

const isMainModule = process.argv[1]?.endsWith('cleanup-worker.js') ||
  process.argv[1]?.endsWith('cleanup-worker.ts');
if (isMainModule) {
  main().catch((err) => {
    logger.error({ error: err instanceof Error ? err.message : String(err) },
      'Cleanup worker startup failed');
    process.exitCode = 1;
  });
}
