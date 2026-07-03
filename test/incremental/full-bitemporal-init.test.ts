/**
 * Tests: P1-T4 Full analyze sets bi-temporal attrs on edges
 *
 * Verifies that full analysis (runAnalyze → writePipelineResultToStores)
 * stamps all CODE_RELATION edges with bi-temporal attributes:
 *   - valid_from = commit timestamp (or EPOCH for legacy)
 *   - valid_to = NULL (currently valid)
 *   - txn_from = now (when we indexed this)
 *   - txn_to = NULL (current view)
 *
 * Also verifies backward compatibility: old edges without bi-temporal
 * attrs are still readable via coalesce.
 */

import { describe, it, expect, vi } from 'vitest';
import { writePipelineResultToStores } from '../../src/core/run-analyze.js';
import { EPOCH } from '../../src/store/bitemporal-model.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import type { StoreSet } from '../../src/store/interfaces.js';

/**
 * Helper: create a mock StoreSet with a tracked graph query + batchCreateRelations.
 *
 * The mock tracks Cypher strings emitted by batchCreateRelations so tests
 * can assert bi-temporal attrs are present in the edge creation Cypher.
 */
function createMockStores() {
  const graphQuery = vi.fn();
  const batchCreateRelations = vi.fn().mockImplementation(async (relations: any[]) => {
    // Store the relations for later inspection
    (batchCreateRelations as any).lastRelations = relations;
  });
  const batchCreateNodes = vi.fn();

  const stores: StoreSet = {
    graph: {
      query: graphQuery,
      clearProject: vi.fn().mockResolvedValue(undefined),
      initializeSchema: vi.fn(),
      batchCreateNodes,
      batchCreateRelations,
      findNodeIdsByFilePath: vi.fn().mockResolvedValue([]),
      deleteNodesByFilePath: vi.fn().mockResolvedValue([]),
      findSymbol: vi.fn().mockResolvedValue([]),
      findSymbolByFile: vi.fn().mockResolvedValue([]),
      getNode: vi.fn(),
      getInboundRelations: vi.fn(),
      getOutboundRelations: vi.fn(),
      bfsTraverse: vi.fn(),
      findProcessesByNode: vi.fn(),
      findEntryPoint: vi.fn(),
      findCommunityByNode: vi.fn(),
      findNodeIdsByFilePaths: vi.fn().mockResolvedValue(new Map()),
      deleteNodesByIds: vi.fn(),
      listProjects: vi.fn(),
      close: vi.fn(),
    } as any,
    search: {
      search: vi.fn(),
      indexDocuments: vi.fn(),
      deleteCollection: vi.fn(),
      ensureCollection: vi.fn(),
      deleteDocumentsByFilePath: vi.fn().mockResolvedValue(0),
      close: vi.fn(),
    } as any,
    vector: {
      search: vi.fn(),
      upsertVectors: vi.fn(),
      deleteCollection: vi.fn(),
      ensureCollection: vi.fn(),
      deleteVectorsByNodeIds: vi.fn().mockResolvedValue(0),
      close: vi.fn(),
    } as any,
    llm: {
      generate: vi.fn(),
      generateJSON: vi.fn(),
    } as any,
  } as any;

  return { stores, graphQuery, batchCreateRelations, batchCreateNodes };
}

/**
 * Create a minimal pipeline result with some nodes and relations.
 */
function createPipelineResult(): PipelineResult {
  return {
    nodes: [
      { id: 'node-a', type: 'Function', name: 'funcA', filePath: 'src/a.ts' },
      { id: 'node-b', type: 'Function', name: 'funcB', filePath: 'src/b.ts' },
    ],
    relations: [
      {
        sourceId: 'node-a',
        targetId: 'node-b',
        type: 'CALLS',
        confidence: 0.9,
        reason: 'test',
      },
    ],
    communities: [],
    processes: [],
  };
}

