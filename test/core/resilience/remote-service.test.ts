import { describe, it, expect, vi } from 'vitest';
import { RemoteService } from '../../../src/core/resilience/remote-service.js';
import type { RemoteServiceConfig } from '../../../src/core/resilience/types.js';

const baseConfig: RemoteServiceConfig = {
  name: 'test-svc',
  endpoints: [{ url: 'http://a', model: 'm', role: 'primary' }],
  strategy: 'priority',
  resilience: {
    maxConcurrency: 2,
    timeoutMs: 5000,
    retryAttempts: 1,
    retryBackoffMs: 10,
    circuitFailureThreshold: 3,
    circuitResetMs: 100,
  },
};

describe('RemoteService', () => {
  it('single endpoint: returns success result', async () => {
    const svc = new RemoteService(baseConfig);
    const result = await svc.call({
      endpoint: baseConfig.endpoints[0],
      execute: async () => 'ok',
    });
    expect(result).toBe('ok');
  });

  it('retries on failure then succeeds', async () => {
    let calls = 0;
    const svc = new RemoteService(baseConfig);
    const result = await svc.call({
      endpoint: baseConfig.endpoints[0],
      execute: async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return 'recovered';
      },
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('throws after exhausting retries', async () => {
    const svc = new RemoteService(baseConfig);
    await expect(svc.call({
      endpoint: baseConfig.endpoints[0],
      execute: async () => { throw new Error('perm-fail'); },
    })).rejects.toThrow('perm-fail');
  });

  it('timeout: aborts long-running call', async () => {
    const svc = new RemoteService({ ...baseConfig, resilience: { ...baseConfig.resilience, timeoutMs: 50 } });
    await expect(svc.call({
      endpoint: baseConfig.endpoints[0],
      execute: async (signal) => {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve('late'), 1000);
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        });
      },
    })).rejects.toThrow();
  });

  it('circuit opens after threshold consecutive failures', async () => {
    const svc = new RemoteService(baseConfig);
    for (let i = 0; i < 3; i++) {
      await expect(svc.call({
        endpoint: baseConfig.endpoints[0],
        execute: async () => { throw new Error('fail'); },
      })).rejects.toThrow();
    }
    const stats = svc.getStats();
    expect(stats.endpoints[0].circuitState).toBe('open');
  });

  it('circuit half-open after resetMs, then closed on success', async () => {
    const svc = new RemoteService(baseConfig);
    for (let i = 0; i < 3; i++) {
      await expect(svc.call({
        endpoint: baseConfig.endpoints[0],
        execute: async () => { throw new Error('fail'); },
      })).rejects.toThrow();
    }
    expect(svc.getStats().endpoints[0].circuitState).toBe('open');
    await new Promise(r => setTimeout(r, 150)); // > circuitResetMs

    // Next call should be allowed (half-open) and succeed -> closed
    const result = await svc.call({
      endpoint: baseConfig.endpoints[0],
      execute: async () => 'recovered',
    });
    expect(result).toBe('recovered');
    expect(svc.getStats().endpoints[0].circuitState).toBe('closed');
  });

  it('multi-endpoint priority: failover to next on failure', async () => {
    const cfg: RemoteServiceConfig = {
      ...baseConfig,
      endpoints: [
        { url: 'http://a', model: 'm', role: 'primary' },
        { url: 'http://b', model: 'm', role: 'fallback' },
      ],
    };
    const svc = new RemoteService(cfg);
    // Make primary fail permanently by opening its circuit
    for (let i = 0; i < 3; i++) {
      await expect(svc.call({
        endpoint: cfg.endpoints[0],
        execute: async () => { throw new Error('a-down'); },
      })).rejects.toThrow();
    }
    // Now pool call should route to fallback
    const result = await svc.callPool(async (endpoint) => {
      return endpoint.url === 'http://a' ? Promise.reject(new Error('a-down')) : 'from-b';
    });
    expect(result).toBe('from-b');
  });

  it('respects maxConcurrency', async () => {
    const svc = new RemoteService({ ...baseConfig, resilience: { ...baseConfig.resilience, maxConcurrency: 2 } });
    let active = 0;
    let maxActive = 0;
    const slow = () => new Promise<string>(r => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; r('ok'); }, 50);
    });
    await Promise.all([
      svc.call({ endpoint: baseConfig.endpoints[0], execute: slow }),
      svc.call({ endpoint: baseConfig.endpoints[0], execute: slow }),
      svc.call({ endpoint: baseConfig.endpoints[0], execute: slow }),
      svc.call({ endpoint: baseConfig.endpoints[0], execute: slow }),
    ]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('stats: counts successes and failures', async () => {
    const svc = new RemoteService(baseConfig);
    await svc.call({ endpoint: baseConfig.endpoints[0], execute: async () => 'ok' });
    try {
      await svc.call({ endpoint: baseConfig.endpoints[0], execute: async () => { throw new Error('x'); } });
    } catch {}
    const stats = svc.getStats();
    expect(stats.endpoints[0].successCount).toBeGreaterThanOrEqual(1);
    expect(stats.endpoints[0].failureCount).toBeGreaterThanOrEqual(1);
  });

  it('callPool throws when all endpoints circuit open', async () => {
    const cfg: RemoteServiceConfig = {
      ...baseConfig,
      endpoints: [
        { url: 'http://a', model: 'm' },
        { url: 'http://b', model: 'm' },
      ],
      strategy: 'priority',
    };
    const svc = new RemoteService(cfg);
    // Open circuits for both endpoints
    for (const ep of cfg.endpoints) {
      for (let i = 0; i < 3; i++) {
        await expect(svc.call({ endpoint: ep, execute: async () => { throw new Error('x'); } })).rejects.toThrow();
      }
    }
    await expect(svc.callPool(async () => 'x')).rejects.toThrow(/all endpoints.*unavailable|circuit/i);
  });
});
