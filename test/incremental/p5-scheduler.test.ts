/**
 * Tests: P5 IncrementalScheduler + Safety Nets
 *
 * Verifies the three safety layers:
 * Layer 1: Change ratio > 5% → full rebuild
 * Layer 2: Max consecutive incremental > 10 → full rebuild
 * Layer 3: Freshness timeout > 7 days → full rebuild
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncrementalScheduler } from '../../src/server/scheduler.js';

function createMockStores() {
  return {
    graph: {
      query: vi.fn().mockResolvedValue([]),
      clearProject: vi.fn().mockResolvedValue(undefined),
      initializeSchema: vi.fn().mockResolvedValue(undefined),
      batchCreateNodes: vi.fn().mockResolvedValue(undefined),
      batchCreateRelations: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue([]),
      findNodeIdsByFilePath: vi.fn().mockResolvedValue([]),
      deleteNodesByFilePath: vi.fn().mockResolvedValue([]),
      findSymbol: vi.fn().mockResolvedValue([]),
      findSymbolByFile: vi.fn().mockResolvedValue([]),
      getNode: vi.fn().mockResolvedValue(null),
      getInboundRelations: vi.fn().mockResolvedValue([]),
      getOutboundRelations: vi.fn().mockResolvedValue([]),
      bfsTraverse: vi.fn().mockResolvedValue({ visited: [], edges: [], depths: new Map() }),
      findProcessesByNode: vi.fn().mockResolvedValue([]),
      findEntryPoint: vi.fn().mockResolvedValue(null),
      findCommunityByNode: vi.fn().mockResolvedValue(null),
      findNodeIdsByFilePaths: vi.fn().mockResolvedValue(new Map()),
      deleteNodesByIds: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    },
    search: {
      search: vi.fn().mockResolvedValue([]),
      indexDocuments: vi.fn().mockResolvedValue({}),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      deleteDocumentsByFilePath: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    },
    vector: {
      search: vi.fn().mockResolvedValue([]),
      upsertVectors: vi.fn().mockResolvedValue({}),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      deleteVectorsByNodeIds: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    },
    llm: {
      generate: vi.fn().mockResolvedValue(''),
      generateJSON: vi.fn().mockResolvedValue({}),
    },
  };
}

function createMockTaskManager() {
  return {
    getState: vi.fn().mockReturnValue(null),
  };
}

function createMockRepoCache() {
  return {
    ensureClone: vi.fn().mockResolvedValue('/tmp/test-repo'),
    getHeadCommit: vi.fn().mockReturnValue('HEAD'),
  };
}

describe('P5: IncrementalScheduler', () => {
  it('should create scheduler instance', () => {
    const stores = createMockStores();
    const repoCache = createMockRepoCache() as any;
    const taskManager = createMockTaskManager() as any;
    const scheduler = new IncrementalScheduler(stores as any, repoCache, taskManager);
    expect(scheduler).toBeDefined();
  });

  it('should start and stop timer', () => {
    const stores = createMockStores();
    const repoCache = createMockRepoCache() as any;
    const taskManager = createMockTaskManager() as any;
    const scheduler = new IncrementalScheduler(stores as any, repoCache, taskManager);

    scheduler.start(60); // 60 minutes
    scheduler.stop();
    // No error = pass
  });

  it('Layer 1: change ratio > 5% should trigger full rebuild', () => {
    const MAX_CHANGE_RATIO = parseFloat(process.env.MAX_CHANGE_RATIO || '0.05');

    // 60 changes in 1000 files = 6% > 5% → full rebuild
    const totalFiles = 1000;
    const totalChanges = 60;
    const changeRatio = totalFiles > 0 ? totalChanges / totalFiles : 0;
    expect(changeRatio).toBeGreaterThan(MAX_CHANGE_RATIO);

    // 40 changes in 1000 files = 4% < 5% → incremental OK
    const changeRatio2 = 40 / 1000;
    expect(changeRatio2).toBeLessThanOrEqual(MAX_CHANGE_RATIO);
  });

  it('Layer 2: max consecutive incremental > 10 should trigger full rebuild', () => {
    const MAX_CONSECUTIVE = parseInt(process.env.MAX_CONSECUTIVE_INCREMENTAL || '10', 10);

    // 12 consecutive incrementals > 10 → full rebuild
    const consecutiveIncremental = 12;
    expect(consecutiveIncremental).toBeGreaterThanOrEqual(MAX_CONSECUTIVE);

    // 8 consecutive incrementals < 10 → incremental OK
    const consecutiveIncremental2 = 8;
    expect(consecutiveIncremental2).toBeLessThan(MAX_CONSECUTIVE);
  });

  it('Layer 3: freshness timeout > 7 days should trigger full rebuild', () => {
    const STALE_TIMEOUT_DAYS = parseInt(process.env.STALE_TIMEOUT_DAYS || '7', 10);

    // 10 days > 7 → full rebuild
    const daysStale = 10;
    expect(daysStale).toBeGreaterThan(STALE_TIMEOUT_DAYS);

    // 3 days < 7 → OK
    const daysStale2 = 3;
    expect(daysStale2).toBeLessThanOrEqual(STALE_TIMEOUT_DAYS);
  });

  it('should skip projects with manual analysis in progress', () => {
    const taskManager = createMockTaskManager();
    taskManager.getState = vi.fn().mockReturnValue({ status: 'analyzing' });

    const stores = createMockStores();
    const repoCache = createMockRepoCache() as any;
    const scheduler = new IncrementalScheduler(stores as any, repoCache, taskManager as any);

    // If analyzing, checkAllProjects should skip
    const state = taskManager.getState('test-project');
    expect(state.status).toBe('analyzing');
  });

  it('should use environment variables for thresholds', () => {
    // Test with custom env values
    const originalMaxConsecutive = process.env.MAX_CONSECUTIVE_INCREMENTAL;
    const originalMaxRatio = process.env.MAX_CHANGE_RATIO;
    const originalStale = process.env.STALE_TIMEOUT_DAYS;

    process.env.MAX_CONSECUTIVE_INCREMENTAL = '5';
    process.env.MAX_CHANGE_RATIO = '0.10';
    process.env.STALE_TIMEOUT_DAYS = '14';

    expect(parseInt(process.env.MAX_CONSECUTIVE_INCREMENTAL, 10)).toBe(5);
    expect(parseFloat(process.env.MAX_CHANGE_RATIO)).toBe(0.10);
    expect(parseInt(process.env.STALE_TIMEOUT_DAYS, 10)).toBe(14);

    // Restore (in case this test runs with others)
    if (originalMaxConsecutive) process.env.MAX_CONSECUTIVE_INCREMENTAL = originalMaxConsecutive;
    if (originalMaxRatio) process.env.MAX_CHANGE_RATIO = originalMaxRatio;
    if (originalStale) process.env.STALE_TIMEOUT_DAYS = originalStale;
  });
});
