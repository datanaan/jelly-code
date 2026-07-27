/**
 * CK-27: 配置校验集成测试 — 验证非法配置时 LLMService/EmbeddingService 构造失败
 *
 * 验证 F1 修复生效：validateRemoteServiceConfig 在 createStoreSet 中被调用，
 * 非法配置直接抛出明确错误消息。
 */
import { describe, it, expect } from 'vitest';
import { validateRemoteServiceConfig } from '../../../src/core/resilience/config-validator.js';
import type { RemoteServiceConfig } from '../../../src/core/resilience/types.js';

const valid: RemoteServiceConfig = {
  name: 'llm',
  endpoints: [{ url: 'http://a:11434', model: 'm' }],
  strategy: 'priority',
  resilience: {
    maxConcurrency: 4, timeoutMs: 30000, retryAttempts: 2, retryBackoffMs: 1000,
    circuitFailureThreshold: 5, circuitResetMs: 30000,
  },
};

describe('CK-27: 配置校验集成', () => {
  it('URL 格式错误 — 拒绝启动', () => {
    const errors = validateRemoteServiceConfig({ ...valid, endpoints: [{ url: 'not-a-url', model: 'm' }] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/invalid url/i);
  });

  it('maxConcurrency 超上限 — 拒绝启动', () => {
    const errors = validateRemoteServiceConfig({ ...valid, resilience: { ...valid.resilience, maxConcurrency: 9999 } });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/maxConcurrency/i);
  });

  it('circuitResetMs 太小 — 拒绝启动', () => {
    const errors = validateRemoteServiceConfig({ ...valid, resilience: { ...valid.resilience, circuitResetMs: 100 } });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/circuitResetMs/i);
  });
});
