/**
 * Unit Tests: WikiService.autoDiscover (P0b-T4)
 *
 * Tests the service-layer integration between document discovery (T2's
 * discoverDocs) and existing batchIngest. The methods tested:
 *
 * - WikiService.deriveBatchParams(projectId, repoPath) — analyzes discovered
 *   docs and derives { dir, pattern } suitable for batchIngest.
 * - WikiService.startAutoDiscover(projectId, repoPath) — orchestrates
 *   discover + derive + batchIngest, returns a taskId.
 *
 * The tests construct a real WikiService with mocked graph/search/vector/llm
 * stores (same pattern as test/unit/wiki-service.test.ts), then verify
 * behavior against temp directories with realistic file structures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the embedding module before importing WikiService
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
  embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
}));

import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';
import type { CompileOutput } from '../../src/wiki/models.js';

// ==========================================
// Mock Factories (mirrors test/unit/wiki-service.test.ts)
// ==========================================

function createMockGraph(): IGraphStore {
  const queryFn = vi.fn(async (_cypher: string, _params: Record<string, unknown> = {}) => []);
  return {
    initializeSchema: vi.fn(async () => {}),
    findSymbol: vi.fn(async () => []),
    findSymbolByFile: vi.fn(async () => []),
    getNode: vi.fn(async () => null),
    getInboundRelations: vi.fn(async () => []),
    getOutboundRelations: vi.fn(async () => []),
    bfsTraverse: vi.fn(async () => ({ visited: [], edges: [], depths: new Map() })),
    findProcessesByNode: vi.fn(async () => []),
    findEntryPoint: vi.fn(async () => null),
    findCommunityByNode: vi.fn(async () => null),
    batchCreateNodes: vi.fn(async () => {}),
    batchCreateRelations: vi.fn(async () => {}),
    clearProject: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    query: queryFn,
  } as unknown as IGraphStore;
}

function createMockLLM(): ILLMClient {
  const compileOutput: CompileOutput = {
    title: 'Test Doc',
    summary: 'Summary',
    keyPoints: [],
    entities: [],
    existingUpdates: [],
    contradictions: [],
  };
  return {
    generate: vi.fn(async () => 'Synthesized answer'),
    generateJSON: vi.fn(async () => compileOutput),
  };
}

function createMockSearch(): ISearchStore {
  return {
    search: vi.fn(async () => []),
    indexDocuments: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    ensureCollection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as ISearchStore;
}

function createMockVector(): IVectorStore {
  return {
    search: vi.fn(async () => []),
    upsertVectors: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    ensureCollection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as IVectorStore;
}

function createMockStoreSet(): StoreSet {
  return {
    graph: createMockGraph(),
    search: createMockSearch(),
    vector: createMockVector(),
    llm: createMockLLM(),
  };
}

const testWikiConfig: WikiConfig = {
  staleDays: 30,
  autoWriteBack: false,
};

// ==========================================
// Tests
// ==========================================

describe('WikiService.autoDiscover', () => {
  describe('deriveBatchParams', () => {
    it('derives { dir, pattern } for repo with docs/ + .md files', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      await fs.mkdir(path.join(tmpRepo, 'docs'));
      await fs.writeFile(path.join(tmpRepo, 'docs', 'guide.md'), '# Guide');
      await fs.writeFile(path.join(tmpRepo, 'docs', 'api.md'), '# API');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const { dir, pattern } = await service.deriveBatchParams('proj-1', tmpRepo);

      expect(dir).toBe(path.join(tmpRepo, 'docs'));
      expect(pattern).toBe('**/*.md');

      await fs.rm(tmpRepo, { recursive: true });
    });

    it('handles mixed .md and .rst extensions in docs/', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      await fs.mkdir(path.join(tmpRepo, 'docs', 'sub'), { recursive: true });
      await fs.writeFile(path.join(tmpRepo, 'docs', 'guide.md'), '# Guide');
      await fs.writeFile(path.join(tmpRepo, 'docs', 'api.md'), '# API');
      await fs.writeFile(path.join(tmpRepo, 'docs', 'sub', 'notes.rst'), 'Notes');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const { dir, pattern } = await service.deriveBatchParams('proj-1', tmpRepo);

      expect(dir).toBe(path.join(tmpRepo, 'docs'));
      // Pattern should include both md and rst extensions
      expect(pattern).toMatch(/md/);
      expect(pattern).toMatch(/rst/);
      expect(pattern).toBe('**/*.{md,rst}');

      await fs.rm(tmpRepo, { recursive: true });
    });

    it('falls back to repo root when docs are not in a docs/ dir', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      // README.md at repo root, no docs/ directory
      await fs.writeFile(path.join(tmpRepo, 'README.md'), '# Project');
      await fs.writeFile(path.join(tmpRepo, 'INSTALL.md'), '# Install');
      // Also a source file that should NOT be discovered
      await fs.writeFile(path.join(tmpRepo, 'index.ts'), 'export {}');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const { dir, pattern } = await service.deriveBatchParams('proj-1', tmpRepo);

      expect(dir).toBe(tmpRepo);
      expect(pattern).toBe('**/*.md');

      await fs.rm(tmpRepo, { recursive: true });
    });

    it('handles repo with docs at root and in docs/ subdir (prefers docs/ dir)', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      await fs.mkdir(path.join(tmpRepo, 'docs'));
      await fs.writeFile(path.join(tmpRepo, 'README.md'), '# Root README');
      await fs.writeFile(path.join(tmpRepo, 'docs', 'guide.md'), '# Guide');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const { dir, pattern } = await service.deriveBatchParams('proj-1', tmpRepo);

      // When docs/ exists and has docs, prefer it as the target dir
      expect(dir).toBe(path.join(tmpRepo, 'docs'));
      expect(pattern).toBe('**/*.md');

      await fs.rm(tmpRepo, { recursive: true });
    });

    it('returns empty pattern when no docs discovered', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      // Only source files, no docs
      await fs.writeFile(path.join(tmpRepo, 'index.ts'), 'export {}');
      await fs.mkdir(path.join(tmpRepo, 'src'));
      await fs.writeFile(path.join(tmpRepo, 'src', 'app.ts'), 'export {}');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const { dir, pattern } = await service.deriveBatchParams('proj-1', tmpRepo);

      // With no docs, dir is repo root and pattern is the default
      expect(dir).toBe(tmpRepo);
      expect(pattern).toBe('**/*.md'); // default fallback

      await fs.rm(tmpRepo, { recursive: true });
    });
  });

  describe('startAutoDiscover', () => {
    it('returns a taskId string', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      await fs.mkdir(path.join(tmpRepo, 'docs'));
      await fs.writeFile(path.join(tmpRepo, 'docs', 'guide.md'), '# Guide');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const taskId = service.startAutoDiscover('proj-1', tmpRepo);

      expect(typeof taskId).toBe('string');
      expect(taskId).toMatch(/^auto-discover-/);

      await fs.rm(tmpRepo, { recursive: true });
    });

    it('registers the task in activeTasks', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      await fs.mkdir(path.join(tmpRepo, 'docs'));
      await fs.writeFile(path.join(tmpRepo, 'docs', 'guide.md'), '# Guide');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const taskId = service.startAutoDiscover('proj-1', tmpRepo);

      const tasks = service.getActiveTasks('proj-1');
      expect(tasks.has(taskId)).toBe(true);

      const task = tasks.get(taskId)!;
      expect(task.projectId).toBe('proj-1');
      expect(task.sourcePath).toBe(tmpRepo);

      await fs.rm(tmpRepo, { recursive: true });
    });

    it('uses prefix "auto-discover" in taskId to distinguish from startBatchIngest', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-'));
      await fs.writeFile(path.join(tmpRepo, 'README.md'), '# Readme');

      const service = new WikiService(createMockStoreSet(), testWikiConfig);
      const taskId = service.startAutoDiscover('proj-1', tmpRepo);

      expect(taskId.startsWith('auto-discover-')).toBe(true);
      // Should NOT have "batch-" prefix from startBatchIngest
      expect(taskId.startsWith('batch-')).toBe(false);

      await fs.rm(tmpRepo, { recursive: true });
    });
  });
});
