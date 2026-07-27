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

describe('ConfigValidator', () => {
  it('valid config returns no errors', () => {
    expect(validateRemoteServiceConfig(valid)).toEqual([]);
  });

  it('rejects empty endpoints', () => {
    expect(validateRemoteServiceConfig({ ...valid, endpoints: [] })[0]).toMatch(/at least one endpoint/i);
  });

  it('rejects malformed URL', () => {
    expect(validateRemoteServiceConfig({ ...valid, endpoints: [{ url: 'not-a-url', model: 'm' }] })[0]).toMatch(/invalid url/i);
  });

  it('rejects zero maxConcurrency', () => {
    const bad = { ...valid, resilience: { ...valid.resilience, maxConcurrency: 0 } };
    expect(validateRemoteServiceConfig(bad)[0]).toMatch(/maxConcurrency/i);
  });

  it('rejects maxConcurrency > 1000', () => {
    const bad = { ...valid, resilience: { ...valid.resilience, maxConcurrency: 2000 } };
    expect(validateRemoteServiceConfig(bad)[0]).toMatch(/maxConcurrency/i);
  });

  it('rejects circuitResetMs < 1000', () => {
    const bad = { ...valid, resilience: { ...valid.resilience, circuitResetMs: 500 } };
    expect(validateRemoteServiceConfig(bad)[0]).toMatch(/circuitResetMs/i);
  });
});