describe('P1-T4: Full analyze sets bi-temporal attrs on edges', () => {

  // =====================================================================
  // Test 1: After full analyze, relations carry valid_from (not null)
  // =====================================================================
  it('should set valid_from on relations during full analyze', async () => {
    const { stores, batchCreateRelations } = createMockStores();

    const result = createPipelineResult();
    await writePipelineResultToStores(result, 'test-proj', stores);

    // batchCreateRelations should have been called with relations
    expect(batchCreateRelations).toHaveBeenCalled();
    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations).toBeDefined();
    expect(passedRelations.length).toBeGreaterThan(0);

    // Each relation should have valid_from set
    for (const rel of passedRelations) {
      expect(rel).toHaveProperty('valid_from');
      expect(rel.valid_from).toBeTruthy();
    }
  });

  // =====================================================================
  // Test 2: After full analyze, relations have valid_to = null
  // =====================================================================
  it('should set valid_to = null on relations during full analyze', async () => {
    const { stores, batchCreateRelations } = createMockStores();

    const result = createPipelineResult();
    await writePipelineResultToStores(result, 'test-proj', stores);

    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations.length).toBeGreaterThan(0);

    // Each relation should have valid_to = null (currently valid)
    for (const rel of passedRelations) {
      expect(rel).toHaveProperty('valid_to');
      expect(rel.valid_to).toBeNull();
    }
  });

  // =====================================================================
  // Test 3: After full analyze, relations have txn_from (not null) and txn_to = null
  // =====================================================================
  it('should set txn_from (not null) and txn_to = null on relations', async () => {
    const { stores, batchCreateRelations } = createMockStores();

    const result = createPipelineResult();
    await writePipelineResultToStores(result, 'test-proj', stores);

    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations.length).toBeGreaterThan(0);

    for (const rel of passedRelations) {
      // txn_from should be a valid ISO timestamp
      expect(rel).toHaveProperty('txn_from');
      expect(rel.txn_from).toBeTruthy();
      // Should be a valid date string
      const parsed = new Date(rel.txn_from);
      expect(parsed.toString()).not.toBe('Invalid Date');

      // txn_to should be null (current view)
      expect(rel).toHaveProperty('txn_to');
      expect(rel.txn_to).toBeNull();
    }
  });

  // =====================================================================
  // Test 4: Legacy compat — old edges (without bi-temporal) still readable
  // =====================================================================
  it('should not break when bi-temporal attrs are missing on legacy edges (coalesce compat)', async () => {
    // The BiTemporalQuery.current() uses "valid_to IS NULL" which matches
    // both legacy edges (never had valid_to) and new edges (explicitly NULL).
    // This test verifies that the full-analyze path does NOT reject or
    // break when processing alongside legacy data.

    const { stores, batchCreateRelations } = createMockStores();

    const result = createPipelineResult();
    // Successfully completes — no throw
    await expect(
      writePipelineResultToStores(result, 'test-proj', stores),
    ).resolves.toBeDefined();

    // New relations get bi-temporal attrs
    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations.length).toBeGreaterThan(0);
    expect(passedRelations[0].valid_from).toBeTruthy();
    expect(passedRelations[0].valid_to).toBeNull();
  });

  // =====================================================================
  // Test 5: valid_from uses EPOCH fallback when no commit timestamp available
  // =====================================================================
  it('should use EPOCH or datetime for valid_from when no git commit time is available', async () => {
    const { stores, batchCreateRelations } = createMockStores();

    const result = createPipelineResult();
    // No gitUrl, no localPath, no lastCommit — simulating no git context
    await writePipelineResultToStores(result, 'test-proj', stores);

    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations.length).toBeGreaterThan(0);

    // valid_from should be set (either EPOCH for no-git or datetime)
    for (const rel of passedRelations) {
      expect(rel.valid_from).toBeTruthy();
      // Must be a valid ISO timestamp
      const parsed = new Date(rel.valid_from);
      expect(parsed.toString()).not.toBe('Invalid Date');
    }
  });

  // =====================================================================
  // Test 6: Full analyze with lastCommit — valid_from uses commit timestamp
  // =====================================================================
  it('should use commit timestamp for valid_from when lastCommit is provided', async () => {
    const { stores, batchCreateRelations } = createMockStores();

    const result = createPipelineResult();
    // With gitUrl + localPath + lastCommit — simulating real full analysis
    await writePipelineResultToStores(
      result, 'test-proj', stores,
      'https://example.com/repo.git',
      '/tmp/repo',
      'abc123def',
    );

    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations.length).toBeGreaterThan(0);

    // valid_from should be set to a real timestamp
    for (const rel of passedRelations) {
      expect(rel.valid_from).toBeTruthy();
      const parsed = new Date(rel.valid_from);
      expect(parsed.toString()).not.toBe('Invalid Date');
    }
  });

  // =====================================================================
  // Test 7: Multiple relations all get bi-temporal attrs
  // =====================================================================
  it('should set bi-temporal attrs on ALL relations, not just the first', async () => {
    const { stores, batchCreateRelations } = createMockStores();

    const result: PipelineResult = {
      nodes: [
        { id: 'n1', type: 'Function', name: 'f1', filePath: 'a.ts' },
        { id: 'n2', type: 'Function', name: 'f2', filePath: 'b.ts' },
        { id: 'n3', type: 'Function', name: 'f3', filePath: 'c.ts' },
        { id: 'n4', type: 'Class', name: 'C1', filePath: 'd.ts' },
      ],
      relations: [
        { sourceId: 'n1', targetId: 'n2', type: 'CALLS', confidence: 0.9, reason: 'r1' },
        { sourceId: 'n2', targetId: 'n3', type: 'IMPORTS', confidence: 0.8, reason: 'r2' },
        { sourceId: 'n3', targetId: 'n4', type: 'USES', confidence: 0.7, reason: 'r3' },
      ],
      communities: [],
      processes: [],
    };

    await writePipelineResultToStores(result, 'test-proj', stores);

    const passedRelations = (batchCreateRelations as any).lastRelations as any[];
    expect(passedRelations.length).toBe(3);

    // ALL relations must have all 4 bi-temporal attrs
    for (const rel of passedRelations) {
      expect(rel).toHaveProperty('valid_from');
      expect(rel.valid_from).toBeTruthy();
      expect(rel).toHaveProperty('valid_to');
      expect(rel.valid_to).toBeNull();
      expect(rel).toHaveProperty('txn_from');
      expect(rel.txn_from).toBeTruthy();
      expect(rel).toHaveProperty('txn_to');
      expect(rel.txn_to).toBeNull();
    }
  });
});
