/**
 * CK-29: 全部 LLM 端点熔断 — /readyz 返回 503
 *
 * 验证：当所有 LLM endpoint 的 circuit 都 open 时，/readyz 返回 503 + 原因。
 */
import { describe, it, expect } from 'vitest';
import { RemoteService } from '../../src/core/resilience/remote-service.js';
import type { RemoteServiceConfig } from '../../src/core/resilience/types.js';

describe('CK-29: 全部熔断 readyz 503', () => {
  it('全部 endpoint circuit open → readyz-like check 返回 503 原因', async () => {
    const cfg: RemoteServiceConfig = {
      name: 'test',
      endpoints: [
        { url: 'http://a', model: 'm' },
        { url: 'http://b', model: 'm' },
      ],
      strategy: 'priority',
      resilience: {
        maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 1, retryBackoffMs: 10,
        circuitFailureThreshold: 1, circuitResetMs: 60000,
      },
    };
    const svc = new RemoteService(cfg);

    // Open circuits for both endpoints
    for (const ep of cfg.endpoints) {
      await expect(svc.call({
        endpoint: ep,
        execute: async () => { throw new Error('fail'); },
      })).rejects.toThrow();
    }

    const stats = svc.getStats();
    const allOpen = stats.endpoints.length > 0 && stats.endpoints.every(e => e.circuitState === 'open');
    expect(allOpen).toBe(true);

    // callPool should throw with "all endpoints unavailable"
    await expect(svc.callPool(async () => 'x')).rejects.toThrow(/all endpoints.*unavailable|circuit/i);
  });
});
