/**
 * E2E Test: P0b Auto Document Discovery
 *
 * Validates the document discovery pipeline against a realistic fixture repo:
 *   discoverDocs → walkRepositoryPaths (P0a) → classifyFile (T1 three-layer)
 *
 * Coverage:
 * 1. All document types found: .md, .rst, README (bare), CHANGELOG (bare),
 *    LICENSE (bare), docs/ subdir contents
 * 2. Source code excluded: .ts, .js, .py, .json
 * 3. .jellyignore respected: secret-docs/ pattern excluded
 * 4. Monorepo detection: detectRepoStructure returns moduleReadmes for
 *    packages/a/README.md and packages/b/README.md
 * 5. HTTP routing: POST /api/wiki/auto-discover returns discovered list
 * 6. Three-layer classifier: .txt with markdown content discovered,
 *    .txt without markdown excluded
 *
 * Prerequisites: None (pure filesystem + Express, no Neo4j/Typesense/Qdrant).
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p0b-auto-doc-discovery.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import express from 'express';
import request from 'supertest';

import { discoverDocs } from '../../src/wiki/doc-discovery.js';
import { detectRepoStructure } from '../../src/wiki/doc-discovery.js';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import type { WikiService } from '../../src/wiki/service.js';
import { skipE2E, makeTempDir, writeFixtureFile } from './helpers.js';

// ─── E2E gate ───────────────────────────────────────────────────────────────
// (skipE2E imported from helpers.ts)

/**
 * Minimal mock WikiService — the auto-discover route calls discoverDocs
 * directly (not WikiService methods), but createWikiRoutes requires a
 * WikiService argument for the other routes.
 */
