/**
 * RemoteService: unified governance for slow remote services.
 *
 * Composes:
 *   - cockatiel (retry / timeout / circuit-breaker) per endpoint
 *   - p-limit (concurrency cap) per pool
 *   - EndpointSelector (load balance strategy)
 *
 * Two call modes:
 *   - call({ endpoint, execute }): direct call to a specific endpoint
 *   - callPool(execute): pool picks endpoint via strategy, fails over on circuit open
 */
import pLimit from 'p-limit';
import {
  retry,
  handleAll,
  handleWhen,
  TimeoutStrategy,
  ConsecutiveBreaker,
  ExponentialBackoff,
  timeout,
  circuitBreaker,
  wrap,
  isBrokenCircuitError,
  CircuitState,
  type CircuitBreakerPolicy,
  type IPolicy,
  type IDefaultPolicyContext,
} from 'cockatiel';
import type { RemoteEndpoint, RemoteServiceConfig, RemoteServiceStats, EndpointStats } from './types.js';
import { EndpointSelector, type EndpointState } from './endpoint-selector.js';
import { safeUrl } from './credential-loader.js';

interface ResilienceInternal {
  policy: IPolicy<IDefaultPolicyContext, unknown>;
  breaker: CircuitBreakerPolicy;
}

interface CallArgs<T> {
  endpoint: RemoteEndpoint;
  execute: (signal: AbortSignal | undefined) => Promise<T>;
}

export class RemoteService {
  private limit: ReturnType<typeof pLimit>;
  private selector: EndpointSelector;
  private states = new Map<string, EndpointState>();
  private stats = new Map<string, {
    totalCalls: number;
    successCount: number;
    failureCount: number;
    lastError?: string;
  }>();
  private resiliencePerEndpoint = new Map<string, ResilienceInternal>();

  constructor(private config: RemoteServiceConfig) {
    this.limit = pLimit(config.resilience.maxConcurrency);
    this.selector = new EndpointSelector(config.endpoints, config.strategy);
    for (const ep of config.endpoints) {
      this.states.set(ep.url, { circuitState: 'closed', concurrent: 0 });
      this.stats.set(ep.url, { totalCalls: 0, successCount: 0, failureCount: 0 });
      this.resiliencePerEndpoint.set(ep.url, this.buildResilience(ep));
    }
  }

  /**
   * Call a specific endpoint with full resilience treatment.
   * Use this when caller already chose the endpoint.
   */
  async call<T>(args: CallArgs<T>): Promise<T> {
    return this.limit(() => this.executeWithResilience(args.endpoint, args.execute));
  }

  /**
   * Pool-level call: service picks endpoint via strategy, fails over on circuit open.
   * Caller's execute() receives the chosen endpoint and returns its result.
   */
  async callPool<T>(execute: (endpoint: RemoteEndpoint) => Promise<T>): Promise<T> {
    // selector.pick() only returns circuitState === 'closed' endpoints,
    // so tried dedup is defensive (guard against race with setCircuitState).
    const tried = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < this.config.endpoints.length; attempt++) {
      const endpoint = this.selector.pick(this.states);
      if (!endpoint) {
        throw new Error(`[${this.config.name}] all endpoints unavailable (circuit open)`);
      }
      if (tried.has(endpoint.url)) continue;
      tried.add(endpoint.url);
      try {
        return await this.call({
          endpoint,
          execute: async () => execute(endpoint),
        });
      } catch (err) {
        lastError = err;
        if (attempt < this.config.endpoints.length - 1) {
          continue;
        }
      }
    }
    throw lastError ?? new Error(`[${this.config.name}] all endpoints exhausted`);
  }

  /**
   * Force-update an endpoint's circuit state (for external probes / admin).
   */
  setCircuitState(url: string, state: EndpointState['circuitState']): void {
    const s = this.states.get(url);
    if (s) s.circuitState = state;
  }

  getStats(): RemoteServiceStats {
    return {
      name: this.config.name,
      strategy: this.config.strategy,
      endpoints: this.config.endpoints.map(ep => {
        const s = this.states.get(ep.url)!;
        const st = this.stats.get(ep.url)!;
        const stats: EndpointStats = {
          url: safeUrl(ep.url),
          role: ep.role,
          circuitState: s.circuitState,
          concurrent: s.concurrent,
          totalCalls: st.totalCalls,
          successCount: st.successCount,
          failureCount: st.failureCount,
          lastError: st.lastError,
        };
        return stats;
      }),
    };
  }

  // --- Private ---

  private buildResilience(ep: RemoteEndpoint): ResilienceInternal {
    const r = { ...this.config.resilience, ...ep.resilience };
    // Retry: handle all errors EXCEPT BrokenCircuitError (don't retry when breaker is open)
    const retryPolicy = retry(
      handleWhen(err => !isBrokenCircuitError(err)),
      {
        maxAttempts: r.retryAttempts,
        backoff: new ExponentialBackoff({
          initialDelay: r.retryBackoffMs,
          maxDelay: r.retryBackoffMs * 10,
        }),
      },
    );
    const timeoutPolicy = timeout(r.timeoutMs, TimeoutStrategy.Aggressive);
    const breaker = circuitBreaker(handleAll, {
      halfOpenAfter: r.circuitResetMs,
      breaker: new ConsecutiveBreaker(r.circuitFailureThreshold),
    });
    // Wrap order: retry -> timeout -> breaker (breaker innermost, closest to fn)
    const policy = wrap(retryPolicy, timeoutPolicy, breaker);

    // Sync cockatiel breaker state to our state map via events
    const stateRef = this.states.get(ep.url);
    if (stateRef) {
      breaker.onStateChange((cs: CircuitState) => {
        switch (cs) {
          case CircuitState.Closed:
            stateRef.circuitState = 'closed';
            break;
          case CircuitState.Open:
            stateRef.circuitState = 'open';
            break;
          case CircuitState.HalfOpen:
            stateRef.circuitState = 'half-open';
            break;
        }
      });
    }

    return { policy, breaker };
  }

  private async executeWithResilience<T>(
    ep: RemoteEndpoint,
    execute: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const state = this.states.get(ep.url)!;
    const stat = this.stats.get(ep.url)!;
    state.concurrent++;
    const res = this.resiliencePerEndpoint.get(ep.url)!;
    try {
      const result = await res.policy.execute(async (context: { signal?: AbortSignal }) => {
        return execute(context.signal);
      }) as Promise<T>;
      stat.totalCalls++;
      stat.successCount++;
      return result;
    } catch (err) {
      stat.totalCalls++;
      stat.failureCount++;
      stat.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      state.concurrent--;
    }
  }
}
