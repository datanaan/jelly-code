/**
 * Prometheus Metrics for jelly_code.
 *
 * Three core metrics:
 * 1. jelly_code_analysis_duration_seconds — Histogram of analysis durations
 * 2. jelly_code_analysis_results_total — Counter of analysis results by status
 * 3. jelly_code_backend_operation_duration_seconds — Histogram of backend ops
 *
 * Exposed via Express GET /metrics endpoint.
 */

import client from 'prom-client';

// Register default Node.js metrics (CPU, memory, event loop lag)
client.collectDefaultMetrics({
  prefix: 'jelly_code_',
  labels: { service: 'jelly-code' },
});

// ========================================
// Analysis duration histogram
// ========================================
export const analysisDurationHistogram = new client.Histogram({
  name: 'jelly_code_analysis_duration_seconds',
  help: 'Time spent analyzing a repository',
  labelNames: ['project_id', 'mode', 'language_count'] as const,
  buckets: [30, 60, 120, 300, 600, 1800, 3600],  // 30s to 1h
});

// ========================================
// Analysis results counter
// ========================================
export const analysisResultsCounter = new client.Counter({
  name: 'jelly_code_analysis_results_total',
  help: 'Count of analysis results by status',
  labelNames: ['status'] as const,  // success, empty, failed, timeout
});

// ========================================
// Backend operation duration histogram
// ========================================
export const backendDurationHistogram = new client.Histogram({
  name: 'jelly_code_backend_operation_duration_seconds',
  help: 'Time spent on backend operations',
  labelNames: ['backend', 'operation'] as const,  // neo4j/ts/qd × merge/upsert/search
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
});

// ========================================
// v1.4.0 Resilience metrics
// ========================================
export const llmPoolRequestsTotal = new client.Counter({
  name: 'jelly_llm_pool_requests_total',
  help: 'Total LLM pool requests',
  labelNames: ['node', 'outcome'],
});
export const llmPoolConcurrent = new client.Gauge({
  name: 'jelly_llm_pool_concurrent',
  help: 'Current in-flight LLM requests per endpoint',
  labelNames: ['node'],
});
export const llmPoolLatencySeconds = new client.Histogram({
  name: 'jelly_llm_pool_latency_seconds',
  help: 'LLM call latency',
  labelNames: ['node'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
});
export const llmPoolCircuitState = new client.Gauge({
  name: 'jelly_llm_pool_circuit_state',
  help: '0=closed, 1=open, 2=half-open',
  labelNames: ['node'],
});
export const llmPoolTokensTotal = new client.Counter({
  name: 'jelly_llm_pool_tokens_total',
  help: 'Tokens used',
  labelNames: ['node', 'direction'],
});
export const embeddingPoolRequestsTotal = new client.Counter({
  name: 'jelly_embedding_pool_requests_total',
  help: 'Total embedding pool requests',
  labelNames: ['node', 'outcome'],
});
export const queueJobsTotal = new client.Gauge({
  name: 'jelly_queue_jobs_total',
  help: 'Job counts per queue',
  labelNames: ['queue', 'state'],
});

// ========================================
// Expose metrics endpoint handler
// ========================================
import type { Request, Response } from 'express';

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', client.register.contentType);
  const metrics = await client.register.metrics();
  res.end(metrics);
}
