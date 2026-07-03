/**
 * Integration test: GET /api/code/as-of
 *
 * P1-T6: Tests the code node point-in-time query endpoint.
 *
 * Uses a mock IGraphStore with createBitemporalQueries to verify the
 * full HTTP request cycle:
 *   query param validation → findNodeAsOf → response shaping
 *
 * The endpoint returns the node state and its valid relations at time T,
 * enabling "what did this code look like on date X?" queries.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBitemporalQueries } from '../../src/store/neo4j/bitemporal-queries.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import { createCodeRoutes } from '../../src/server/code-routes.js';

// ── Mock factory ────────────────────────────────────────────────

/**
 * Create a mock IGraphStore whose query() returns configurable results.
 * This simulates what Neo4j would return for findNodeAsOf.
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

/** Build a Neo4j-style result row for findNodeAsOf. */
function makeNodeResult(
  nodeId: string,
  rels: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  return [
    {
      n: {
        properties: {
          id: nodeId,
          name: 'testFunction',
          type: 'Function',
          projectId: 'proj-1',
          filePath: '/src/index.ts',
          startLine: 10,
          endLine: 20,
        },
      },
      rels,
    },
  ];
}

/** Build relation properties matching Neo4j output. */
function makeRelProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId: 'node-1',
    targetId: 'node-2',
    type: 'CALLS',
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: null,
    txn_from: '2026-01-01T00:00:00Z',
    txn_to: null,
    ...overrides,
  };
}

/** Create a test Express app with code routes mounted (no auth middleware). */
function createTestApp(graphStore: IGraphStore) {
  const queries = createBitemporalQueries(graphStore);
  const app = express();
  app.use(express.json());
  app.use('/api/code', createCodeRoutes(queries));
  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('GET /api/code/as-of', () => {
  // ── Happy path: returns node state at time T ──────────────────

  it('returns node state at time T (200)', async () => {
    const mockResults = makeNodeResult('node-1', [
      makeRelProps({ type: 'CALLS', sourceId: 'node-1', targetId: 'node-2' }),
    ]);
    const store = createMockGraphStore(mockResults);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', nodeId: 'node-1', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('projectId', 'proj-1');
    expect(res.body).toHaveProperty('nodeId', 'node-1');
    expect(res.body).toHaveProperty('time', '2026-06-01T00:00:00Z');
    expect(res.body).toHaveProperty('node');
    expect(res.body.node).not.toBeNull();
    expect(res.body.node.id).toBe('node-1');
    expect(res.body.node.name).toBe('testFunction');
    expect(res.body).toHaveProperty('relations');
    expect(Array.isArray(res.body.relations)).toBe(true);
    expect(res.body.relations).toHaveLength(1);
    expect(res.body.relations[0].type).toBe('CALLS');
  });

  // ── Validation: missing projectId ─────────────────────────────

  it('rejects missing projectId with 400', async () => {
    const store = createMockGraphStore([]);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ nodeId: 'node-1', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ── Validation: missing nodeId ────────────────────────────────

  it('rejects missing nodeId with 400', async () => {
    const store = createMockGraphStore([]);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/nodeId/i);
  });

  // ── Validation: missing time ──────────────────────────────────

  it('rejects missing time with 400', async () => {
    const store = createMockGraphStore([]);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', nodeId: 'node-1' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/time/i);
  });

  // ── format=diff returns diff representation ───────────────────

  it('format=diff returns diff field in response (200)', async () => {
    const mockResults = makeNodeResult('node-1', [
      makeRelProps({ type: 'CALLS' }),
    ]);
    const store = createMockGraphStore(mockResults);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({
        projectId: 'proj-1',
        nodeId: 'node-1',
        time: '2026-06-01T00:00:00Z',
        format: 'diff',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('format', 'diff');
    expect(res.body).toHaveProperty('diff');
    // diff field contains relation change info
    expect(res.body.diff).toHaveProperty('added');
    expect(res.body.diff).toHaveProperty('removed');
  });

  // ── Non-existent node returns 404 ─────────────────────────────

  it('returns 404 for non-existent node at time T', async () => {
    // Empty query result means node was not found
    const store = createMockGraphStore([]);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', nodeId: 'nonexistent', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/not found/i);
  });

  // ── Legacy edges (backward compat) ────────────────────────────

  it('returns 200 for legacy edges (valid_from epoch, valid_to null)', async () => {
    // Legacy edges lack bi-temporal attrs. findNodeAsOf uses coalesce to
    // treat them as valid from EPOCH to FAR_FUTURE.
    // The mock returns a node with a legacy relation (no valid_from/valid_to).
    const mockResults = [
      {
        n: {
          properties: {
            id: 'legacy-node',
            name: 'legacyFunc',
            type: 'Function',
            projectId: 'proj-1',
          },
        },
        rels: [
          {
            // Legacy relation: no valid_from, valid_to, txn_from, txn_to
            sourceId: 'legacy-node',
            targetId: 'other-node',
            type: 'IMPORTS',
            valid_from: null,
            valid_to: null,
            txn_from: null,
            txn_to: null,
          },
        ],
      },
    ];
    const store = createMockGraphStore(mockResults);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', nodeId: 'legacy-node', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.node).not.toBeNull();
    expect(res.body.node.id).toBe('legacy-node');
    // Legacy relations should still appear (coalesced to epoch/far_future)
    expect(res.body.relations).toHaveLength(1);
    expect(res.body.relations[0].type).toBe('IMPORTS');
    // Bi-temporal attrs should be defaulted
    expect(res.body.relations[0].valid_from).toBeDefined();
    expect(res.body.relations[0].valid_to).toBeNull();
  });

  // ── Relations include bi-temporal metadata ────────────────────

  it('includes bi-temporal metadata in relations', async () => {
    const mockResults = makeNodeResult('node-1', [
      makeRelProps({
        valid_from: '2026-03-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-03-01T00:00:00Z',
        txn_to: null,
      }),
    ]);
    const store = createMockGraphStore(mockResults);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', nodeId: 'node-1', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.relations[0]).toHaveProperty('valid_from', '2026-03-01T00:00:00Z');
    expect(res.body.relations[0]).toHaveProperty('valid_to', null);
    expect(res.body.relations[0]).toHaveProperty('txn_from', '2026-03-01T00:00:00Z');
  });

  // ── Node with no relations ────────────────────────────────────

  it('returns node with empty relations array when node has no relations', async () => {
    const mockResults = makeNodeResult('solo-node', []);
    const store = createMockGraphStore(mockResults);
    const app = createTestApp(store);

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId: 'proj-1', nodeId: 'solo-node', time: '2026-06-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.node).not.toBeNull();
    expect(res.body.relations).toEqual([]);
  });
});
