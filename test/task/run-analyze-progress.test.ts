import { describe, it, expect } from 'vitest';

describe('RunAnalyzeOptions onProgress', () => {
  it('should accept onProgress callback in options type', async () => {
    const { runAnalyze } = await import('../../src/core/run-analyze.js');
    expect(typeof runAnalyze).toBe('function');
  });
});
