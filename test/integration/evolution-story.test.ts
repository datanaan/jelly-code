/**
 * Integration test: POST + GET /api/wiki/evolution-story
 *
 * P2-T5: Tests the code evolution story endpoints.
 *
 * POST /api/wiki/evolution-story — starts async generation, returns { taskId }
 * GET /api/wiki/evolution-story/:topicId — returns stored narrative
 *
 * Uses mock WikiService to isolate HTTP layer testing from the
 * LLM/graph dependencies. The route handler validation and response
 * shaping is what we verify here.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import type { WikiService } from '../../src/wiki/service.js';
import type { WikiTopic } from '../../src/wiki/models.js';

// ── Test fixtures ────────────────────────────────────────────────

/** A stored evolution story topic for retrieval tests. */
const MOCK_TOPIC: WikiTopic = {
  id: 'topic-evolution-1234567890-abc123',
  projectId: 'p1',
  title: 'myFunction 演化史',
  content: '# Evolution of myFunction\n\n## Founding Phase\n\nCreated in commit abc123...',
  compiledAt: '2026-06-21T10:00:00Z',
  topicType: 'evolution',
};

// ── Mock factory ─────────────────────────────────────────────────

/**
 * Create a mock WikiService for evolution-story endpoint tests.
 *
 * - startEvolutionStoryGeneration: returns a fake taskId
 * - generateEvolutionStory: returns the stored MOCK_TOPIC
 * - getTopic: returns a topic by ID (or null if not found)
 */
function createMockWikiService(overrides: {
  topicStore?: Map<string, WikiTopic>;
  generateResult?: WikiTopic;
} = {}): WikiService {
  const topicStore = overrides.topicStore ?? new Map<string, WikiTopic>([[MOCK_TOPIC.id, MOCK_TOPIC]]);
  const generateResult = overrides.generateResult ?? MOCK_TOPIC;

  return {
    startIngest: () => 'task-stub',
    startBatchIngest: () => 'task-stub',
    startBatchIngestContent: () => 'task-stub',
    startAutoDiscover: () => 'task-stub',
    startEvolutionStoryGeneration: vi.fn().mockReturnValue('task-evo-123'),
    generateEvolutionStory: vi.fn().mockResolvedValue(generateResult),
    getTopic: vi.fn((projectId: string, topicId: string) => {
      const topic = topicStore.get(topicId);
      if (topic && topic.projectId === projectId) return Promise.resolve(topic);
      return Promise.resolve(null);
    }),
    query: () => Promise.resolve('stub'),
    getIndex: () => Promise.resolve({ entities: [], sources: [], topics: [] }),
    status: () => Promise.resolve({ compiled: [], uncompiled: [], total: 0 }),
    lint: () => Promise.resolve([]),
    syncToJelly: () => Promise.resolve({ pagesSynced: 0, errors: [] }),
    getEntity: () => Promise.resolve(null),
    listEntities: () => Promise.resolve([]),
    fuzzyMatch: () => Promise.resolve([]),
    getActiveTasks: () => new Map(),
    getFreshness: () => Promise.resolve({ items: [], summary: { fresh: 0, stale: 0, orphaned: 0, unbound: 0 } }),
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

describe('POST /api/wiki/evolution-story', () => {
  it('returns 200 with taskId when valid projectId + nodeId provided', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId: 'p1', nodeId: 'fn:myFunction' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('taskId');
    expect(typeof res.body.taskId).toBe('string');
    expect(res.body.taskId.length).toBeGreaterThan(0);
    // Verify the service method was called with correct args
    expect(wikiService.startEvolutionStoryGeneration).toHaveBeenCalledWith('p1', 'fn:myFunction');
  });

  it('rejects missing projectId with 400', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ nodeId: 'fn:myFunction' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/projectId/i);
  });

  it('rejects missing nodeId with 400', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId: 'p1' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/nodeId/i);
  });

  it('includes projectId in response', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId: 'p1', nodeId: 'fn:myFunction' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('projectId', 'p1');
  });
});

describe('GET /api/wiki/evolution-story/:topicId', () => {
  it('returns 200 with stored narrative for valid topicId', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get(`/api/wiki/evolution-story/${MOCK_TOPIC.id}`)
      .query({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', MOCK_TOPIC.id);
    expect(res.body).toHaveProperty('content');
    expect(typeof res.body.content).toBe('string');
    expect(res.body.content.length).toBeGreaterThan(0);
    // Should contain markdown narrative
    expect(res.body.content).toContain('#');
  });

  it('returns 404 for non-existent topicId', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get('/api/wiki/evolution-story/nonexistent-topic-id')
      .query({ projectId: 'p1' });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('response has content field with markdown narrative', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get(`/api/wiki/evolution-story/${MOCK_TOPIC.id}`)
      .query({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    // Markdown should contain headings or text
    expect(res.body.content).toMatch(/#\s|Founding|Phase|Evolution|Created/i);
  });

  it('includes topicType field in response', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get(`/api/wiki/evolution-story/${MOCK_TOPIC.id}`)
      .query({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topicType', 'evolution');
  });

  it('rejects missing projectId with 400', async () => {
    const wikiService = createMockWikiService();
    const app = createTestApp(wikiService);

    const res = await request(app)
      .get(`/api/wiki/evolution-story/${MOCK_TOPIC.id}`);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/projectId/i);
  });
});
