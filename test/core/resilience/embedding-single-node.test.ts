/**
 * CK-31: 单节点 embedding 池退化测试
 *
 * 验证：least-connections 策略 + 单 endpoint 时，embedding 请求正常。
 */
import { describe, it, expect } from 'vitest';
import { RemoteService } from '../../../src/core/resilience/remote-service.js';
import type { RemoteServiceConfig } from '../../../src/core/resilience/types.js';

describe('CK-31: 单节点池退化', () => {
  it('least-connections + 单节点：请求正常', async () => {
    const cfg: RemoteServiceConfig = {
      name: 'single-node',
      endpoints: [{ url: 'http://localhost:11434', model: 'bge-m3' }],
      strategy: 'least-connections',
      resilience: {
        maxConcurrency: 4, timeoutMs: 5000, retryAttempts: 1, retryBackoffMs: 10,
        circuitFailureThreshold: 5, circuitResetMs: 30000,
      },
    };
    const svc = new RemoteService(cfg);
    const result = await svc.call({
      endpoint: cfg.endpoints[0],
      execute: async () => 'ok',
    });
    expect(result).toBe('ok');
    const stats = svc.getStats();
    expect(stats.endpoints).toHaveLength(1);
    expect(stats.endpoints[0].successCount).toBe(1);
  });
});
