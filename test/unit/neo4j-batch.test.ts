/**
 * Unit Tests: Neo4j Batch Operations
 *
 * Tests the Neo4j batch utility functions.
 * Imports the real chunkArray from pipeline-core.ts.
 */

import { describe, it, expect } from 'vitest';
import { CHUNK_BYTE_BUDGET, AST_CACHE_CAP, chunkArray } from '../../src/core/ingestion/pipeline-core.js';

describe('Neo4j Batch Operations', () => {
  it('should import real project constants', () => {
    expect(CHUNK_BYTE_BUDGET).toBe(20 * 1024 * 1024);
    expect(AST_CACHE_CAP).toBe(50);
  });

  it('should generate correct batch sizes with default batch size', () => {
    const BATCH_SIZE = 5000;
    const items = Array.from({ length: 12345 }, (_, i) => ({ id: `n${i}` }));
    const batches = chunkArray(items, BATCH_SIZE);
    expect(batches.length).toBe(3); // 5000 + 5000 + 2345
    expect(batches[0].length).toBe(5000);
    expect(batches[1].length).toBe(5000);
    expect(batches[2].length).toBe(2345);
  });

  it('should handle custom batch size', () => {
    const BATCH_SIZE = 500;
    const items = Array.from({ length: 1234 }, (_, i) => ({ id: `n${i}` }));
    const batches = chunkArray(items, BATCH_SIZE);
    expect(batches.length).toBe(3); // 500 + 500 + 234
    expect(batches[0].length).toBe(500);
    expect(batches[1].length).toBe(500);
    expect(batches[2].length).toBe(234);
  });

  it('should handle empty input', () => {
    const items: Array<{ id: string }> = [];
    const batches = chunkArray(items, 500);
    expect(batches.length).toBe(0);
  });

  it('should handle single item', () => {
    const items = [{ id: 'test' }];
    const batches = chunkArray(items, 500);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1);
  });

  it('should handle exact batch size', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}` }));
    const batches = chunkArray(items, 500);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(500);
  });

  it('should handle batch size of 1', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `n${i}` }));
    const batches = chunkArray(items, 1);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(1);
    expect(batches[1].length).toBe(1);
    expect(batches[2].length).toBe(1);
  });
});
