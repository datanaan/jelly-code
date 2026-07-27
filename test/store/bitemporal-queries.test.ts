/**
 * Tests for bi-temporal Neo4j query functions.
 *
 * These are unit tests that mock IGraphStore.query() and verify:
 *   - Correct Cypher strings are generated (using BiTemporalQuery fragments from T1)
 *   - Correct params are passed
 *   - Result mapping is correct
 *
 * No real Neo4j connection needed. Each test should complete in < 50ms.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createBitemporalQueries,
} from '../../src/store/neo4j/bitemporal-queries.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import type {
  BiTemporalRelation,
} from '../../src/store/bitemporal-model.js';

// ─── Mock Factory ──────────────────────────────────────────────────

/**
 * Create a mock IGraphStore with vi.fn() for all methods.
 * query() returns the provided result set (default: empty array).
 */
function createMockGraphStore(
  queryResult: Record<string, unknown>[] = [],
): IGraphStore {
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
    query: vi.fn().mockResolvedValue(queryResult),
    clearProject: vi.fn(),
    listProjects: vi.fn(),
    close: vi.fn(),
  };
}

// Helper to build a Neo4j-style relation properties object
function makeRelProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId: 'node-A',
    targetId: 'node-B',
    type: 'CALLS',
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: null,
    txn_from: '2026-01-01T00:00:00Z',
    txn_to: null,
    ...overrides,
  };
}

// ─── findNodeAsOf ──────────────────────────────────────────────────

describe('findNodeAsOf', () => {
  it('returns node + relations valid at time T', async () => {
    const mockResults = [
      {
        n: { properties: { id: 'node-1', name: 'foo', type: 'Function', projectId: 'proj-1' } },
        rels: [makeRelProps({ type: 'CALLS', sourceId: 'node-1', targetId: 'node-2' })],
      },
    ];
    const store = createMockGraphStore(mockResults);
    const queries = createBitemporalQueries(store);

    const result = await queries.findNodeAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    expect(result.node).not.toBeNull();
    expect(result.node!.id).toBe('node-1');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].type).toBe('CALLS');
  });

  it('uses BiTemporalQuery.asOf fragment in Cypher (coalesce(valid_from) <= $queryTime)', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findNodeAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // T2 wraps valid_from with coalesce for backward compat with legacy edges
    expect(cypher).toContain('coalesce(');
    expect(cypher).toContain('valid_from');
    expect(cypher).toContain('<= $queryTime');
    expect(cypher).toContain('coalesce(r.valid_to');
    expect(cypher).toContain('> $queryTime');
    expect(params).toHaveProperty('projectId', 'proj-1');
    expect(params).toHaveProperty('nodeId', 'node-1');
    expect(params).toHaveProperty('queryTime', '2026-06-01T00:00:00Z');
  });

  it('excludes relations not yet valid (valid_from > T) via Cypher filter', async () => {
    // The mock returns whatever Neo4j gives. The point is: the Cypher contains
    // the asOf filter that would exclude future relations at the DB level.
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findNodeAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // The asOf fragment ensures coalesce(valid_from) <= T, so future relations excluded
    expect(cypher).toContain('valid_from');
    expect(cypher).toContain('<= $queryTime');
  });

  it('excludes superseded relations (valid_to <= T) via coalesce filter', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findNodeAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // coalesce(valid_to, FAR_FUTURE) > T ensures superseded (valid_to <= T) are excluded
    expect(cypher).toContain('coalesce(r.valid_to');
    expect(cypher).toContain('> $queryTime');
  });

  it('returns null node when node does not exist', async () => {
    const store = createMockGraphStore([]); // empty result
    const queries = createBitemporalQueries(store);

    const result = await queries.findNodeAsOf('proj-1', 'nonexistent', '2026-06-01T00:00:00Z');

    expect(result.node).toBeNull();
    expect(result.relations).toEqual([]);
  });
});

// ─── findRelationsAsOf ─────────────────────────────────────────────

