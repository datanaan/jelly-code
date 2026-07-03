/**
 * P2-T1: Evolution Facts Query — aggregates 5 graph queries for code evolution.
 *
 * Tests the gatherEvolutionFacts function which aggregates:
 *   1. EVOLVED_FROM chain (symbol lineage / rename history)
 *   2. CHANGED_IN edges (commits that touched the node)
 *   3. AUTHORED_BY (contributors)
 *   4. CO_CHANGED_WITH (frequently changed together)
 *   5. Bi-temporal change timeline (from P1)
 *
 * Strategy: Unit tests with mock IGraphStore. Mock query() returns
 * pre-built Neo4j result rows. Verify Cypher patterns and result mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  gatherEvolutionFacts,
  type EvolutionFacts,
} from '../../src/wiki/evolution-facts-query.js';
import type { IGraphStore } from '../../src/store/interfaces.js';

// ==========================================
// Mock factory
// ==========================================

/**
 * Create a mock IGraphStore where query() returns different results
 * based on the Cypher string (so we can simulate different query types).
 *
 * For EVOLVED_FROM queries (which use iterative depth traversal), only
 * the first call returns results; subsequent calls return empty to stop
 * the chain.
 */
function createMockGraphStore(
  queryResults: Map<string, Record<string, unknown>[]> = new Map(),
): IGraphStore {
  // Track whether EVOLVED_FROM has been called (it iterates)
  let evolvedFromCalled = false;

  return {
    initializeSchema: vi.fn(),
    findSymbol: vi.fn(),
    findSymbolByFile: vi.fn(),
    getNode: vi.fn(),
    getInboundRelations: vi.fn(),
    getOutboundRelations: vi.fn(),
    bfsTraverse: vi.fn(),
    findProcessesByNode: vi.fn(),
    findEntryPoint: vi.fn(),
    findCommunityByNode: vi.fn(),
    batchCreateNodes: vi.fn(),
    batchCreateRelations: vi.fn(),
    findNodeIdsByFilePath: vi.fn(),
    deleteNodesByFilePath: vi.fn(),
    deleteNodesByIds: vi.fn(),
    query: vi.fn(async (cypher: string) => {
      // EVOLVED_FROM uses iterative traversal — only return results on first call
      if (cypher.includes('EVOLVED_FROM')) {
        if (evolvedFromCalled) return [];
        evolvedFromCalled = true;
        const results = queryResults.get('EVOLVED_FROM');
        return results ?? [];
      }

      // Match by keyword in Cypher to return appropriate results
      for (const [keyword, results] of queryResults) {
        if (cypher.includes(keyword)) {
          return results;
        }
      }
      return [];
    }),
    clearProject: vi.fn(),
    listProjects: vi.fn(),
    close: vi.fn(),
  };
}

// ==========================================
// Helper: build mock result rows
// ==========================================

function makeCommitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    c: {
      properties: {
        id: 'abc123',
        message: 'fix: update function',
        author: 'Alice',
        authorEmail: 'alice@example.com',
        timestamp: '2026-03-15T10:00:00Z',
        additions: 10,
        deletions: 3,
        isMerge: false,
      },
    },
    ...overrides,
  };
}

function makeAuthorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authorId: 'author-1',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    changeCount: 5,
    ownership: 0.75,
    lastChangeAt: '2026-03-15T10:00:00Z',
    ...overrides,
  };
}

function makeCoChangedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeB: 'node-sibling-1',
    coChangeCount: 8,
    support: 0.3,
    confidence: 0.6,
    lift: 1.5,
    ...overrides,
  };
}

function makeEvolvedFromRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    previousNodeId: 'node-old-name',
    originalName: 'oldFunctionName',
    originalFile: 'src/old-file.ts',
    commitId: 'rename-commit-1',
    timestamp: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

function makeBitemporalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: null,
    txn_from: '2026-01-01T00:00:00Z',
    txn_to: null,
    type: 'CALLS',
    ...overrides,
  };
}

// ==========================================
// Tests
// ==========================================

