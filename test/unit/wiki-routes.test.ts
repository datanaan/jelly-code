/**
 * Unit Tests: Wiki REST API Routes
 *
 * Tests all 8 wiki REST endpoints with mock wikiService.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import type { WikiService } from '../../src/wiki/service.js';
import type { WikiEntity } from '../../src/wiki/models.js';

const TPID = 'test-project';

// Helper to create a mock WikiService
function createMockWikiService() {
  return {
    startIngest: vi.fn().mockReturnValue('task-ingest-123'),
    startBatchIngest: vi.fn().mockReturnValue('task-batch-123'),
    startBatchIngestContent: vi.fn().mockReturnValue('task-batch-content-123'),
    query: vi.fn().mockResolvedValue('Synthesized answer about X'),
    getIndex: vi.fn().mockResolvedValue({
      entities: [{ id: 'test-entity', name: 'TestEntity', type: 'concept', linkCount: 2 }],
      sources: [{ id: 'source-test', title: 'Test Doc', entityCount: 1 }],
      topics: [{ id: 'topic-1', title: 'Topic 1' }],
    }),
    status: vi.fn().mockResolvedValue({
      compiled: [{ path: '/test.md', sourceId: 'source-test', compiledAt: '2026-01-01T00:00:00.000Z' }],
      uncompiled: [{ path: '/uncompiled.md' }],
      total: 2,
    }),
    lint: vi.fn().mockResolvedValue([
      { type: 'orphan', entityId: 'orphan-1', entityName: 'OrphanEntity', description: 'No links', severity: 'warning' },
    ]),
    syncToJelly: vi.fn().mockResolvedValue({
      pagesSynced: 5,
      errors: [],
    }),
    getEntity: vi.fn().mockImplementation(async (projectId: string, id: string) => {
      if (id === 'test-entity') {
        return {
          id: 'test-entity',
          projectId: TPID,
          name: 'TestEntity',
          entityType: 'concept',
          definition: 'A test entity',
          details: 'Details here',
          firstCompiled: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-02T00:00:00.000Z',
        } as WikiEntity;
      }
      return null;
    }),
    listEntities: vi.fn().mockResolvedValue([]),
    fuzzyMatch: vi.fn().mockResolvedValue([]),
    getActiveTasks: vi.fn().mockReturnValue(new Map()),
  } as unknown as WikiService;
}

// Helper to create a test app with wiki routes
function createTestApp(wikiService: WikiService) {
  const app = express();
  app.use(express.json());
  app.use('/api/wiki', createWikiRoutes(wikiService));
  return app;
}

describe('Wiki REST Routes', () => {
  let wikiService: ReturnType<typeof createMockWikiService>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    wikiService = createMockWikiService();
    app = createTestApp(wikiService);
  });

  // ========================================
  // POST /api/wiki/ingest
  // ========================================
  describe('POST /api/wiki/ingest', () => {
    it('should ingest a source file', async () => {
      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({ projectId: 'test-project', source_path: '/docs/spec.md' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('taskId');
      expect(res.body).toHaveProperty('status', 'processing');
      
      expect(wikiService.startIngest).toHaveBeenCalledWith('test-project', '/docs/spec.md', undefined);
    });

    it('should return 400 when source_path is missing', async () => {
      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 500 on ingest error', async () => {
      wikiService.startIngest.mockImplementationOnce(() => { throw new Error('File not found'); });

      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({ projectId: 'test-project', source_path: '/missing.md' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error', 'File not found');
    });
  });

  // ========================================
  // POST /api/wiki/batch-ingest
  // ========================================
  describe('POST /api/wiki/batch-ingest', () => {
    it('should batch ingest a directory', async () => {
      const res = await request(app)
        .post('/api/wiki/batch-ingest')
        .send({ projectId: 'test-project', dir: '/docs', pattern: '**/*.md' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'processing');
      expect(wikiService.startBatchIngest).toHaveBeenCalledWith('test-project', '/docs', '**/*.md');
    });

    it('should batch ingest with default pattern when not specified', async () => {
      const res = await request(app)
        .post('/api/wiki/batch-ingest')
        .send({ projectId: 'test-project', dir: '/docs' });

      expect(res.status).toBe(200);
      expect(wikiService.startBatchIngest).toHaveBeenCalledWith('test-project', '/docs', undefined);
    });

    it('should return 400 when dir is missing', async () => {
      const res = await request(app)
        .post('/api/wiki/batch-ingest')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ========================================
  // POST /api/wiki/query
  // ========================================
  describe('POST /api/wiki/query', () => {
    it('should query the wiki', async () => {
      const res = await request(app)
        .post('/api/wiki/query')
        .send({ projectId: 'test-project', question: 'What is X?' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('answer', 'Synthesized answer about X');
      expect(wikiService.query).toHaveBeenCalledWith('test-project', 'What is X?', undefined);
    });

    it('should pass write_back option', async () => {
      const res = await request(app)
        .post('/api/wiki/query')
        .send({ projectId: 'test-project', question: 'What is Y?', write_back: true });

      expect(res.status).toBe(200);
      expect(wikiService.query).toHaveBeenCalledWith('test-project', 'What is Y?', true);
    });

    it('should return 400 when question is missing', async () => {
      const res = await request(app)
        .post('/api/wiki/query')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ========================================
  // GET /api/wiki/index
  // ========================================
  describe('GET /api/wiki/index', () => {
    it('should return wiki index', async () => {
      const res = await request(app)
        .get('/api/wiki/index?projectId=test-project');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entities');
      expect(res.body).toHaveProperty('sources');
      expect(res.body).toHaveProperty('topics');
      expect(res.body.entities).toHaveLength(1);
      expect(res.body.sources).toHaveLength(1);
      expect(res.body.topics).toHaveLength(1);
    });
  });

  // ========================================
  // GET /api/wiki/status
  // ========================================
  describe('GET /api/wiki/status', () => {
    it('should return status without dir', async () => {
      const res = await request(app)
        .get('/api/wiki/status?projectId=test-project');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('compiled');
      expect(res.body).toHaveProperty('uncompiled');
      expect(res.body).toHaveProperty('total', 2);
      expect(wikiService.status).toHaveBeenCalledWith('test-project', undefined);
    });

    it('should pass dir query parameter', async () => {
      const res = await request(app)
        .get('/api/wiki/status?projectId=test-project&dir=/docs');

      expect(res.status).toBe(200);
      expect(wikiService.status).toHaveBeenCalledWith('test-project', '/docs');
    });
  });

  // ========================================
  // POST /api/wiki/lint
  // ========================================
  describe('POST /api/wiki/lint', () => {
    it('should return lint issues', async () => {
      const res = await request(app)
        .post('/api/wiki/lint')
        .send({ projectId: 'test-project' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('issues');
      expect(res.body).toHaveProperty('count', 1);
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toHaveProperty('type', 'orphan');
    });
  });

  // ========================================
  // POST /api/wiki/sync
  // ========================================
  describe('POST /api/wiki/sync', () => {
    it('should sync to Jelly KB', async () => {
      const res = await request(app)
        .post('/api/wiki/sync')
        .send({ projectId: 'test-project', kb_id: 'kb-123' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('pagesSynced', 5);
      expect(res.body).toHaveProperty('errors');
      expect(wikiService.syncToJelly).toHaveBeenCalledWith('test-project', 'kb-123');
    });

    it('should return 400 when kb_id is missing', async () => {
      const res = await request(app)
        .post('/api/wiki/sync')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ========================================
  // GET /api/wiki/entity/:id
  // ========================================
  describe('GET /api/wiki/entity/:id', () => {
    it('should return entity by id', async () => {
      const res = await request(app)
        .get('/api/wiki/entity/test-entity?projectId=test-project');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id', 'test-entity');
      expect(res.body).toHaveProperty('name', 'TestEntity');
      expect(res.body).toHaveProperty('entityType', 'concept');
    });

    it('should return 404 for non-existent entity', async () => {
      const res = await request(app)
        .get('/api/wiki/entity/nonexistent?projectId=test-project');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Entity not found');
    });
  });
});
