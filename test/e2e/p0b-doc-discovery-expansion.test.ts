/**
 * E2E Test: P0b Document Discovery Expansion — More Formats + batchIngest
 *
 * Extends the baseline document discovery tests with:
 *  1. .adoc (AsciiDoc) document discovery
 *  2. .org (Org-mode) document discovery
 *  3. .tex (LaTeX) document discovery
 *  4. discoverDocs → batchIngestContent integration
 *  5. Empty repo edge cases
 *  6. Single file repos
 *
 * Prerequisites: None (pure filesystem)
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p0b-doc-discovery-expansion.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import { discoverDocs } from '../../src/wiki/doc-discovery.js';
import { skipE2E, makeTempDir, writeFixtureFile, buildStoreSet, createMockLLM } from './helpers.js';
import { loadConfig } from '../../src/config/index.js';
import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import { WikiService } from '../../src/wiki/service.js';
import type { WikiConfig } from '../../src/wiki/service.js';

describe.skipIf(skipE2E)('P0b E2E Expansion: More Formats + batchIngest', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = makeTempDir('p0b-exp-e2e');

    // ── AsciiDoc documents ──────────────────────────────────────────
    writeFixtureFile(repoDir, 'docs/guide.adoc', '= Guide\n\nThis is an AsciiDoc document.\n\n== Section 1\n\nContent here.\n');
    writeFixtureFile(repoDir, 'docs/api-reference.adoc', '= API Reference\n\n== Endpoints\n\n- GET /users\n');

    // ── Org-mode documents ──────────────────────────────────────────
    writeFixtureFile(repoDir, 'docs/notes.org', '#+TITLE: Notes\n\n* Heading 1\n\nContent.\n');
    writeFixtureFile(repoDir, 'docs/todo.org', '#+TITLE: TODO\n\n* [ ] Task 1\n');

    // ── LaTeX documents ─────────────────────────────────────────────
    writeFixtureFile(repoDir, 'docs/paper.tex', '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n');
    writeFixtureFile(repoDir, 'docs/report.tex', '\\documentclass{report}\n\\title{Report}\n\\begin{document}\nReport\n\\end{document}\n');

    // ── Source code (not discovered) ────────────────────────────────
    writeFixtureFile(repoDir, 'src/index.ts', 'export const x = 1;\n');
    writeFixtureFile(repoDir, 'package.json', '{"name":"test"}\n');

    // ── .jellyignore excludes private/ ──────────────────────────────
    writeFixtureFile(repoDir, '.jellyignore', 'private/\n');
    writeFixtureFile(repoDir, 'private/internal.adoc', '= Secret\n\nDo not index.\n');
  }, 30_000);

  afterAll(() => {
    if (repoDir && process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ── 1. AsciiDoc discovery ─────────────────────────────────────────
  it('discovers .adoc files (AsciiDoc)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map(d => d.path);
    expect(paths).toContain('docs/guide.adoc');
    expect(paths).toContain('docs/api-reference.adoc');
  });

  // ── 2. Org-mode discovery ─────────────────────────────────────────
  it('discovers .org files (Org-mode)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map(d => d.path);
    expect(paths).toContain('docs/notes.org');
    expect(paths).toContain('docs/todo.org');
  });

  // ── 3. LaTeX discovery ────────────────────────────────────────────
  it('discovers .tex files (LaTeX)', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map(d => d.path);
    expect(paths).toContain('docs/paper.tex');
    expect(paths).toContain('docs/report.tex');
  });

  // ── 4. Classification metadata on new formats ─────────────────────
  it('new format docs have classification metadata', async () => {
    const docs = await discoverDocs(repoDir);
    const adoc = docs.find(d => d.path === 'docs/guide.adoc');
    expect(adoc).toBeDefined();
    expect(adoc!.classification.isDoc).toBe(true);
    expect(adoc!.classification.confidence).toBeGreaterThan(0);
  });

  // ── 5. Source code excluded ───────────────────────────────────────
  it('excludes .ts and .json source files', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map(d => d.path);
    expect(paths).not.toContain('src/index.ts');
    expect(paths).not.toContain('package.json');
  });

  // ── 6. .jellyignore respected ─────────────────────────────────────
  it('respects .jellyignore: private/ excluded', async () => {
    const docs = await discoverDocs(repoDir);
    const paths = docs.map(d => d.path);
    expect(paths).not.toContain('private/internal.adoc');
  });
});

// ─── Integration: discoverDocs + batchIngestContent (needs Neo4j) ───
// This describe block is separate because it requires a Neo4j database.
// It tests the full pipeline: discoverDocs → read files → batchIngest

describe.skipIf(skipE2E)('P0b E2E Expansion: discoverDocs → batchIngest Pipeline', () => {
  let repoDir: string;
  let graphStore: IGraphStore;
  const projectId = `e2e-p0b-batch-${Date.now()}`;

  beforeAll(async () => {
    repoDir = makeTempDir('p0b-batch-e2e');

    // Create a small repo with 3 discoverable docs
    writeFixtureFile(repoDir, 'README.md', '# Test Batch\n\nSmall batch test.\n');
    writeFixtureFile(repoDir, 'docs/guide.md', '# Guide\n\nHow to use.\n');
    writeFixtureFile(repoDir, 'CHANGELOG.md', '# Changelog\n\nv1.0.0\n');
    writeFixtureFile(repoDir, 'src/index.ts', 'export const x = 1;\n');

    // Set up Neo4j connection
    const config = loadConfig();
    graphStore = new Neo4jAdapter(config.neo4j);
    await graphStore.initializeSchema();
    await graphStore.clearProject(projectId);
    await graphStore.batchCreateNodes([
      { id: projectId, type: 'Project', projectId, name: projectId },
    ]);
  }, 30_000);

  afterAll(async () => {
    try { await graphStore.clearProject(projectId); } catch { /* ignore */ }
    await graphStore.close();
    if (repoDir && process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('discoverDocs output can feed startBatchIngestContent', async () => {
    const docs = await discoverDocs(repoDir);
    const docPaths = docs.map(d => d.path);

    // Verify 3 docs discovered
    expect(docPaths).toContain('README.md');
    expect(docPaths).toContain('docs/guide.md');
    expect(docPaths).toContain('CHANGELOG.md');
    expect(docPaths).not.toContain('src/index.ts');

    // Feed discovered docs into batchIngestContent
    const files = docs.map(d => ({
      source_path: d.path,
      content: readFileSync(`${repoDir}/${d.path}`, 'utf-8'),
    }));

    const mockLLM = createMockLLM();
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const taskId = service.startBatchIngestContent(projectId, files);

    // Verify task was created
    expect(taskId).toMatch(/^batch-content-/);
    expect(taskId.length).toBeGreaterThan(0);

    const activeTasks = service.getActiveTasks(projectId);
    expect(activeTasks.has(taskId)).toBe(true);

    const task = activeTasks.get(taskId)!;
    expect(task.status).toBe('compiling');
    expect(task.projectId).toBe(projectId);
  });

  it('startBatchIngestContent with empty files returns valid task', () => {
    const mockLLM = createMockLLM();
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const taskId = service.startBatchIngestContent(projectId, []);
    expect(taskId).toMatch(/^batch-content-/);
  });
});

