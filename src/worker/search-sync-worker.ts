/**
 * BullMQ Worker for asynchronous search index synchronization.
 *
 * After a full analysis completes (Neo4j is up to date), this worker
 * asynchronously syncs the search indices (Typesense) and vector store (Qdrant).
 *
 * Design:
 * - Neo4j write = analysis complete (primary data store)
 * - Typesense/Qdrant sync = optional (secondary indices, can lag behind)
 * - Search queries check freshness and return degradation hints if stale
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../core/redis-connection.js';
import { createStoreSet } from '../store/factory.js';
import { logger } from '../core/logger.js';

export interface SearchSyncJobData {
  projectId: string;
}

/**
 * Create and configure the search-sync worker.
 */
export function createSearchSyncWorker(
  stores: ReturnType<typeof createStoreSet>,
): Worker {
  const worker = new Worker<SearchSyncJobData>(
    'search-sync',
    async (job) => {
      const { projectId } = job.data;
      logger.info({ projectId, jobId: job.id }, 'Search-sync: starting');

      // Get all nodes from Neo4j for this project
      const nodeResult = await stores.graph.query(
        `MATCH (n {projectId: $projectId})
         WHERE n.stale IS NULL OR n.stale = false
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                n.type AS type, labels(n)[0] AS label
         LIMIT 100000`,
        { projectId },
      );

      const nodes = nodeResult as Array<Record<string, unknown>>;

      // Typesense sync: index searchable documents
      // Cast to SearchDocument[] — the Neo4j result has the required fields
      const searchableDocs = nodes.filter(n => n.name && n.filePath) as unknown as import('../store/interfaces.js').SearchDocument[];
      if (searchableDocs.length > 0) {
        try {
          await stores.search.indexDocuments(projectId, searchableDocs);
          logger.info({ projectId, count: searchableDocs.length },
            'Search-sync: Typesense indexed');
        } catch (e) {
          logger.warn({
            projectId,
            error: e instanceof Error ? e.message : String(e),
          }, 'Search-sync: Typesense index failed (non-fatal)');
        }
      }

      // Qdrant sync: index vectors for embeddable nodes
      const embeddableNodes = nodes.filter(n => n.name);
      if (embeddableNodes.length > 0) {
        try {
          const { EmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
          const pipeline = new EmbeddingPipeline(stores.vector);
          await pipeline.indexEmbeddings(projectId, embeddableNodes as Array<{
            id: string;
            name: string;
            content?: string;
            description?: string;
            type: string;
            filePath: string;
          }>);
          logger.info({ projectId, count: embeddableNodes.length },
            'Search-sync: Qdrant indexed');
        } catch (e) {
          logger.warn({
            projectId,
            error: e instanceof Error ? e.message : String(e),
          }, 'Search-sync: Qdrant index failed (non-fatal)');
        }
      }

      // Record sync timestamp in Redis
      try {
        const redis = getRedisConnection();
        await redis.set(`search-sync:${projectId}:lastSync`, Date.now().toString());
        await redis.expire(`search-sync:${projectId}:lastSync`, 86400); // 24h TTL
      } catch {
        // Redis not available — non-fatal
      }

      logger.info({ projectId, indexedCount: searchableDocs.length },
        'Search-sync: completed');
    },
    {
      connection: getRedisConnection(),
      concurrency: parseInt(process.env.SEARCH_SYNC_CONCURRENCY || '2', 10),
      autorun: true,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, projectId: job.data.projectId },
      'Search-sync job completed');
  });

  worker.on('failed', (job, error) => {
    if (job) {
      logger.warn({
        jobId: job.id,
        projectId: job.data.projectId,
        error: error.message,
      }, 'Search-sync job failed (non-fatal)');
    }
  });

  return worker;
}

// ========================================
// Standalone entry point
// ========================================

async function main(): Promise<void> {
  logger.info('Starting search-sync worker in standalone mode');
  const { loadConfig } = await import('../config/index.js');
  const config = loadConfig();
  const stores = await createStoreSet(config);
  const worker = createSearchSyncWorker(stores);

  const shutdown = async () => {
    logger.info('Shutting down search-sync worker...');
    await worker.close();
    process.exitCode = 0;
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Search-sync worker ready');
}

const isMainModule = process.argv[1]?.endsWith('search-sync-worker.js') ||
  process.argv[1]?.endsWith('search-sync-worker.ts');
if (isMainModule) {
  main().catch((err) => {
    logger.error({ error: err instanceof Error ? err.message : String(err) },
      'Search-sync worker startup failed');
    process.exitCode = 1;
  });
}