describe('gatherEvolutionFacts', () => {
  it('aggregates EVOLVED_FROM lineage', async () => {
    const queryMap = new Map<string, Record<string, unknown>[]>([
      ['EVOLVED_FROM', [makeEvolvedFromRow()]],
    ]);
    const store = createMockGraphStore(queryMap);

    const result = await gatherEvolutionFacts('proj-1', 'node-1', store);

    expect(result.evolvedFrom).toHaveLength(1);
    expect(result.evolvedFrom[0]).toEqual({
      from: 'node-1',
      to: 'node-old-name',
      commit: 'rename-commit-1',
      timestamp: '2026-02-01T00:00:00Z',
    });
  });

  it('aggregates CHANGED_IN commits', async () => {
    const queryMap = new Map<string, Record<string, unknown>[]>([
      ['CHANGED_IN', [makeCommitRow()]],
    ]);
    const store = createMockGraphStore(queryMap);

    const result = await gatherEvolutionFacts('proj-1', 'node-1', store);

    expect(result.changedIn).toHaveLength(1);
    expect(result.changedIn[0]).toEqual({
      commit: 'abc123',
      timestamp: '2026-03-15T10:00:00Z',
      additions: 10,
      deletions: 3,
      author: 'Alice',
    });
  });

  it('aggregates AUTHORED_BY authors', async () => {
    const queryMap = new Map<string, Record<string, unknown>[]>([
      ['AUTHORED_BY', [
        makeAuthorRow({ changeCount: 5, lastChangeAt: '2026-03-15T10:00:00Z' }),
        makeAuthorRow({
          authorId: 'author-2',
          authorName: 'Bob',
          authorEmail: 'bob@example.com',
          changeCount: 2,
          ownership: 0.25,
          lastChangeAt: '2026-02-01T00:00:00Z',
        }),
      ]],
    ]);
    const store = createMockGraphStore(queryMap);

    const result = await gatherEvolutionFacts('proj-1', 'node-1', store);

    expect(result.authoredBy).toHaveLength(2);
    expect(result.authoredBy[0]).toEqual({
      author: 'Alice',
      commitCount: 5,
      firstSeen: '2026-03-15T10:00:00Z',
      lastSeen: '2026-03-15T10:00:00Z',
    });
    expect(result.authoredBy[1].author).toBe('Bob');
    expect(result.authoredBy[1].commitCount).toBe(2);
  });

  it('aggregates CO_CHANGED_WITH siblings', async () => {
    const queryMap = new Map<string, Record<string, unknown>[]>([
      ['CO_CHANGED_WITH', [
        makeCoChangedRow({ nodeB: 'node-sib-1', coChangeCount: 8, support: 0.3 }),
        makeCoChangedRow({
          nodeB: 'node-sib-2',
          coChangeCount: 4,
          support: 0.15,
          confidence: 0.4,
          lift: 1.2,
        }),
      ]],
    ]);
    const store = createMockGraphStore(queryMap);

    const result = await gatherEvolutionFacts('proj-1', 'node-1', store);

    expect(result.coChangedWith).toHaveLength(2);
    expect(result.coChangedWith[0]).toEqual({
      nodeId: 'node-sib-1',
      coChangeCount: 8,
      jaccard: 0.3,
    });
    expect(result.coChangedWith[1].nodeId).toBe('node-sib-2');
    expect(result.coChangedWith[1].jaccard).toBe(0.15);
  });

  it('includes bi-temporal change timeline', async () => {
    const queryMap = new Map<string, Record<string, unknown>[]>([
      ['valid_from', [
        makeBitemporalRow({
          valid_from: '2026-01-01T00:00:00Z',
          valid_to: '2026-03-01T00:00:00Z',
          type: 'CALLS',
        }),
        makeBitemporalRow({
          valid_from: '2026-03-01T00:00:00Z',
          valid_to: null,
          type: 'CALLS',
        }),
      ]],
    ]);
    const store = createMockGraphStore(queryMap);

    const result = await gatherEvolutionFacts('proj-1', 'node-1', store);

    expect(result.changeTimeline).toHaveLength(2);
    // Timeline entries should have timestamps from valid_from/valid_to
    expect(result.changeTimeline[0].validFrom).toBe('2026-01-01T00:00:00Z');
    expect(result.changeTimeline[0].validTo).toBe('2026-03-01T00:00:00Z');
    expect(result.changeTimeline[1].validFrom).toBe('2026-03-01T00:00:00Z');
    expect(result.changeTimeline[1].validTo).toBeNull();
  });

  it('returns empty result for non-existent node (all queries return empty)', async () => {
    const store = createMockGraphStore(new Map());

    const result = await gatherEvolutionFacts('proj-1', 'nonexistent-node', store);

    expect(result.nodeId).toBe('nonexistent-node');
    expect(result.evolvedFrom).toEqual([]);
    expect(result.changedIn).toEqual([]);
    expect(result.authoredBy).toEqual([]);
    expect(result.coChangedWith).toEqual([]);
    expect(result.changeTimeline).toEqual([]);
  });

  it('respects projectId isolation — passes projectId to all queries', async () => {
    const queryMap = new Map<string, Record<string, unknown>[]>([
      ['CHANGED_IN', [makeCommitRow()]],
    ]);
    const store = createMockGraphStore(queryMap);

    await gatherEvolutionFacts('my-project', 'node-1', store);

    // Every query call should include projectId in params
    const calls = vi.mocked(store.query).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, params] of calls) {
      expect(params).toHaveProperty('projectId', 'my-project');
    }
  });

  it('returns structured EvolutionFacts object with correct shape', async () => {
    const store = createMockGraphStore(new Map());

    const result = await gatherEvolutionFacts('proj-1', 'node-1', store);

    // Verify the object has all required keys
    expect(result).toHaveProperty('nodeId');
    expect(result).toHaveProperty('evolvedFrom');
    expect(result).toHaveProperty('changedIn');
    expect(result).toHaveProperty('authoredBy');
    expect(result).toHaveProperty('coChangedWith');
    expect(result).toHaveProperty('changeTimeline');
    // Verify types
    expect(Array.isArray(result.evolvedFrom)).toBe(true);
    expect(Array.isArray(result.changedIn)).toBe(true);
    expect(Array.isArray(result.authoredBy)).toBe(true);
    expect(Array.isArray(result.coChangedWith)).toBe(true);
    expect(Array.isArray(result.changeTimeline)).toBe(true);
  });
});
