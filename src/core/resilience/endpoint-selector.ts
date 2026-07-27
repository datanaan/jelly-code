/**
 * Endpoint selection strategies. Stateless given endpoint states.
 * State (circuit + concurrent) is owned by RemoteService.
 */
import type { LoadBalanceStrategy, RemoteEndpoint } from './types.js';

export interface EndpointState {
  circuitState: 'closed' | 'open' | 'half-open';
  concurrent: number;
}

export class EndpointSelector {
  private rrIndex = 0;

  constructor(
    private endpoints: RemoteEndpoint[],
    private strategy: LoadBalanceStrategy,
  ) {}

  /**
   * Pick the next healthy endpoint, or undefined if all circuits are open/half-open.
   * NOTE: 'half-open' is treated as unhealthy for selection — only the circuit
   * breaker itself transitions half-open → closed after a probe succeeds.
   */
  pick(states: Map<string, EndpointState>): RemoteEndpoint | undefined {
    const healthy = this.endpoints.filter(e => {
      const s = states.get(e.url);
      return !s || s.circuitState === 'closed';
    });
    if (healthy.length === 0) return undefined;

    switch (this.strategy) {
      case 'priority':
        return healthy[0];
      case 'round-robin': {
        // Use the original endpoints order, skip unhealthy
        for (let i = 0; i < this.endpoints.length; i++) {
          const idx = (this.rrIndex + i) % this.endpoints.length;
          const e = this.endpoints[idx];
          const s = states.get(e.url);
          if (!s || s.circuitState === 'closed') {
            this.rrIndex = (idx + 1) % this.endpoints.length;
            return e;
          }
        }
        return undefined;
      }
      case 'weighted-random': {
        const totalWeight = healthy.reduce((sum, e) => sum + (e.weight ?? 1), 0);
        let r = Math.random() * totalWeight;
        for (const e of healthy) {
          r -= (e.weight ?? 1);
          if (r <= 0) return e;
        }
        return healthy[healthy.length - 1];
      }
      case 'least-connections': {
        let best = healthy[0];
        let bestConcurrent = states.get(best.url)?.concurrent ?? 0;
        for (let i = 1; i < healthy.length; i++) {
          const c = states.get(healthy[i].url)?.concurrent ?? 0;
          if (c < bestConcurrent) {
            bestConcurrent = c;
            best = healthy[i];
          }
        }
        return best;
      }
    }
  }
}
