/**
 * Integration test: POST /api/wiki/auto-discover
 *
 * P0b-T3: Tests the auto-discover endpoint with REAL filesystem operations.
 *
 * Unlike unit tests (which mock discoverDocs), this test creates real temp
 * directories with real files and verifies the full HTTP request cycle:
 *   request validation → discoverDocs → response shaping
 *
 * The route handler imports discoverDocs directly (not via WikiService),
 * so we test the actual discovery pipeline end-to-end through HTTP.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import type { WikiService } from '../../src/wiki/service.js';

/**
 * Create a mock WikiService with minimal stubs.
 *
 * The auto-discover route does NOT call any WikiService methods (it calls
 * discoverDocs directly), but createWikiRoutes requires a WikiService
 * argument for the other routes.
 */
function createMockWikiService() {
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
  } as unknown as WikiService;
}

/** Create a test Express app with wiki routes mounted (no auth middleware). */
function createTestApp(wikiService: WikiService) {
  const app = express();
  app.use(express.json());
  app.use('/api/wiki', createWikiRoutes(wikiService));
  return app;
}

/** Helper: create a unique temp directory. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jelly-auto-discover-'));
}

describe('POST /api/wiki/auto-discover', () => {
  let wikiService: WikiService;
  let app: express.Express;

  beforeEach(() => {
    wikiService = createMockWikiService();
    app = createTestApp(wikiService);
  });

  // ── Happy path: discovers docs in a real repo ──────────────────

  it('returns discovered docs from a real repository', async () => {
    const dir = makeTempDir();
    try {
      // Create a realistic repo structure with docs
      writeFileSync(join(dir, 'README.md'), '# Project\n\nA test project.');
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n\nUsage guide.');
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## v1.0.0');
      // Non-doc file
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1;');

      const res = await request(app)
        .post('/api/wiki/auto-discover')
        .send({ projectId: 'p1', repoPath: dir });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('discovered');
      expect(Array.isArray(res.body.discovered)).toBe(true);
      // Should find 3 docs: README.md, docs/guide.md, CHANGELOG.md
      expect(res.body.discovered.length).toBe(3);

      const paths = res.body.discovered.map((d: { path: string }) => d.path);
      expect(paths).toContain('README.md');
      expect(paths).toContain('docs/guide.md');
      expect(paths).toContain('CHANGELOG.md');
      // Should NOT include source files
      expect(paths).not.toContain('index.ts');

      // Each discovered doc should have classification metadata
      for (const doc of res.body.discovered) {
        expect(doc).toHaveProperty('path');
        expect(doc).toHaveProperty('size');
        expect(doc).toHaveProperty('classification');
        expect(doc.classification).toHaveProperty('isDoc', true);
        expect(doc.classification).toHaveProperty('confidence');
        expect(doc.classification).toHaveProperty('source');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Validation: missing repoPath ───────────────────────────────

  it('rejects missing repoPath with 400', async () => {
    const res = await request(app)
      .post('/api/wiki/auto-discover')
      .send({ projectId: 'p1' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/repoPath/i);
  });

  // ── Validation: missing projectId ──────────────────────────────

  it('rejects missing projectId with 400', async () => {
    const dir = makeTempDir();
    try {
      const res = await request(app)
        .post('/api/wiki/auto-discover')
        .send({ repoPath: dir });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/projectId/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Empty repo returns empty discovered array ──────────────────

  it('returns empty discovered array for empty repo', async () => {
    const dir = makeTempDir();
    try {
      // Create a repo with only non-doc files
      writeFileSync(join(dir, 'main.ts'), 'export const x = 1;');
      writeFileSync(join(dir, 'utils.py'), 'x = 1');

      const res = await request(app)
        .post('/api/wiki/auto-discover')
        .send({ projectId: 'p1', repoPath: dir });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('discovered');
      expect(Array.isArray(res.body.discovered)).toBe(true);
      expect(res.body.discovered.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Non-existent repo path returns 200 with empty discovered ──
  // Design choice: discoverDocs walks the filesystem; a non-existent path
  // yields zero files. We return 200 + empty array rather than 404,
  // because the endpoint's job is discovery, not path validation.
  // The caller can check `discovered.length === 0` to handle this case.

  it('returns empty discovered array for non-existent repo path', async () => {
    const res = await request(app)
      .post('/api/wiki/auto-discover')
      .send({ projectId: 'p1', repoPath: '/tmp/nonexistent-repo-path-12345' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('discovered');
    expect(Array.isArray(res.body.discovered)).toBe(true);
    expect(res.body.discovered.length).toBe(0);
  });

  // ── Response includes projectId in response ────────────────────

  it('includes projectId in the response', async () => {
    const dir = makeTempDir();
    try {
      const res = await request(app)
        .post('/api/wiki/auto-discover')
        .send({ projectId: 'my-project', repoPath: dir });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('projectId', 'my-project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
