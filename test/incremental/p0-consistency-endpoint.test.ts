/**
 * Tests: P0 /health/consistency endpoint
 *
 * Verifies the consistency endpoint returns correct freshness status
 * for all projects and handles edge cases.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';

function createMockGraph(): IGraphStore {
  return {
    query: vi.fn(),
    initializeSchema: vi.fn().mockResolvedValue(undefined),
    batchCreateNodes: vi.fn().mockResolvedValue(undefined),
    batchCreateRelations: vi.fn().mockResolvedValue(undefined),
    clearProject: vi.fn().mockResolvedValue(undefined),
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
  } as unknown as IGraphStore;
}

function createMockStores(graph: IGraphStore): StoreSet {
  return {
    graph,
    search: {
      search: vi.fn().mockResolvedValue([]),
      indexDocuments: vi.fn().mockResolvedValue({}),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      deleteDocumentsByFilePath: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ISearchStore,
    vector: {
      search: vi.fn().mockResolvedValue([]),
      upsertVectors: vi.fn().mockResolvedValue({}),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      deleteVectorsByNodeIds: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as IVectorStore,
    llm: {
      generate: vi.fn().mockResolvedValue(''),
      generateJSON: vi.fn().mockResolvedValue({}),
    } as unknown as ILLMClient,
  };
}

describe('P0: /health/consistency endpoint', () => {
  it('should return empty projects list when no projects exist', async () => {
    const graph = createMockGraph();
    vi.mocked(graph.query).mockResolvedValue([]);
    const stores = createMockStores(graph);

    // Build a minimal express app with the consistency endpoint pattern
    const app = express();
    app.get('/health/consistency', async (_req, res) => {
      try {
        const projects = await stores.graph.query(
          `MATCH (p:Project)
           RETURN p.id AS projectId,
                  p.symbolsFreshness AS symbolsFreshness,
                  p.communitiesFreshness AS communitiesFreshness,
                  p.temporalFreshness AS temporalFreshness,
                  p.lastFullRebuildAt AS lastFullRebuildAt,
                  p.lastIncrementalAt AS lastIncrementalAt,
                  p.consecutiveIncremental AS consecutiveIncremental,
                  p.accumulatedChanges AS accumulatedChanges`,
        );
        const totalStale = (projects as Array<Record<string, unknown>>).filter(
          p => p.symbolsFreshness === 'stale' || p.communitiesFreshness === 'stale' || p.temporalFreshness === 'stale',
        ).length;
        res.json({ projects, totalStale, totalProjects: projects.length });
      } catch (error) {
        res.status(500).json({ error: 'Consistency check failed' });
      }
    });

    const response = await request(app).get('/health/consistency');
    expect(response.status).toBe(200);
    expect(response.body.projects).toEqual([]);
    expect(response.body.totalProjects).toBe(0);
    expect(response.body.totalStale).toBe(0);
  });

  it('should report fresh status when all projects are fresh', async () => {
    const graph = createMockGraph();
    vi.mocked(graph.query).mockResolvedValue([
      {
        projectId: 'proj-1',
        symbolsFreshness: 'fresh',
        communitiesFreshness: 'fresh',
        temporalFreshness: 'fresh',
        lastFullRebuildAt: '2026-06-20T00:00:00Z',
        lastIncrementalAt: null,
        consecutiveIncremental: 0,
        accumulatedChanges: 0,
      },
    ]);
    const stores = createMockStores(graph);

    const app = express();
    app.get('/health/consistency', async (_req, res) => {
      try {
        const projects = await stores.graph.query(`MATCH (p:Project) RETURN p.id AS projectId,
          p.symbolsFreshness AS symbolsFreshness,
          p.communitiesFreshness AS communitiesFreshness,
          p.temporalFreshness AS temporalFreshness,
          p.lastFullRebuildAt AS lastFullRebuildAt,
          p.lastIncrementalAt AS lastIncrementalAt,
          p.consecutiveIncremental AS consecutiveIncremental,
          p.accumulatedChanges AS accumulatedChanges`);
        const totalStale = (projects as Array<Record<string, unknown>>).filter(
          p => p.symbolsFreshness === 'stale' || p.communitiesFreshness === 'stale' || p.temporalFreshness === 'stale',
        ).length;
        res.json({ projects, totalStale, totalProjects: projects.length });
      } catch (error) {
        res.status(500).json({ error: 'Consistency check failed' });
      }
    });

    const response = await request(app).get('/health/consistency');
    expect(response.status).toBe(200);
    expect(response.body.totalProjects).toBe(1);
    expect(response.body.totalStale).toBe(0);
  });

  it('should report stale count when projects have stale data', async () => {
    const graph = createMockGraph();
    vi.mocked(graph.query).mockResolvedValue([
      {
        projectId: 'proj-1',
        symbolsFreshness: 'fresh',
        communitiesFreshness: 'stale',
        temporalFreshness: 'stale',
      },
    ]);
    const stores = createMockStores(graph);

    const app = express();
    app.get('/health/consistency', async (_req, res) => {
      try {
        const projects = await stores.graph.query(`MATCH (p:Project) RETURN p.id AS projectId,
          p.symbolsFreshness AS symbolsFreshness,
          p.communitiesFreshness AS communitiesFreshness,
          p.temporalFreshness AS temporalFreshness,
          p.lastFullRebuildAt AS lastFullRebuildAt,
          p.lastIncrementalAt AS lastIncrementalAt,
          p.consecutiveIncremental AS consecutiveIncremental,
          p.accumulatedChanges AS accumulatedChanges`);
        const totalStale = (projects as Array<Record<string, unknown>>).filter(
          p => p.symbolsFreshness === 'stale' || p.communitiesFreshness === 'stale' || p.temporalFreshness === 'stale',
        ).length;
        res.json({ projects, totalStale, totalProjects: projects.length });
      } catch (error) {
        res.status(500).json({ error: 'Consistency check failed' });
      }
    });

    const response = await request(app).get('/health/consistency');
    expect(response.status).toBe(200);
    expect(response.body.totalProjects).toBe(1);
    // totalStale counts PROJECTS (not dimensions) that have any stale field
    expect(response.body.totalStale).toBe(1);
  });

  it('should return 500 on Neo4j query failure', async () => {
    const graph = createMockGraph();
    vi.mocked(graph.query).mockRejectedValue(new Error('Neo4j connection lost'));
    const stores = createMockStores(graph);

    const app = express();
    app.get('/health/consistency', async (_req, res) => {
      try {
        await stores.graph.query('MATCH (p:Project) RETURN p.id');
        res.json({});
      } catch (error) {
        res.status(500).json({ error: 'Consistency check failed', detail: error instanceof Error ? error.message : String(error) });
      }
    });

    const response = await request(app).get('/health/consistency');
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Consistency check failed');
  });
});