describe('findRelationsAsOf', () => {
  it('returns relations valid at time T', async () => {
    const mockResults = [
      makeRelProps({ sourceId: 'node-1', targetId: 'node-2', type: 'CALLS' }),
      makeRelProps({ sourceId: 'node-1', targetId: 'node-3', type: 'IMPORTS' }),
    ];
    const store = createMockGraphStore(mockResults);
    const queries = createBitemporalQueries(store);

    const rels = await queries.findRelationsAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    expect(rels).toHaveLength(2);
    expect(rels[0].sourceId).toBe('node-1');
    expect(rels[1].type).toBe('IMPORTS');
  });

  it('filters by relType when provided', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findRelationsAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z', 'CALLS');

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // relType is parameterized (not string-interpolated) for Cypher injection safety
    expect(cypher).toContain('r.type = $relType');
    expect(params).toHaveProperty('relType', 'CALLS');
  });

  it('does not filter by relType when not provided', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findRelationsAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // No relType filter in Cypher or params
    expect(cypher).not.toContain('$relType');
    expect(params).not.toHaveProperty('relType');
  });

  it('returns empty array for non-existent node', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    const rels = await queries.findRelationsAsOf('proj-1', 'nonexistent', '2026-06-01T00:00:00Z');

    expect(rels).toEqual([]);
  });

  it('includes bi-temporal attributes in returned relations', async () => {
    const mockResults = [
      makeRelProps({
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      }),
    ];
    const store = createMockGraphStore(mockResults);
    const queries = createBitemporalQueries(store);

    const rels = await queries.findRelationsAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    expect(rels[0].valid_from).toBe('2026-01-01T00:00:00Z');
    expect(rels[0].valid_to).toBeNull();
    expect(rels[0].txn_from).toBe('2026-01-01T00:00:00Z');
  });
});

// ─── findChangesBetween ────────────────────────────────────────────

describe('findChangesBetween', () => {
  it('returns changes in (from, to] range', async () => {
    const mockResults = [
      {
        rel: makeRelProps({
          valid_from: '2026-06-10T00:00:00Z',
          valid_to: null,
          type: 'CALLS',
        }),
      },
    ];
    const store = createMockGraphStore(mockResults);
    const queries = createBitemporalQueries(store);

    const changes = await queries.findChangesBetween(
      'proj-1', 'node-1',
      '2026-06-01T00:00:00Z',
      '2026-06-15T00:00:00Z',
    );

    expect(changes).toHaveLength(1);
  });

  it('uses valid_from > $fromTime AND valid_from <= $toTime filter', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findChangesBetween(
      'proj-1', 'node-1',
      '2026-06-01T00:00:00Z',
      '2026-06-15T00:00:00Z',
    );

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // Changes use valid_from in (from, to] — new relations that started in this range
    expect(cypher).toContain('valid_from');
    expect(cypher).toContain('> $fromTime');
    expect(cypher).toContain('<= $toTime');
    expect(params).toHaveProperty('fromTime', '2026-06-01T00:00:00Z');
    expect(params).toHaveProperty('toTime', '2026-06-15T00:00:00Z');
  });

  it('returns empty array for range with no changes', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    const changes = await queries.findChangesBetween(
      'proj-1', 'node-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );

    expect(changes).toEqual([]);
  });
});

// ─── supersedeRelation ─────────────────────────────────────────────

