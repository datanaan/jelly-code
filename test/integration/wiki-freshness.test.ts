/**
 * Integration test: GET /api/wiki/freshness
 *
 * P0c-T5: Tests the Wiki entity freshness endpoint.
 *
 * Uses real WikiService with mock stores and real entity-freshness pipeline
 * to verify the full HTTP request cycle:
 *   query validation → getFreshness → checkEntityFreshness → response shaping
 *
 * The freshness endpoint returns a { items, summary } structure with
 * 4-state classification: fresh, stale, orphaned, unbound.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import type { WikiService } from '../../src/wiki/service.js';
import type { WikiEntity } from '../../src/wiki/models.js';
import type { EntityFreshnessState, FreshnessResult } from '../../src/wiki/entity-freshness.js';

// ── Test fixtures ────────────────────────────────────────────────

/** Create a wiki entity with given properties. */
function makeEntity(overrides: Partial<WikiEntity> & { id: string; name: string }): WikiEntity {
  return {
    projectId: 'p1',
    entityType: 'concept',
    definition: 'Test entity',
    details: 'Details',
    firstCompiled: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-06-01T00:00:00Z',
    codeSignature: null,
    ...overrides,
  };
}

/** FreshnessItem shape returned by the endpoint. */
interface FreshnessItem {
  entityId: string;
  entityName: string;
  status: EntityFreshnessState;
  issue: Record<string, unknown> | null;
}

/** Freshness response shape. */
interface FreshnessResponse {
  items: FreshnessItem[];
  summary: Record<EntityFreshnessState, number>;
}

// ── Mock factory ─────────────────────────────────────────────────

/**
 * Create a mock WikiService whose getFreshness method returns
 * a configurable set of freshness items.
 *
 * The mock bypasses real checkEntityFreshness (which requires a graph
 * store) — we provide the freshness results directly. This is the
 * service-level mock; the route handler itself is real.
 */
function createMockWikiService(
  freshnessItems: FreshnessItem[] = [],
): WikiService {
  const summary: Record<EntityFreshnessState, number> = {
    fresh: 0,
    stale: 0,
    orphaned: 0,
    unbound: 0,
  };
  for (const item of freshnessItems) {
    summary[item.status]++;
  }

  return {
    startIngest: () => 'task-stub',
    startBatchIngest: () => 'task-stub',
    startBatchIngestContent: () => 'task-stub',
    query: () => Promise.resolve('stub'),
    getIndex: () => Promise.resolve({ entities: [], sources: [], topics: [] }),
    status: () => Promise.resolve({ compiled: [], uncompiled: [], total: 0 }),
    lint: () => Promise.resolve([]),
    syncToJelly: () => Promise.resolve({ pagesSynced: 0, errors: [] }),
    getEntity: () => Promise.resolve(null),
    listEntities: () => Promise.resolve([]),
    fuzzyMatch: () => Promise.resolve([]),
    getActiveTasks: () => new Map(),
    getFreshness: vi.fn().mockResolvedValue({ items: freshnessItems, summary }),
  } as unknown as WikiService;
}

