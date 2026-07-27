/**
 * Health endpoints for the resilience layer (v1.4.0).
 *
 * Exposes operational visibility into LLM pool, embedding pool,
 * BullMQ queues, and overall readiness.
 *
 * All endpoints are public (no auth) so k8s/docker probes can reach them.
 */
import { Router, type Request, type Response } from 'express';
import type { LLMService } from '../llm/llm-service.js';
import type { EmbeddingService } from '../core/embeddings/embedding-service.js';
import { isEmbedderReady, getEmbeddingService } from '../core/embeddings/embedder.js';
import { llmDerivationQueue, llmEnrichmentQueue, embeddingBatchQueue } from '../core/queue-setup.js';
import { isHttpMode } from '../core/embeddings/http-client.js';

export interface HealthRouterOptions {
  llmService?: LLMService;
  embeddingService?: EmbeddingService;
}

export function createHealthRouter(opts: HealthRouterOptions): Router {
  const router = Router();

  // --- /health/llm ---
  router.get('/health/llm', (_req: Request, res: Response) => {
    if (!opts.llmService) {
      return res.json({ status: 'not-configured' });
    }
    res.json({
      status: 'ok',
      stats: opts.llmService.getStats(),
      usage: Array.from(opts.llmService.getUsageStats().entries()),
    });
  });

  // --- /health/embedding ---
  router.get('/health/embedding', (_req: Request, res: Response) => {
    if (opts.embeddingService) {
      return res.json({ status: 'ok', mode: 'http-pool', stats: opts.embeddingService.getStats() });
    }
    // Try to get the global pool service (http-pool mode started elsewhere)
    const poolSvc = getEmbeddingService();
    if (poolSvc) {
      return res.json({ status: 'ok', mode: 'http-pool', stats: poolSvc.getStats() });
    }
    res.json({
      status: 'ok',
      mode: isHttpMode() ? 'http-legacy' : 'local',
      ready: isEmbedderReady(),
    });
  });

  // --- /health/queues ---
  router.get('/health/queues', async (_req: Request, res: Response) => {
    try {
      const [derivation, enrichment, embedding] = await Promise.all([
        llmDerivationQueue.getJobCounts(),
        llmEnrichmentQueue.getJobCounts(),
        embeddingBatchQueue.getJobCounts(),
      ]);
      res.json({ derivation, enrichment, embedding });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- /readyz ---
  router.get('/readyz', async (_req: Request, res: Response) => {
    // Ready if at least one LLM endpoint circuit != 'open' AND embedder ready
    if (opts.llmService) {
      const stats = opts.llmService.getStats();
      const allOpen = stats.endpoints.length > 0 && stats.endpoints.every(e => e.circuitState === 'open');
      if (allOpen) {
        return res.status(503).json({ status: 'not-ready', reason: 'all-llm-circuits-open' });
      }
    }
    if (!isEmbedderReady() && !opts.embeddingService?.isReady()) {
      return res.status(503).json({ status: 'not-ready', reason: 'embedder-not-initialized' });
    }
    res.json({ status: 'ready' });
  });

  return router;
}
