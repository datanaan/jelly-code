/**
 * Centralized Embedding configuration (eliminates 4 scattered hardcoded constants).
 */
export interface EmbeddingServiceConfig {
  /** 'local' for transformers.js; 'http-pool' for multi-endpoint pool */
  mode: 'local' | 'http-pool';
  /** HTTP pool endpoints (mode='http-pool' only) */
  endpoints: Array<{
    url: string;
    model: string;
    apiKey?: string;
    apiKeyEnv?: string;
    apiKeyFile?: string;
    headers?: Record<string, string>;
    role?: 'primary' | 'peer' | 'fallback';
    weight?: number;
  }>;
  strategy: 'priority' | 'round-robin' | 'weighted-random' | 'least-connections';
  dimensions: number;
  /** Batch size for embed() splitting (default 16) */
  batchSize: number;
  resilience: {
    maxConcurrency: number;
    timeoutMs: number;
    retryAttempts: number;
    retryBackoffMs: number;
    circuitFailureThreshold: number;
    circuitResetMs: number;
  };
  /** Local mode only */
  localModel?: string;
  device?: 'auto' | 'cuda' | 'cpu' | 'wasm';
}

export function loadEmbeddingServiceConfig(): EmbeddingServiceConfig {
  const urls = process.env.CODE_EMBEDDING_URLS || process.env.CODE_EMBEDDING_URL;
  const model = process.env.CODE_EMBEDDING_MODEL || '';
  const dims = parseInt(process.env.CODE_EMBEDDING_DIMS || '384', 10);

  if (!urls) {
    return {
      mode: 'local',
      endpoints: [],
      strategy: 'priority',
      dimensions: dims,
      batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || '16', 10),
      resilience: { maxConcurrency: 4, timeoutMs: 30000, retryAttempts: 2, retryBackoffMs: parseInt(process.env.CODE_EMBEDDING_RETRY_BACKOFF_MS || '1000'), circuitFailureThreshold: 5, circuitResetMs: parseInt(process.env.CODE_EMBEDDING_CIRCUIT_RESET_MS || '30000') },
      localModel: process.env.CODE_EMBEDDING_LOCAL_MODEL || 'Snowflake/snowflake-arctic-embed-xs',
      device: (process.env.CODE_EMBEDDING_DEVICE as any) || 'auto',
    };
  }

  const urlList = urls.split(',').map(u => u.trim()).filter(Boolean);
  return {
    mode: 'http-pool',
    endpoints: urlList.map((url, i) => ({
      url,
      model,
      apiKey: process.env.CODE_EMBEDDING_API_KEY,
      role: i === 0 ? 'primary' : 'peer',
    })),
    strategy: (process.env.CODE_EMBEDDING_LOAD_BALANCE as any) || 'least-connections',
    dimensions: dims,
    batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || '16', 10),
    resilience: {
      maxConcurrency: parseInt(process.env.CODE_EMBEDDING_MAX_CONCURRENCY || '16'),
      timeoutMs: parseInt(process.env.CODE_EMBEDDING_TIMEOUT_MS || '30000'),
      retryAttempts: parseInt(process.env.CODE_EMBEDDING_RETRY_ATTEMPTS || '2'),
      retryBackoffMs: parseInt(process.env.CODE_EMBEDDING_RETRY_BACKOFF_MS || '1000'),
      circuitFailureThreshold: parseInt(process.env.CODE_EMBEDDING_CIRCUIT_FAILURE_THRESHOLD || '5'),
      circuitResetMs: parseInt(process.env.CODE_EMBEDDING_CIRCUIT_RESET_MS || '30000'),
    },
  };
}
