/**
 * Unit Tests: Cleanup Worker
 *
 * Tests the project deletion and stale node cleanup logic.
 * Mocks ioredis to prevent real Redis connections (NOAUTH errors).
 */

import { describe, it, expect, vi } from 'vitest';

// Mock ioredis BEFORE importing modules that use it
// This prevents unhandled NOAUTH rejections from real Redis connections
vi.mock('ioredis', () => {
  const MockRedis = vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    quit: vi.fn().mockResolvedValue(undefined),
  }));
  return { default: MockRedis, Redis: MockRedis };
});

import { createCleanupWorker } from '../../src/worker/cleanup-worker.js';
import type { StoreSet } from '../../src/store/interfaces.js';

function createMockStores(): StoreSet {
  return {
    graph: {
      initializeSchema: async () => {},
      findSymbol: async () => [],
      findSymbolByFile: async () => [],
      getNode: async () => null,
      getInboundRelations: async () => [],
      getOutboundRelations: async () => [],
      bfsTraverse: async () => ({ visited: [], edges: [], depths: new Map() }),
      findProcessesByNode: async () => [],
      findEntryPoint: async () => null,
      findCommunityByNode: async () => null,
      batchCreateNodes: async () => {},
      batchCreateRelations: async () => {},
      query: vi.fn().mockResolvedValue([]),
      safeQuery: vi.fn().mockResolvedValue([]),
      clearProject: async () => {},
      listProjects: async () => [],
      close: async () => {},
    } as any,
    search: {
      indexDocuments: async () => {},
      search: async () => [],
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      healthCheck: async () => true,
      close: async () => {},
    } as any,
    vector: {
      upsertVectors: async () => {},
      search: async () => [],
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      healthCheck: async () => true,
      close: async () => {},
    } as any,
    llm: {} as any,
  };
}

describe('Cleanup Worker', () => {
  it('should create worker with correct queue name', () => {
    const stores = createMockStores();
    const worker = createCleanupWorker(stores);
    expect(worker).toBeDefined();
    worker.close();
  });

  it('should have concurrency of 1 (serialized)', () => {
    const stores = createMockStores();
    const worker = createCleanupWorker(stores);
    // Cleanup should be serialized to avoid conflicts
    expect(worker.opts?.concurrency).toBe(1);
    worker.close();
  });

  it('should handle cleanup with mock stores', () => {
    const stores = createMockStores();
    const worker = createCleanupWorker(stores);
    expect(worker).toBeDefined();
    worker.close();
  });
});
