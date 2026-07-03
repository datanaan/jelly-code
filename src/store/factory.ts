import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from './interfaces.js';
import { Neo4jAdapter } from './neo4j/adapter.js';
import { TypesenseAdapter } from './typesense/adapter.js';
import { QdrantAdapter } from './qdrant/adapter.js';
import { OllamaAdapter } from '../llm/ollama.js';
import { OpenAIAdapter } from '../llm/openai.js';
import { FallbackLLMClient } from '../llm/fallback.js';
import type { ILLMClient } from '../llm/interface.js';
import type { AppConfig } from '../config/index.js';

/**
 * Create a StoreSet based on the application configuration.
 * LLM: primary (cloud API) → fallback (local Ollama)
 */
export function createStoreSet(config: AppConfig): StoreSet {
  let llm: ILLMClient;

  if (config.llmPrimary) {
    const primary = new OpenAIAdapter(config.llmPrimary);
    const fallback = new OllamaAdapter(config.llm);
    llm = new FallbackLLMClient(primary, fallback);
    console.log('[factory] LLM: primary=', config.llmPrimary.model, 'fallback=', config.llm.model);
  } else {
    llm = new OllamaAdapter(config.llm);
    console.log('[factory] LLM: ollama-only, model=', config.llm.model);
  }

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