// ─── Edge Cases: Empty repo + Single file repo ──────────────────────────────

describe.skipIf(skipE2E)('P0b E2E Expansion: Edge Cases', () => {
  // ── Empty repo ──────────────────────────────────────────────────
  it('discovers nothing from empty repo directory', async () => {
    const repoDir = makeTempDir('p0b-empty');
    try {
      const docs = await discoverDocs(repoDir);
      expect(docs.length).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ── Single file repo ────────────────────────────────────────────
  it('discovers single markdown file from minimal repo', async () => {
    const repoDir = makeTempDir('p0b-single');
    try {
      writeFixtureFile(repoDir, 'README.md', '# Single file repo\n\nMinimal.\n');
      const docs = await discoverDocs(repoDir);
      expect(docs.length).toBe(1);
      expect(docs[0].path).toBe('README.md');
      expect(docs[0].classification.isDoc).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ── Only non-doc files ──────────────────────────────────────────
  it('discovers nothing from repo with only source code', async () => {
    const repoDir = makeTempDir('p0b-code-only');
    try {
      writeFixtureFile(repoDir, 'src/index.ts', 'export const x = 1;\n');
      writeFixtureFile(repoDir, 'src/utils.js', 'module.exports = {};\n');
      writeFixtureFile(repoDir, 'package.json', '{"name":"test"}\n');
      const docs = await discoverDocs(repoDir);
      expect(docs.length).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
