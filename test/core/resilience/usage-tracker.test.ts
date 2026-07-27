import { describe, it, expect } from 'vitest';
import { UsageTracker, estimateTokens } from '../../../src/core/resilience/usage-tracker.js';

describe('UsageTracker', () => {
  it('estimateTokens: length / 4 approximation', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('records usage and summarizes per endpoint', () => {
    const tracker = new UsageTracker();
    tracker.record({ endpoint: 'http://a', promptTokens: 10, completionTokens: 5, timestamp: Date.now() });
    tracker.record({ endpoint: 'http://a', promptTokens: 20, completionTokens: 5, timestamp: Date.now() });
    tracker.record({ endpoint: 'http://b', promptTokens: 100, completionTokens: 50, timestamp: Date.now() });
    const summary = tracker.summary();
    expect(summary.get('http://a')?.totalTokens).toBe(40);
    expect(summary.get('http://a')?.callCount).toBe(2);
    expect(summary.get('http://b')?.totalTokens).toBe(150);
  });

  it('returns empty map when no usage', () => {
    expect(new UsageTracker().summary().size).toBe(0);
  });

  it('handles concurrent records safely', async () => {
    const tracker = new UsageTracker();
    await Promise.all(Array.from({ length: 100 }, (_, i) =>
      tracker.record({ endpoint: 'http://a', promptTokens: i, completionTokens: 0, timestamp: Date.now() })
    ));
    expect(tracker.summary().get('http://a')?.callCount).toBe(100);
  });
});
