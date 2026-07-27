/**
 * BullMQ Queue definitions for jelly_code.
 *
 * Three queues:
 * 1. analyze — Code analysis jobs (replaced setImmediate-based background execution)
 * 2. search-sync — Async search index synchronization (TS/QD after Neo4j write)
 * 3. cleanup — Project deletion and stale node cleanup
 *
 * All queues share the same Redis connection (reuse Jelly ecosystem Redis 6380).
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from './redis-connection.js';

const connection = getRedisConnection();

/**
 * Analysis queue: processes code analysis jobs.
 * - Timeout: 10 min (default), configurable via ANALYZE_TIMEOUT_MS env
 * - Retries: 3 attempts with exponential backoff (5s base)
 * - Concurrency: controlled by Worker concurrency setting
 */
export const analyzeQueue = new Queue('analyze', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },  // Keep completed jobs for 24h
    removeOnFail: { age: 3600 * 48 },       // Keep failed jobs for 48h
  },
});

/**
 * Search sync queue: async Typesense/Qdrant index synchronization.
 * - Timeout: 5 min
 * - Retries: 2 attempts
 */
export const searchSyncQueue = new Queue('search-sync', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
    removeOnComplete: { age: 3600 * 12 },
    removeOnFail: { age: 3600 * 24 },
  },
});

/**
 * Cleanup queue: project deletion and stale node cleanup.
 * - Timeout: 10 min
 * - Retries: 3 attempts with exponential backoff
 */
export const cleanupQueue = new Queue('cleanup', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 48 },
  },
});

/**
 * Gracefully close all queues.
 * Should be called during shutdown.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    analyzeQueue.close(),
    searchSyncQueue.close(),
    cleanupQueue.close(),
  ]);
}

// === v1.4.0 Resilience Layer: LLM / Embedding async queues ===

export interface DerivationJobData {
  projectId: string;
  nodes: string[];  // node IDs, batch of 10
}

export interface EnrichmentJobData {
  projectId: string;
  communityIds: string[];  // batch of 5
}

export interface EmbeddingBatchJobData {
  projectId: string;
  nodeIds: string[];  // batch of 16
}

const resilienceJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 100,
  removeOnFail: 1000,
};

export const llmDerivationQueue = new Queue<DerivationJobData>('llm-derivation', {
  connection,
  defaultJobOptions: resilienceJobOptions,
});

export const llmEnrichmentQueue = new Queue<EnrichmentJobData>('llm-enrichment', {
  connection,
  defaultJobOptions: resilienceJobOptions,
});

export const embeddingBatchQueue = new Queue<EmbeddingBatchJobData>('embedding-batch', {
  connection,
  defaultJobOptions: resilienceJobOptions,
});

/**
 * Gracefully close the resilience-layer queues.
 * Should be called during shutdown.
 */
export async function closeResilienceQueues(): Promise<void> {
  await Promise.allSettled([
    llmDerivationQueue.close(),
    llmEnrichmentQueue.close(),
    embeddingBatchQueue.close(),
  ]);
}
