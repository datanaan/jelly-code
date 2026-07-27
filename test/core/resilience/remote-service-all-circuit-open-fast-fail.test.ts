/**
 * CK-32: 全部熔断快速失败 — callPool 在全部 endpoint open 时立即抛错
 *
 * 验证：RemoteService.callPool 在所有端点电路都 open 时
 * 不逐个尝试，立即抛出 "all endpoints unavailable"。
 */
import { describe, it, expect } from 'vitest';
import { RemoteService } from '../../../src/core/resilience/remote-service.js';
import type { RemoteServiceConfig } from '../../../src/core/resilience/types.js';

describe('CK-32: 全部熔断快速失败', () => {
  it('callPool throws immediately when all endpoints circuit open', async () => {
    const cfg: RemoteServiceConfig = {
      name: 'fast-fail',
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

    // Verify both are open
    const stats = svc.getStats();
    expect(stats.endpoints.every(e => e.circuitState === 'open')).toBe(true);

    // callPool should reject immediately (fast-fail)
    const start = Date.now();
    await expect(svc.callPool(async () => 'x')).rejects.toThrow(/all endpoints.*unavailable|circuit/i);
    const elapsed = Date.now() - start;
    // Should be near-instant (< 100ms) since it doesn't attempt retries
    expect(elapsed).toBeLessThan(100);
  });
});
