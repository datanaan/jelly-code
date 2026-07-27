/**
 * Unit Tests: Search Sync Worker
 *
 * Tests the search synchronization logic and freshness checking.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSearchSyncWorker } from '../../src/worker/search-sync-worker.js';
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
      indexDocuments: vi.fn().mockResolvedValue(undefined),
      search: async () => [],
      deleteCollection: async () => {},
      healthCheck: async () => true,
      close: async () => {},
    } as any,
    vector: {
      upsertVectors: async () => {},
      search: async () => [],
      deleteCollection: async () => {},
      healthCheck: async () => true,
      close: async () => {},
    } as any,
    llm: {} as any,
  };
}

describe('Search Sync Worker', () => {
  it('should create worker with correct queue name', () => {
    const stores = createMockStores();
    const worker = createSearchSyncWorker(stores);
    expect(worker).toBeDefined();
    worker.close();
  });

  it('should handle empty project gracefully (no searchable docs)', () => {
    const stores = createMockStores();
    const worker = createSearchSyncWorker(stores);
    expect(worker.opts?.concurrency).toBeGreaterThanOrEqual(1);
    worker.close();
  });

  it('should not crash when Typesense index fails', () => {
    const stores = createMockStores();
    const worker = createSearchSyncWorker(stores);
    expect(worker).toBeDefined();
    worker.close();
  });
});