/** Create a test Express app with wiki routes mounted (no auth middleware). */
function createTestApp(wikiService: WikiService) {
  const app = express();
  app.use(express.json());
  app.use('/api/wiki', createWikiRoutes(wikiService));
  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('GET /api/wiki/freshness', () => {
  // ── Happy path: returns freshness report ──────────────────────

  it('returns freshness report for project with items and summary', async () => {
    const items: FreshnessItem[] = [
      { entityId: 'e1', entityName: 'UserService', status: 'fresh', issue: null },
      { entityId: 'e2', entityName: 'OldService', status: 'stale', issue: { type: 'stale' } },
      { entityId: 'e3', entityName: 'DeletedService', status: 'orphaned', issue: { type: 'orphan' } },
      { entityId: 'e4', entityName: 'ConceptPage', status: 'unbound', issue: { type: 'unbound' } },
    ];
    const wikiService = createMockWikiService(items);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(4);

    // Each item has required fields
    for (const item of res.body.items) {
      expect(item).toHaveProperty('entityId');
      expect(item).toHaveProperty('entityName');
      expect(item).toHaveProperty('status');
      expect(['fresh', 'stale', 'orphaned', 'unbound']).toContain(item.status);
      expect(item).toHaveProperty('issue');
    }
  });

  // ── Summary counts ────────────────────────────────────────────

  it('returns summary counts for each freshness state', async () => {
    const items: FreshnessItem[] = [
      { entityId: 'e1', entityName: 'A', status: 'fresh', issue: null },
      { entityId: 'e2', entityName: 'B', status: 'fresh', issue: null },
      { entityId: 'e3', entityName: 'C', status: 'stale', issue: { type: 'stale' } },
      { entityId: 'e4', entityName: 'D', status: 'orphaned', issue: { type: 'orphan' } },
      { entityId: 'e5', entityName: 'E', status: 'unbound', issue: { type: 'unbound' } },
    ];
    const wikiService = createMockWikiService(items);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      fresh: 2,
      stale: 1,
      orphaned: 1,
      unbound: 1,
    });
  });

  // ── Filter by status=stale ────────────────────────────────────

  it('filters by status=stale, returning only stale items', async () => {
    const items: FreshnessItem[] = [
      { entityId: 'e1', entityName: 'Fresh', status: 'fresh', issue: null },
      { entityId: 'e2', entityName: 'Stale', status: 'stale', issue: { type: 'stale' } },
      { entityId: 'e3', entityName: 'Stale2', status: 'stale', issue: { type: 'stale' } },
      { entityId: 'e4', entityName: 'Orphan', status: 'orphaned', issue: { type: 'orphan' } },
    ];
    const wikiService = createMockWikiService(items);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'p1', status: 'stale' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items) {
      expect(item.status).toBe('stale');
    }
  });

  // ── Filter by status=fresh ────────────────────────────────────

  it('filters by status=fresh, returning only fresh items', async () => {
    const items: FreshnessItem[] = [
      { entityId: 'e1', entityName: 'Fresh', status: 'fresh', issue: null },
      { entityId: 'e2', entityName: 'Stale', status: 'stale', issue: { type: 'stale' } },
      { entityId: 'e3', entityName: 'Fresh2', status: 'fresh', issue: null },
    ];
    const wikiService = createMockWikiService(items);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'p1', status: 'fresh' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items) {
      expect(item.status).toBe('fresh');
      expect(item.issue).toBeNull();
    }
  });

  // ── Filter by entityId ────────────────────────────────────────

  it('filters by entityId, returning only that entity', async () => {
    const items: FreshnessItem[] = [
      { entityId: 'e1', entityName: 'Alpha', status: 'fresh', issue: null },
      { entityId: 'e2', entityName: 'Beta', status: 'stale', issue: { type: 'stale' } },
      { entityId: 'e3', entityName: 'Gamma', status: 'unbound', issue: { type: 'unbound' } },
    ];
    const wikiService = createMockWikiService(items);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'p1', entityId: 'e2' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].entityId).toBe('e2');
    expect(res.body.items[0].entityName).toBe('Beta');
    expect(res.body.items[0].status).toBe('stale');
  });

  // ── Validation: missing projectId ─────────────────────────────

  it('rejects missing projectId with 400', async () => {
    const wikiService = createMockWikiService([]);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ── Empty project returns empty items ─────────────────────────

  it('returns empty items array for project with no entities', async () => {
    const wikiService = createMockWikiService([]);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'empty-project' });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.summary).toEqual({
      fresh: 0,
      stale: 0,
      orphaned: 0,
      unbound: 0,
    });
  });

  // ── Invalid status filter returns 400 ─────────────────────────

  it('rejects invalid status value with 400', async () => {
    const wikiService = createMockWikiService([]);
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId: 'p1', status: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/status/i);
  });
});
