/**
 * Resilience layer shared types.
 * Used by both LLM and Embedding services.
 */

export interface EndpointCredential {
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  headers?: Record<string, string>;
}

export type EndpointRole = 'primary' | 'peer' | 'fallback';

export interface RemoteEndpoint extends EndpointCredential {
  /** Base URL, e.g. http://localhost:11434 */
  url: string;
  /** Model identifier */
  model: string;
  /** Role in pool (priority strategy uses this) */
  role?: EndpointRole;
  /** Weight for weighted-random strategy (default 1) */
  weight?: number;
  /** Per-endpoint override of pool resilience config */
  resilience?: Partial<ResilienceConfig>;
}

export type LoadBalanceStrategy =
  | 'priority'
  | 'round-robin'
  | 'weighted-random'
  | 'least-connections';

export interface ResilienceConfig {
  /** Max concurrent in-flight requests (p-limit) */
  maxConcurrency: number;
  /** Per-request timeout (cockatiel) */
  timeoutMs: number;
  /** Retry attempts (cockatiel) */
  retryAttempts: number;
  /** Exponential backoff initial (cockatiel) */
  retryBackoffMs: number;
  /** Consecutive failures before opening circuit (cockatiel) */
  circuitFailureThreshold: number;
  /** Half-open probe interval (cockatiel) */
  circuitResetMs: number;
}

export interface RemoteServiceConfig {
  /** Service label for logs/metrics, e.g. 'llm' or 'embedding' */
  name: string;
  endpoints: RemoteEndpoint[];
  strategy: LoadBalanceStrategy;
  resilience: ResilienceConfig;
}

export interface EndpointStats {
  url: string;
  role?: EndpointRole;
  circuitState: 'closed' | 'open' | 'half-open';
  concurrent: number;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  lastError?: string;
}

export interface RemoteServiceStats {
  name: string;
  strategy: LoadBalanceStrategy;
  endpoints: EndpointStats[];
}
