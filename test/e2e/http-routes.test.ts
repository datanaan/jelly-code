/**
 * E2E Test: HTTP Routes Coverage
 *
 * Tests the 9 untested wiki HTTP routes for happy path + 400 validation:
 *  1. POST /api/wiki/ingest
 *  2. POST /api/wiki/batch-ingest (content mode)
 *  3. POST /api/wiki/batch-ingest (dir mode)
 *  4. POST /api/wiki/query
 *  5. GET  /api/wiki/index
 *  6. GET  /api/wiki/status
 *  7. POST /api/wiki/lint
 *  8. POST /api/wiki/sync
 *  9. GET  /api/wiki/entity/:id
 * 10. POST /api/wiki/reindex
 * 11. GET  /api/wiki/entity/:id — 404
 *
 * The following routes are already tested in their respective E2E files:
 *  - POST /api/wiki/auto-discover               → p0b
 *  - GET  /api/wiki/freshness                    → p0c
 *  - POST /api/wiki/evolution-story              → p2
 *  - GET  /api/wiki/evolution-story/:topicId     → p2
 *  - GET  /api/code/as-of                        → p1
 *
 * Prerequisites: None (pure Express + mock WikiService)
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/http-routes.test.ts
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import type { WikiService } from '../../src/wiki/service.js';
import { skipE2E } from './helpers.js';

// ─── Comprehensive Mock WikiService ───────────────────────────────────────────
// Covers all methods needed by the wiki routes.

function createMockWikiService(): WikiService {
  return {
    startIngest: () => 'task-ingest-12345',
    startBatchIngest: () => 'task-batch-dir-12345',
    startBatchIngestContent: () => 'task-batch-content-12345',
    query: () => Promise.resolve('Mock answer to the question.'),
    getIndex: () => Promise.resolve({
      entities: [{ id: 'e1', name: 'Entity1', type: 'concept', linkCount: 2 }],
      sources: [{ id: 's1', title: 'Source1', entityCount: 1 }],
      topics: [],
    }),
    status: () => Promise.resolve({
      compiled: ['doc1'], uncompiled: ['doc2'], total: 2,
    }),
    lint: () => Promise.resolve([
      { type: 'stale', entityId: 'e1', description: 'stale entity', severity: 'warning' },
    ]),
    syncToJelly: () => Promise.resolve({ pagesSynced: 3, errors: [] }),
    getEntity: () => Promise.resolve({
      id: 'entity-1', projectId: 'test-pid', name: 'TestEntity',
      entityType: 'concept', definition: 'A test entity',
      details: 'Details', firstCompiled: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z',
      codeSignature: null,
    }),
    reindex: () => Promise.resolve({ reindexed: 5, sources: 2, entities: 3 }),
    getActiveTasks: () => new Map(),
    startEvolutionStoryGeneration: () => 'task-evo-12345',
    getTopic: () => Promise.resolve(null),
    generateEvolutionStory: () => Promise.resolve({
      id: 'topic-1', topicType: 'evolution', title: '演化史',
      content: 'Story', projectId: 'test-pid', compiledAt: '2026-06-01T00:00:00Z',
    }),
  } as unknown as WikiService;
}

describe.skipIf(skipE2E)('HTTP Wiki Routes', () => {
  // Create a fresh app for each test group
  function createApp(service: WikiService) {
    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));
    return app;
  }

  // ─────────────────────────────────────────────────────────────────────
  // 1. POST /api/wiki/ingest
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/ingest returns 200 with taskId', async () => {
    const service = createMockWikiService();
    const app = createApp(service);

    const res = await request(app)
      .post('/api/wiki/ingest')
      .send({ projectId: 'test-pid', source_path: 'docs/test.md', content: '# Test' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('taskId');
    expect(res.body.status).toBe('processing');
    expect(res.body.projectId).toBe('test-pid');
    expect(res.body.sourcePath).toBe('docs/test.md');
  });

  it('POST /api/wiki/ingest rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/ingest')
      .send({ source_path: 'docs/test.md' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  it('POST /api/wiki/ingest rejects missing source_path (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/ingest')
      .send({ projectId: 'test-pid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source_path/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. POST /api/wiki/batch-ingest (content mode)
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/batch-ingest with files array returns 200 + taskId', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/batch-ingest')
      .send({
        projectId: 'test-pid',
        files: [{ source_path: 'doc1.md', content: '# Doc 1' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toMatch(/batch-content-/);
  });

  it('POST /api/wiki/batch-ingest with dir returns 200 + taskId', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/batch-ingest')
      .send({ projectId: 'test-pid', dir: '/path/to/docs', pattern: '*.md' });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toMatch(/batch-/);
  });

  it('POST /api/wiki/batch-ingest rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/batch-ingest')
      .send({ dir: '/path' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  it('POST /api/wiki/batch-ingest rejects missing both dir and files (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/batch-ingest')
      .send({ projectId: 'test-pid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. POST /api/wiki/query
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/query returns 200 with answer', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/query')
      .send({ projectId: 'test-pid', question: 'What is this?' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('answer');
    expect(res.body.answer).toContain('Mock answer');
  });

  it('POST /api/wiki/query rejects missing question (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/query')
      .send({ projectId: 'test-pid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. GET /api/wiki/index
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/index returns 200 with entity list', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .get('/api/wiki/index')
      .query({ projectId: 'test-pid' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entities');
    expect(res.body).toHaveProperty('sources');
    expect(res.body).toHaveProperty('topics');
    expect(Array.isArray(res.body.entities)).toBe(true);
  });

  it('GET /api/wiki/index rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app).get('/api/wiki/index');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. GET /api/wiki/status
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/status returns 200 with compile status', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .get('/api/wiki/status')
      .query({ projectId: 'test-pid' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('compiled');
    expect(res.body).toHaveProperty('uncompiled');
    expect(res.body).toHaveProperty('total');
    expect(res.body.projectId).toBe('test-pid');
  });

  it('GET /api/wiki/status rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app).get('/api/wiki/status');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. POST /api/wiki/lint
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/lint returns 200 with issues array', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/lint')
      .send({ projectId: 'test-pid' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('issues');
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/wiki/lint rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app).post('/api/wiki/lint').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. POST /api/wiki/sync
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/sync returns 200 with sync result', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/sync')
      .send({ projectId: 'test-pid', kb_id: 'test-kb' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pagesSynced');
    expect(res.body.pagesSynced).toBe(3);
  });

  it('POST /api/wiki/sync rejects missing kb_id (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/sync')
      .send({ projectId: 'test-pid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kb_id/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. GET /api/wiki/entity/:id
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/entity/:id returns 200 with entity', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .get('/api/wiki/entity/test-entity')
      .query({ projectId: 'test-pid' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('entityType');
  });

  it('GET /api/wiki/entity/:id rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .get('/api/wiki/entity/test-entity');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. POST /api/wiki/reindex
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/reindex returns 200 with reindex counts', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/reindex')
      .send({ projectId: 'test-pid' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reindexed');
    expect(res.body.reindexed).toBe(5);
  });

  it('POST /api/wiki/reindex rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app).post('/api/wiki/reindex').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. GET /api/wiki/entity/:id — 404
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/entity/:id returns 404 for non-existent entity', async () => {
    // Override mock to return null
    const service = createMockWikiService();
    service.getEntity = () => Promise.resolve(null);

    const app = createApp(service);
    const res = await request(app)
      .get('/api/wiki/entity/non-existent')
      .query({ projectId: 'test-pid' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. POST /api/wiki/evolution-story
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/evolution-story returns 200 with taskId', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId: 'test-pid', nodeId: 'node-foo' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('taskId');
    expect(res.body.taskId).toMatch(/task-evo-/);
    expect(res.body.nodeId).toBe('node-foo');
  });

  it('POST /api/wiki/evolution-story rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ nodeId: 'node-foo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });

  it('POST /api/wiki/evolution-story rejects missing nodeId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId: 'test-pid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nodeId/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. GET /api/wiki/evolution-story/:topicId
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/evolution-story/:topicId returns 200 with topic', async () => {
    const service = createMockWikiService();
    service.getTopic = () => Promise.resolve({
      id: 'topic-evo-1', topicType: 'evolution', title: 'Evo Story',
      content: 'The evolution story...', projectId: 'test-pid',
      compiledAt: '2026-06-01T00:00:00Z',
    });

    const app = createApp(service);
    const res = await request(app)
      .get('/api/wiki/evolution-story/topic-evo-1')
      .query({ projectId: 'test-pid' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('topic-evo-1');
    expect(res.body.topicType).toBe('evolution');
  });

  it('GET /api/wiki/evolution-story/:topicId returns 404 for missing topic', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .get('/api/wiki/evolution-story/topic-nonexistent')
      .query({ projectId: 'test-pid' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('GET /api/wiki/evolution-story/:topicId rejects missing projectId (400)', async () => {
    const app = createApp(createMockWikiService());
    const res = await request(app)
      .get('/api/wiki/evolution-story/topic-evo-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
  });
});
