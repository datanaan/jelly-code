/**
 * Integration: LLM pool fails over from primary to fallback when primary circuit opens.
 */
import { describe, it, expect } from 'vitest';
import { LLMService } from '../../src/llm/llm-service.js';

describe('Integration: LLM pool failover', () => {
  it('primary failure → fallback succeeds', async () => {
    let primaryCalls = 0;
    const svc = new LLMService({
      name: 'llm',
      endpoints: [
        { url: 'http://primary.test', model: 'm', role: 'primary' },
        { url: 'http://fallback.test', model: 'm', role: 'fallback' },
      ],
      strategy: 'priority',
      resilience: {
        maxConcurrency: 2, timeoutMs: 200, retryAttempts: 0, retryBackoffMs: 10,
        circuitFailureThreshold: 1, circuitResetMs: 60_000,
      },
    }, async (ep, _prompt) => {
      if (ep.url === 'http://primary.test') {
        primaryCalls++;
        throw new Error('primary-down');
      }
      return 'from-fallback';
    });

    const result = await svc.generate('test');
    expect(result).toBe('from-fallback');
    expect(primaryCalls).toBeGreaterThanOrEqual(1);

    const stats = svc.getStats();
    expect(stats.endpoints[0].circuitState).toBe('open');
    expect(stats.endpoints[1].successCount).toBeGreaterThanOrEqual(1);
  });
});
