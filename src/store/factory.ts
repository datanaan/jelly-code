import type { StoreSet } from './interfaces.js';
import { Neo4jAdapter } from './neo4j/adapter.js';
import { TypesenseAdapter } from './typesense/adapter.js';
import { QdrantAdapter } from './qdrant/adapter.js';
import { LLMService } from '../llm/llm-service.js';
import type { ILLMClient } from '../llm/interface.js';
import type { AppConfig } from '../config/index.js';
import { validateRemoteServiceConfig } from '../core/resilience/index.js';
import { logger } from '../core/logger.js';

/**
 * Create a StoreSet based on the application configuration.
 * v1.4.0: LLM via LLMService (RemoteService + cockatiel + p-limit + undici)
 */
export function createStoreSet(config: AppConfig): StoreSet {
  const llmConfig = {
    name: 'llm' as const,
    endpoints: (config.llmPool?.endpoints ?? [{ url: config.llm.baseUrl, model: config.llm.model }]) as any,
    strategy: config.llmPool?.strategy ?? 'priority',
    resilience: config.llmPool?.resilience ?? {
      maxConcurrency: 4, timeoutMs: 60000, retryAttempts: 2, retryBackoffMs: 1000,
      circuitFailureThreshold: 5, circuitResetMs: 30000,
    },
  };
  const errors = validateRemoteServiceConfig(llmConfig);
  if (errors.length > 0) {
    throw new Error(`LLM config invalid: ${errors.join('; ')}`);
  }
  const llm: ILLMClient = new LLMService(llmConfig);
  logger.info({ strategy: llmConfig.strategy, endpointCount: llmConfig.endpoints.length }, '[factory] LLM pool initialized');

  return {
    graph: new Neo4jAdapter(config.neo4j),
    search: new TypesenseAdapter(config.typesense),
    vector: new QdrantAdapter(config.qdrant),
    llm,
    async close(): Promise<void> {
      await Promise.allSettled([
        this.graph.close(),
        this.search.close(),
        this.vector.close(),
      ]);
    },
  };
}