describe('supersedeRelation', () => {
  it('closes old relation (sets valid_to and txn_to)', async () => {
    const store = createMockGraphStore([{ closed: 1 }]);
    const queries = createBitemporalQueries(store);

    const newRel: BiTemporalRelation = {
      valid_from: '2026-06-15T00:00:00Z',
      valid_to: null,
      txn_from: '2026-06-16T00:00:00Z',
      txn_to: null,
    };

    await queries.supersedeRelation(
      'proj-1',
      'rel-old-1',
      '2026-06-15T00:00:00Z',
      newRel,
      '2026-06-16T00:00:00Z',
    );

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // Should SET valid_to and txn_to on old relation
    expect(cypher).toMatch(/SET.*valid_to/i);
    expect(cypher).toMatch(/SET.*txn_to/i);
    expect(params).toHaveProperty('supersedeTime', '2026-06-15T00:00:00Z');
    expect(params).toHaveProperty('txnTime', '2026-06-16T00:00:00Z');
  });

  it('creates new relation with valid_from and txn_from set', async () => {
    const store = createMockGraphStore([{ closed: 1 }, { created: 1 }]);
    const queries = createBitemporalQueries(store);

    const newRel: BiTemporalRelation = {
      valid_from: '2026-06-15T00:00:00Z',
      valid_to: null,
      txn_from: '2026-06-16T00:00:00Z',
      txn_to: null,
    };

    await queries.supersedeRelation(
      'proj-1', 'rel-old-1',
      '2026-06-15T00:00:00Z', newRel, '2026-06-16T00:00:00Z',
    );

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // Should CREATE or MERGE new relation with valid_from
    expect(cypher).toMatch(/CREATE|MERGE/i);
    expect(params).toHaveProperty('newRel');
    expect(params.newRel).toHaveProperty('valid_from', '2026-06-15T00:00:00Z');
  });

  it('executes atomically in a single Cypher transaction', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    const newRel: BiTemporalRelation = {
      valid_from: '2026-06-15T00:00:00Z',
      valid_to: null,
      txn_from: '2026-06-16T00:00:00Z',
      txn_to: null,
    };

    await queries.supersedeRelation('proj-1', 'rel-old-1', '2026-06-15T00:00:00Z', newRel);

    // Should be a single query call (atomic — both close old + create new in one tx)
    expect(vi.mocked(store.query).mock.calls).toHaveLength(1);
  });

  it('no-op when old relation does not exist (closed count = 0)', async () => {
    // Simulate Neo4j returning count(closed) = 0 — old relation not found
    const store = createMockGraphStore([{ closed: 0 }]);
    const queries = createBitemporalQueries(store);

    const newRel: BiTemporalRelation = {
      valid_from: '2026-06-15T00:00:00Z',
      valid_to: null,
      txn_from: '2026-06-16T00:00:00Z',
      txn_to: null,
    };

    const result = await queries.supersedeRelation(
      'proj-1', 'rel-nonexistent',
      '2026-06-15T00:00:00Z', newRel,
    );

    // Should indicate no supersede happened
    expect(result.superseded).toBe(false);
  });

  it('reports success when old relation is closed', async () => {
    const store = createMockGraphStore([{ closed: 1, created: 1 }]);
    const queries = createBitemporalQueries(store);

    const newRel: BiTemporalRelation = {
      valid_from: '2026-06-15T00:00:00Z',
      valid_to: null,
      txn_from: '2026-06-16T00:00:00Z',
      txn_to: null,
    };

    const result = await queries.supersedeRelation(
      'proj-1', 'rel-old-1',
      '2026-06-15T00:00:00Z', newRel,
    );

    expect(result.superseded).toBe(true);
  });
});

// ─── Backward Compatibility ────────────────────────────────────────

describe('backward compatibility', () => {
  it('legacy edge without bi-temporal attrs treated as epoch → NULL via coalesce', async () => {
    // Legacy edges have no valid_from/valid_to/txn_from/txn_to properties.
    // The Cypher should use coalesce(valid_from, EPOCH) and similar to handle them.
    // At query time T, a legacy edge should be included (always valid).
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    await queries.findRelationsAsOf('proj-1', 'node-1', '2026-06-01T00:00:00Z');

    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // The asOf fragment from T1 uses valid_from directly.
    // For legacy edges, valid_from is missing (null in Neo4j).
    // T2 wraps both valid_from and valid_to with coalesce for backward compat.
    expect(cypher).toContain('coalesce(r.valid_from');
    expect(cypher).toContain('coalesce(r.valid_to');
  });
});

