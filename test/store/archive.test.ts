/**
 * Tests for P1-T5: Archive & TTL — bi-temporal edge archiving.
 *
 * Approach A (Soft archive): Adds `archived: true` flag to superseded edges
 * whose valid_to is older than retentionDays. Data is not lost; asOf queries
 * still find archived edges when explicitly requested.
 *
 * These are unit tests that mock IGraphStore.query() and verify:
 *   - Correct Cypher strings for identifying + flagging old edges
 *   - Default retention = 90 days
 *   - Custom retention via config
 *   - asOf queries still work after archive (data not lost)
 *   - Empty graph is a no-op
 *   - Archive is idempotent (re-running doesn't double-archive)
 *
 * No real Neo4j connection needed.
 */

import { describe, it, expect, vi } from 'vitest';
import { archiveOldVersions } from '../../src/store/archive.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import { createBitemporalQueries } from '../../src/store/neo4j/bitemporal-queries.js';

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
    findNodeIdsByFilePaths: vi.fn(),
    deleteNodesByFilePath: vi.fn(),
    deleteNodesByIds: vi.fn(),
    query: vi.fn().mockResolvedValue(queryResult),
    clearProject: vi.fn(),
    listProjects: vi.fn(),
    close: vi.fn(),
  };
}

// ─── archiveOldVersions ────────────────────────────────────────────

describe('archiveOldVersions', () => {
  it('flags superseded edges older than retentionDays with archived = true', async () => {
    // Simulate Neo4j returning count of archived edges
    const store = createMockGraphStore([{ archived: 5 }]);
    const result = await archiveOldVersions(store, 90);

    expect(result.archived).toBe(5);
    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // Cypher should SET archived = true on edges past retention
    expect(cypher).toContain('SET');
    expect(cypher).toContain('archived');
    expect(cypher).toMatch(/true/i);
  });

  it('uses valid_to < cutoff to identify old edges (not valid_from)', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    await archiveOldVersions(store, 90);

    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // Should filter on valid_to (the supersede time), not valid_from
    expect(cypher).toContain('valid_to');
    // valid_to must NOT be null (currently valid edges should NOT be archived)
    expect(cypher).toContain('IS NOT NULL');
  });

  it('excludes currently valid edges (valid_to IS NULL)', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    await archiveOldVersions(store, 90);

    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // Must explicitly exclude edges with NULL valid_to (still current)
    expect(cypher).toContain('valid_to IS NOT NULL');
  });

  it('excludes already-archived edges', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    await archiveOldVersions(store, 90);

    const [cypher] = vi.mocked(store.query).mock.calls[0];
    // Should NOT re-archive edges that already have archived = true
    expect(cypher).toMatch(/archived.*(?:IS NULL|<> true|!= true|false)/i);
  });

  it('default retention = 90 days', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    await archiveOldVersions(store); // no retentionDays argument

    const [, params] = vi.mocked(store.query).mock.calls[0];
    // Should compute cutoff = now - 90 days
    // We verify by checking that a cutoff param exists and is ~90 days ago
    expect(params).toHaveProperty('cutoff');
    const cutoff = new Date(params.cutoff as string);
    const now = new Date();
    const diffDays = (now.getTime() - cutoff.getTime()) / 86400000;
    // Allow some tolerance for test execution time
    expect(diffDays).toBeGreaterThan(89);
    expect(diffDays).toBeLessThan(91);
  });

  it('custom retention via config (e.g., 30 days)', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    await archiveOldVersions(store, 30);

    const [, params] = vi.mocked(store.query).mock.calls[0];
    expect(params).toHaveProperty('cutoff');
    const cutoff = new Date(params.cutoff as string);
    const now = new Date();
    const diffDays = (now.getTime() - cutoff.getTime()) / 86400000;
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  it('asOf queries still find archived edges (data not lost)', async () => {
    // After archiving, an asOf query at a time when the edge was valid
    // should still return it. The archived flag is a performance hint,
    // not a visibility filter.
    const archivedEdgeResult = [
      {
        sourceId: 'node-A',
        targetId: 'node-B',
        type: 'CALLS',
        confidence: 0.9,
        reason: 'test',
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-03-01T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: '2026-03-01T00:00:00Z',
      },
    ];

    // Mock returns the archived edge when queried at a time it was valid
    const store = createMockGraphStore(archivedEdgeResult);
    const queries = createBitemporalQueries(store);

    // Query at 2026-02-01 — the edge was valid at this time
    const rels = await queries.findRelationsAsOf(
      'proj-1', 'node-A', '2026-02-01T00:00:00Z',
    );

    // Edge should still be found — archive doesn't delete
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe('node-A');
  });

  it('empty graph → no-op (archived: 0)', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    const result = await archiveOldVersions(store, 90);

    expect(result.archived).toBe(0);
  });

  it('archive is idempotent — re-running does not double-archive', async () => {
    // First run archives 3 edges, second run archives 0
    const store = createMockGraphStore([{ archived: 0 }]);
    // First call returns 3 archived
    vi.mocked(store.query).mockResolvedValueOnce([{ archived: 3 }]);
    // Second call returns 0 (no more edges to archive)
    vi.mocked(store.query).mockResolvedValueOnce([{ archived: 0 }]);

    const result1 = await archiveOldVersions(store, 90);
    const result2 = await archiveOldVersions(store, 90);

    expect(result1.archived).toBe(3);
    expect(result2.archived).toBe(0);

    // Both calls should have the exclude-already-archived filter
    const [cypher1] = vi.mocked(store.query).mock.calls[0];
    const [cypher2] = vi.mocked(store.query).mock.calls[1];
    expect(cypher1).toMatch(/archived.*(?:IS NULL|<> true|!= true|false)/i);
    expect(cypher2).toMatch(/archived.*(?:IS NULL|<> true|!= true|false)/i);
  });

  it('uses parameterized Cypher for cutoff (no string injection)', async () => {
    const store = createMockGraphStore([{ archived: 0 }]);
    await archiveOldVersions(store, 90);

    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    // cutoff should be a parameter, not string-interpolated
    expect(cypher).toContain('$cutoff');
    expect(params).toHaveProperty('cutoff');
    // cutoff should be a valid ISO date string
    const cutoff = params.cutoff as string;
    expect(() => new Date(cutoff).toISOString()).not.toThrow();
  });
});