function createMockWikiService(): WikiService {
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

describe.skipIf(skipE2E)('P0b E2E: Auto Document Discovery', () => {
  let repoDir: string;

  beforeAll(() => {
    // ── Build a realistic fixture repo ────────────────────────────────
    repoDir = makeTempDir('p0b-e2e');

    // --- Documents that SHOULD be discovered ---

    // Markdown files (Layer 1: extension)
    writeFixtureFile(repoDir, 'README.md', '# Test Repo\n\nA comprehensive test fixture.\n');
    writeFixtureFile(repoDir, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n- Initial release\n');
    writeFixtureFile(repoDir, 'docs/guide.md', '# Guide\n\nHow to use this project.\n');
    writeFixtureFile(repoDir, 'docs/api-reference.md', '# API Reference\n\n## Methods\n');
    writeFixtureFile(repoDir, 'docs/examples/intro.md', '# Examples\n\nSample usage.\n');

    // RST file (Layer 1: extension)
    writeFixtureFile(repoDir, 'docs/architecture.rst', 'Architecture\n============\n\nOverview.\n');

    // Bare filename docs (Layer 2: filename whitelist)
    writeFixtureFile(repoDir, 'LICENSE', 'MIT License\n\nCopyright (c) 2026 Test.\n');
    writeFixtureFile(repoDir, 'CONTRIBUTING', '# Contributing\n\nGuidelines.\n');

    // --- Source code that should NOT be discovered ---
    writeFixtureFile(repoDir, 'src/index.ts', 'export const hello = "world";\n');
    writeFixtureFile(repoDir, 'src/utils.js', 'export function add(a, b) { return a + b; }\n');
    writeFixtureFile(repoDir, 'scripts/run.py', 'print("hello")\n');
    writeFixtureFile(repoDir, 'package.json', '{"name":"test-repo","version":"1.0.0"}\n');
    writeFixtureFile(repoDir, 'tsconfig.json', '{"compilerOptions":{}}\n');

    // --- Three-layer classifier: .txt files ---
    // .txt WITH markdown content → discovered (Layer 3: content heuristics)
    writeFixtureFile(repoDir, 'NOTES.txt', '# Notes\n\nThis is markdown.\n\n```ts\nconst x = 1;\n```\n');
    // .txt WITHOUT markdown content → NOT discovered
    writeFixtureFile(repoDir, 'data.txt', 'apple banana cherry\ndate elderberry fig\n');

    // --- .jellyignore: secret-docs/ excluded ---
    writeFixtureFile(repoDir, '.jellyignore', [
      '# Custom ignore for secret docs',
      'secret-docs/',
      '',
    ].join('\n'));
    writeFixtureFile(repoDir, 'secret-docs/internal.md', '# Internal Secrets\n\nDo not ingest.\n');
    writeFixtureFile(repoDir, 'secret-docs/roadmap.md', '# Roadmap\n\nConfidential.\n');

    // --- Monorepo structure ---
    writeFixtureFile(repoDir, 'packages/a/package.json', '{"name":"@test/a","version":"1.0.0"}\n');
    writeFixtureFile(repoDir, 'packages/a/index.ts', 'export const a = 1;\n');
    writeFixtureFile(repoDir, 'packages/a/README.md', '# Package A\n\nFirst package.\n');
    writeFixtureFile(repoDir, 'packages/b/package.json', '{"name":"@test/b","version":"1.0.0"}\n');
    writeFixtureFile(repoDir, 'packages/b/index.ts', 'export const b = 2;\n');
    writeFixtureFile(repoDir, 'packages/b/README.md', '# Package B\n\nSecond package.\n');

    // Workspace config (makes it a monorepo)
    writeFixtureFile(repoDir, 'package.json', JSON.stringify({
      name: 'test-monorepo',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
    }) + '\n');

    // --- Additional docs deep in docs/ ---
    writeFixtureFile(repoDir, 'docs/nested/deep/guide.md', '# Deep Guide\n\nNested content.\n');
  }, 30_000);

  afterAll(() => {
    if (repoDir && process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ── 1. Document types discovered ───────────────────────────────────

  it('discovers .md files (Layer 1: extension)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('CHANGELOG.md');
    expect(paths).toContain('docs/guide.md');
    expect(paths).toContain('docs/api-reference.md');
  });

  it('discovers .rst files (Layer 1: extension)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('docs/architecture.rst');
  });

  it('discovers bare README/LICENSE/CONTRIBUTING (Layer 2: filename)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('CONTRIBUTING');
  });

  it('discovers files inside docs/ directory (Layer 2: doc directory)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('docs/examples/intro.md');
    expect(paths).toContain('docs/nested/deep/guide.md');
  });

  // ── 2. Source code excluded ────────────────────────────────────────

  it('excludes .ts, .js, .py source files', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).not.toContain('src/index.ts');
    expect(paths).not.toContain('src/utils.js');
    expect(paths).not.toContain('scripts/run.py');
  });

  it('excludes .json config files', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).not.toContain('package.json');
    expect(paths).not.toContain('tsconfig.json');
    // Package-level package.json files also excluded
    expect(paths).not.toContain('packages/a/package.json');
    expect(paths).not.toContain('packages/b/package.json');
  });

  // ── 3. .jellyignore respected ──────────────────────────────────────

  it('respects .jellyignore: secret-docs/ excluded', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).not.toContain('secret-docs/internal.md');
    expect(paths).not.toContain('secret-docs/roadmap.md');
  });

  // ── 4. Monorepo detection ──────────────────────────────────────────

  it('detectRepoStructure identifies monorepo with moduleReadmes', async () => {
    const structure = await detectRepoStructure(repoDir);
    expect(structure.isMonorepo).toBe(true);
    expect(structure.docsDir).toBe('docs');
    expect(structure.moduleReadmes).toContain('packages/a/README.md');
    expect(structure.moduleReadmes).toContain('packages/b/README.md');
    expect(structure.moduleReadmes.length).toBe(2);
  });

  it('discoverDocs finds monorepo package READMEs', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('packages/a/README.md');
    expect(paths).toContain('packages/b/README.md');
  });

  // ── 5. Three-layer classifier: .txt content heuristics ─────────────

  it('discovers .txt with markdown content (Layer 3: content heuristics)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('NOTES.txt');

    // Verify classification metadata
    const notes = docs.find((d) => d.path === 'NOTES.txt');
    expect(notes).toBeDefined();
    expect(notes!.classification.isDoc).toBe(true);
    expect(notes!.classification.source).toBe('content');
    expect(notes!.classification.confidence).toBe(0.7);
  });

  it('excludes .txt without markdown content (Layer 3: fails threshold)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map((d) => d.path);
    expect(paths).not.toContain('data.txt');
  });

  // ── 6. HTTP routing: POST /api/wiki/auto-discover ──────────────────

  it('POST /api/wiki/auto-discover returns discovered list via HTTP', async () => {
    const wikiService = createMockWikiService();
    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(wikiService));

    const res = await request(app)
      .post('/api/wiki/auto-discover')
      .send({ projectId: 'test-p0b', repoPath: repoDir });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('discovered');
    expect(res.body).toHaveProperty('projectId', 'test-p0b');
    expect(res.body).toHaveProperty('count');
    expect(typeof res.body.count).toBe('number');
    expect(res.body.count).toBeGreaterThan(0);

    const paths: string[] = res.body.discovered.map(
      (d: { path: string }) => d.path,
    );
    // Spot-check key docs are present
    expect(paths).toContain('README.md');
    expect(paths).toContain('docs/guide.md');
    expect(paths).toContain('packages/a/README.md');
    expect(paths).toContain('NOTES.txt');

    // Source code absent
    expect(paths).not.toContain('src/index.ts');
    expect(paths).not.toContain('package.json');

    // Secret docs absent (jellyignore)
    expect(paths).not.toContain('secret-docs/internal.md');

    // Each discovered doc has classification metadata
    for (const doc of res.body.discovered) {
      expect(doc).toHaveProperty('path');
      expect(doc).toHaveProperty('size');
      expect(doc).toHaveProperty('classification');
      expect(doc.classification).toHaveProperty('isDoc', true);
      expect(doc.classification).toHaveProperty('confidence');
      expect(doc.classification).toHaveProperty('source');
    }
  });

  it('POST /api/wiki/auto-discover rejects missing repoPath with 400', async () => {
    const wikiService = createMockWikiService();
    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(wikiService));

    const res = await request(app)
      .post('/api/wiki/auto-discover')
      .send({ projectId: 'test-p0b' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/repoPath/i);
  });

  // ── Overall sanity ─────────────────────────────────────────────────

  it('discoverDocs returns sorted, non-empty results with metadata', async () => {
    const docs = await discoverDocs(repoDir);

    expect(docs.length).toBeGreaterThan(8); // Rich fixture

    // Sorted by path (discoverDocs uses localeCompare)
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i].path.localeCompare(docs[i - 1].path)).toBeGreaterThanOrEqual(0);
    }

    // Every doc has the expected shape
    for (const doc of docs) {
      expect(typeof doc.path).toBe('string');
      expect(typeof doc.size).toBe('number');
      expect(doc.size).toBeGreaterThan(0);
      expect(doc.classification.isDoc).toBe(true);
      expect(doc.classification.confidence).toBeGreaterThan(0);
    }
  });

  // ── Edge cases ─────────────────────────────────────────────────────
  it('discoverDocs on empty repo returns empty result', async () => {
    const emptyDir = makeTempDir('p0b-empty');
    const docs = await discoverDocs(emptyDir);
    expect(docs).toEqual([]);
    if (process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('discoverDocs on non-existent path returns empty result', async () => {
    const docs = await discoverDocs('/tmp/non-existent-path-12345');
    expect(docs).toEqual([]);
  });
});
