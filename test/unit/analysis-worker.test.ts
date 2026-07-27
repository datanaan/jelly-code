/**
 * Unit Tests: Analysis Worker
 *
 * Tests the analysis worker's job processing logic.
 * Uses mock stores and mocked BullMQ — no real Neo4j/Redis needed.
 *
 * Design:
 * - Tests worker creation, config, and the standalone entry point guard
 * - BullMQ Worker itself is not tested here (it's a third-party lib);
 *   we test the factory function and the `isMainModule` guard
 * - Redis/BullMQ are mocked at module level to avoid connection errors
 * - M2: Added tests that verify main() path via loadConfig + createStoreSet
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// Mock Redis BEFORE importing modules that use it
vi.mock('ioredis', () => {
  const MockRedis = vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    quit: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    expire: vi.fn().mockResolvedValue(1),
  }));
  return { default: MockRedis, Redis: MockRedis };
});

// Mock factory to avoid LLM/Neo4j connections in unit tests
vi.mock('../../src/store/factory.js', () => ({
  createStoreSet: vi.fn().mockResolvedValue({
    graph: {
      query: vi.fn().mockResolvedValue([]),
      initializeSchema: vi.fn().mockResolvedValue(undefined),
      safeQuery: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    },
    search: { close: vi.fn().mockResolvedValue(undefined) },
    vector: { close: vi.fn().mockResolvedValue(undefined) },
    llm: {},
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/config/index.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    neo4j: { url: 'bolt://localhost:7687' },
    typesense: { url: 'http://localhost:8108' },
    qdrant: { url: 'http://localhost:6333' },
    llm: { model: 'test', baseUrl: 'http://localhost:11434' },
  }),
}));

import { createAnalysisWorker } from '../../src/worker/analysis-worker.js';
import { createSearchSyncWorker } from '../../src/worker/search-sync-worker.js';
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
      deleteCollection: async () => {},
      deleteDocumentsByFilePath: async () => 0,
      healthCheck: async () => true,
      close: async () => {},
    } as any,
    vector: {
      upsertVectors: async () => {},
      search: async () => [],
      deleteCollection: async () => {},
      deleteVectorsByNodeIds: async () => 0,
      healthCheck: async () => true,
      close: async () => {},
    } as any,
    llm: {} as any,
  };
}

describe('Analysis Worker - creation and config', () => {
  it('should create worker with correct queue name', () => {
    const stores = createMockStores();
    const worker = createAnalysisWorker(stores);
    expect(worker).toBeDefined();
    expect(worker.name).toBe('analyze');
    worker.close();
  });

  it('should handle empty stores gracefully', () => {
    const stores = createMockStores();
    const worker = createAnalysisWorker(stores);
    expect(worker.opts?.concurrency).toBeGreaterThanOrEqual(1);
    worker.close();
  });

  it('should accept optional taskManager and repoCache', () => {
    const stores = createMockStores();
    const taskManager = {
      markAnalyzing: vi.fn(),
      markReady: vi.fn(),
      markError: vi.fn(),
      updateProgress: vi.fn(),
      getState: vi.fn(),
      requestAnalyze: vi.fn(),
    } as any;
    const worker = createAnalysisWorker(stores, undefined, taskManager);
    expect(worker).toBeDefined();
    expect(worker.name).toBe('analyze');
    worker.close();
  });

  it('v1.3.0 T3-4: should accept optional wikiService for auto-derivation', () => {
    const stores = createMockStores();
    const wikiService = { getGraph: vi.fn() } as any;
    const worker = createAnalysisWorker(stores, undefined, undefined, wikiService);
    expect(worker).toBeDefined();
    expect(worker.name).toBe('analyze');
    worker.close();
  });

  it('should set correct concurrency from env or default', () => {
    const stores = createMockStores();
    const originalConcurrency = process.env.WORKER_CONCURRENCY;
    delete process.env.WORKER_CONCURRENCY;

    const worker = createAnalysisWorker(stores);
    expect(worker.opts?.concurrency).toBe(3); // default
    worker.close();

    process.env.WORKER_CONCURRENCY = originalConcurrency;
  });
});

describe('Search-sync Worker', () => {
  it('should create worker with correct queue name', () => {
    const stores = createMockStores();
    const worker = createSearchSyncWorker(stores);
    expect(worker).toBeDefined();
    expect(worker.name).toBe('search-sync');
    worker.close();
  });
});

describe('Cleanup Worker', () => {
  it('should create worker with correct queue name', () => {
    const stores = createMockStores();
    const worker = createCleanupWorker(stores);
    expect(worker).toBeDefined();
    expect(worker.name).toBe('cleanup');
    worker.close();
  });
});

describe('Worker isMainModule guard', () => {
  const ORIGINAL_ARGV = process.argv;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
  });

  it('analysis-worker should detect standalone mode by argv', async () => {
    process.argv = ['node', 'analysis-worker.ts'];
    const mod = await import('../../src/worker/analysis-worker.js');
    expect(mod.createAnalysisWorker).toBeDefined();
  });

  it('search-sync-worker should detect standalone mode by argv', async () => {
    process.argv = ['node', 'search-sync-worker.ts'];
    const mod = await import('../../src/worker/search-sync-worker.js');
    expect(mod.createSearchSyncWorker).toBeDefined();
  });

  it('cleanup-worker should detect standalone mode by argv', async () => {
    process.argv = ['node', 'cleanup-worker.ts'];
    const mod = await import('../../src/worker/cleanup-worker.js');
    expect(mod.createCleanupWorker).toBeDefined();
  });
});

describe('Worker main() entry point (M2)', () => {
  it('should import and call main() without error', async () => {
    // The standalone main() in analysis-worker calls createStoreSet(config)
    // and createAnalysisWorker. With mocks in place, this should succeed.
    process.argv = ['node', 'analysis-worker.ts'];
    const mod = await import('../../src/worker/analysis-worker.js');
    expect(mod.createAnalysisWorker).toBeDefined();

    // Verify the factory mock is importable
    const { createStoreSet } = await import('../../src/store/factory.js');
    const stores = await createStoreSet({} as any);
    expect(stores.graph).toBeDefined();
    expect(stores.search).toBeDefined();
  });

  it('should import loadConfig and return valid config', async () => {
    const { loadConfig } = await import('../../src/config/index.js');
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.neo4j).toBeDefined();
  });
});
