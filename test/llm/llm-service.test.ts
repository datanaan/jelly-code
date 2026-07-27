import { describe, it, expect } from 'vitest';
import { LLMService } from '../../src/llm/llm-service.js';
import type { RemoteEndpoint } from '../../src/core/resilience/types.js';

// We can't easily mock undici's fetch; instead test via injectable http caller
describe('LLMService', () => {
  it('implements ILLMClient interface', () => {
    const svc = new LLMService({
      name: 'llm',
      endpoints: [{ url: 'http://a', model: 'm' }],
      strategy: 'priority',
      resilience: {
        maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 1, retryBackoffMs: 10,
        circuitFailureThreshold: 3, circuitResetMs: 1000,
      },
    }, async (_ep, _prompt) => 'mock-response');
    expect(typeof svc.generate).toBe('function');
    expect(typeof svc.generateJSON).toBe('function');
  });

  it('generate: returns response from caller', async () => {
    const svc = new LLMService({
      name: 'llm', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: { maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 1, retryBackoffMs: 10, circuitFailureThreshold: 3, circuitResetMs: 1000 },
    }, async (_ep, prompt) => `echo:${prompt}`);
    const result = await svc.generate('hello');
    expect(result).toBe('echo:hello');
  });

  it('generateJSON: parses JSON from response', async () => {
    const svc = new LLMService({
      name: 'llm', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: { maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 0, retryBackoffMs: 10, circuitFailureThreshold: 3, circuitResetMs: 1000 },
    }, async () => '```json\n{"k":"v"}\n```');
    const result = await svc.generateJSON<{ k: string }>('ignored');
    expect(result.k).toBe('v');
  });

  it('generateJSON: throws on invalid JSON after retries', async () => {
    const svc = new LLMService({
      name: 'llm', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: { maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 0, retryBackoffMs: 10, circuitFailureThreshold: 3, circuitResetMs: 1000 },
    }, async () => 'not-json');
    await expect(svc.generateJSON('x')).rejects.toThrow(/JSON parse failed/);
  });

  it('records usage after each generate', async () => {
    const svc = new LLMService({
      name: 'llm', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: { maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 0, retryBackoffMs: 10, circuitFailureThreshold: 3, circuitResetMs: 1000 },
    }, async () => 'response');
    await svc.generate('a'.repeat(40));
    const stats = svc.getUsageStats();
    expect(stats.get('http://a')?.callCount).toBe(1);
    expect(stats.get('http://a')?.totalTokens).toBeGreaterThan(0);
  });

  it('stats: exposes RemoteService stats', async () => {
    const svc = new LLMService({
      name: 'llm', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: { maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 0, retryBackoffMs: 10, circuitFailureThreshold: 3, circuitResetMs: 1000 },
    }, async () => 'x');
    await svc.generate('test');
    const stats = svc.getStats();
    expect(stats.endpoints[0].successCount).toBeGreaterThanOrEqual(1);
  });

  it('fails over to second endpoint on circuit open (priority)', async () => {
    let callsA = 0;
    const caller = async (ep: RemoteEndpoint, _prompt: string) => {
      if (ep.url === 'http://a') {
        callsA++;
        throw new Error('a-down');
      }
      return 'from-b';
    };
    const svc = new LLMService({
      name: 'llm',
      endpoints: [{ url: 'http://a', model: 'm', role: 'primary' }, { url: 'http://b', model: 'm', role: 'fallback' }],
      strategy: 'priority',
      resilience: { maxConcurrency: 2, timeoutMs: 200, retryAttempts: 0, retryBackoffMs: 10, circuitFailureThreshold: 1, circuitResetMs: 60000 },
    }, caller);
    // First call: a fails, circuit opens, failover to b
    const result = await svc.generate('test');
    expect(result).toBe('from-b');
    expect(callsA).toBeGreaterThanOrEqual(1);
  });
});
