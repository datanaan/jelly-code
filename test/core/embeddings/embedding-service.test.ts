import { describe, it, expect } from 'vitest';
import { EmbeddingService } from '../../../src/core/embeddings/embedding-service.js';

const baseResilience = {
  maxConcurrency: 2, timeoutMs: 5000, retryAttempts: 1, retryBackoffMs: 10,
  circuitFailureThreshold: 3, circuitResetMs: 1000,
};

describe('EmbeddingService', () => {
  it('embed: returns vectors of correct dimensions', async () => {
    const svc = new EmbeddingService({
      name: 'embedding',
      endpoints: [{ url: 'http://a', model: 'm' }],
      strategy: 'priority',
      resilience: baseResilience,
      dimensions: 8,
    }, async (_ep, texts) => texts.map(() => Array.from({ length: 8 }, () => 0.1)));
    const result = await svc.embed(['hello', 'world']);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(8);
  });

  it('embedQuery: returns single number[] vector', async () => {
    const svc = new EmbeddingService({
      name: 'embedding', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: baseResilience, dimensions: 4,
    }, async (_ep, texts) => texts.map(() => [1, 0, 0, 0]));
    const v = await svc.embedQuery('test');
    expect(v).toEqual([1, 0, 0, 0]);
  });

  it('empty input returns empty array', async () => {
    const svc = new EmbeddingService({
      name: 'embedding', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: baseResilience, dimensions: 4,
    }, async () => { throw new Error('should not be called'); });
    expect(await svc.embed([])).toEqual([]);
  });

  it('rejects dimension mismatch', async () => {
    const svc = new EmbeddingService({
      name: 'embedding', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: { ...baseResilience, retryAttempts: 0 }, dimensions: 4,
    }, async (_ep, texts) => texts.map(() => [0, 1]));  // wrong dims
    await expect(svc.embed(['x'])).rejects.toThrow(/dimension/i);
  });

  it('splits batches internally by batchSize', async () => {
    let calls = 0;
    let maxBatchSize = 0;
    const svc = new EmbeddingService({
      name: 'embedding', endpoints: [{ url: 'http://a', model: 'm' }], strategy: 'priority',
      resilience: baseResilience, dimensions: 2, batchSize: 3,
    }, async (_ep, texts) => {
      calls++;
      maxBatchSize = Math.max(maxBatchSize, texts.length);
      return texts.map(() => [0, 0]);
    });
    await svc.embed(['a', 'b', 'c', 'd', 'e']);
    expect(calls).toBe(2);          // 5 items / batchSize 3 = 2 batches
    expect(maxBatchSize).toBeLessThanOrEqual(3);
  });

  it('fails over to second endpoint on error (priority)', async () => {
    let callsA = 0;
    const svc = new EmbeddingService({
      name: 'embedding',
      endpoints: [{ url: 'http://a', model: 'm', role: 'primary' }, { url: 'http://b', model: 'm', role: 'fallback' }],
      strategy: 'priority',
      resilience: { ...baseResilience, retryAttempts: 0, circuitFailureThreshold: 1 },
      dimensions: 2,
    }, async (ep, texts) => {
      if (ep.url === 'http://a') {
        callsA++;
        throw new Error('a-down');
      }
      return texts.map(() => [0, 1]);
    });
    const result = await svc.embed(['x']);
    expect(Array.from(result[0])).toEqual([0, 1]);
    expect(callsA).toBeGreaterThanOrEqual(1);
  });
});