// ─── closeCrossDomainEdgesForNode (v1.3.0 Phase 1 T1-6) ────────────

describe('closeCrossDomainEdgesForNode (v1.3.0 T1-6)', () => {
  it('CK-6: closes active DESCRIBES + DOCUMENTED_BY edges with valid_to + txn_to', async () => {
    const store = createMockGraphStore([
      { closedDescribes: 2, closedDocumentedBy: 2 },
    ]);
    const queries = createBitemporalQueries(store);

    const result = await queries.closeCrossDomainEdgesForNode(
      'proj-1',
      'old-codenode-1',
      '2026-07-22T10:00:00Z',
      '2026-07-22T10:01:00Z',
    );

    expect(result).toBe(4); // 2 DESCRIBES + 2 DOCUMENTED_BY

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];

    // Both edge types are handled
    expect(cypher).toContain(':DESCRIBES');
    expect(cypher).toContain(':DOCUMENTED_BY');

    // Bi-temporal closing: valid_to + txn_to SET
    expect(cypher).toContain('d.valid_to = $supersedeTime');
    expect(cypher).toContain('d.txn_to = $txnTime');
    expect(cypher).toContain('db.valid_to = $supersedeTime');
    expect(cypher).toContain('db.txn_to = $txnTime');

    // Only closes currently-active edges
    expect(cypher).toContain('d.valid_to IS NULL');
    expect(cypher).toContain('db.valid_to IS NULL');

    // projectId isolation
    expect(cypher).toContain('$projectId');
    expect(params).toHaveProperty('projectId', 'proj-1');
    expect(params).toHaveProperty('nodeId', 'old-codenode-1');
    expect(params).toHaveProperty('supersedeTime', '2026-07-22T10:00:00Z');
    expect(params).toHaveProperty('txnTime', '2026-07-22T10:01:00Z');
  });

  it('returns 0 when no active cross-domain edges exist', async () => {
    const store = createMockGraphStore([
      { closedDescribes: 0, closedDocumentedBy: 0 },
    ]);
    const queries = createBitemporalQueries(store);

    const result = await queries.closeCrossDomainEdgesForNode(
      'proj-1', 'node-without-edges',
    );

    expect(result).toBe(0);
  });

  it('returns 0 when Neo4j returns empty result set', async () => {
    const store = createMockGraphStore([]);
    const queries = createBitemporalQueries(store);

    const result = await queries.closeCrossDomainEdgesForNode(
      'proj-1', 'nonexistent-node',
    );

    expect(result).toBe(0);
  });

  it('uses default timestamps when supersedeTime/txnTime omitted', async () => {
    const store = createMockGraphStore([
      { closedDescribes: 1, closedDocumentedBy: 1 },
    ]);
    const queries = createBitemporalQueries(store);

    await queries.closeCrossDomainEdgesForNode('proj-1', 'node-1');

    const [, params] = vi.mocked(store.query).mock.calls[0];
    // Should have ISO timestamps (generated from new Date().toISOString())
    expect(params.supersedeTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.txnTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('CK-6: is idempotent — only closes edges where valid_to IS NULL', async () => {
    const store = createMockGraphStore([
      { closedDescribes: 0, closedDocumentedBy: 0 },
    ]);
    const queries = createBitemporalQueries(store);

    // First call closes edges; second call finds no active edges
    await queries.closeCrossDomainEdgesForNode('proj-1', 'node-1');
    const secondResult = await queries.closeCrossDomainEdgesForNode('proj-1', 'node-1');

    // The WHERE d.valid_to IS NULL clause ensures already-closed edges aren't touched
    expect(secondResult).toBe(0);

    const [cypher] = vi.mocked(store.query).mock.calls[1];
    expect(cypher).toContain('d.valid_to IS NULL');
    expect(cypher).toContain('db.valid_to IS NULL');
  });
});
