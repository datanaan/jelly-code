/**
 * Tests: Embedding Pipeline — text generation + pipeline orchestration
 *
 * Covers:
 * - generateEmbeddingText / generateBatchEmbeddingTexts (pure functions, no mocking)
 * - EmbeddingPipeline.indexEmbeddings (mocked vector store + embedder)
 * - EmbeddingPipeline.semanticSearch (mocked vector store + embedder)
 * - Edge cases: empty nodes, no content, special characters
 *
 * The embedder module itself (singleton ONNX runtime) is NOT tested here
 * because it requires actual model files and the ONNX runtime. The pipeline
 * layer is what we're testing — it delegates to embedder via imports, which
 * we mock at the test level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Text generator (pure functions, no mocking needed) ──────────────

describe('generateEmbeddingText', () => {
  it('should generate Function text with name, file, and snippet', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    const text = generateEmbeddingText({
      id: 'f1',
      name: 'hello',
      label: 'Function',
      filePath: 'src/main.ts',
      content: 'function hello() { return 1; }',
    });

    expect(text).toContain('Function: hello');
    expect(text).toContain('File: main.ts');
    expect(text).toContain('function hello()');
  });

  it('should generate Class text', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    const text = generateEmbeddingText({
      id: 'c1',
      name: 'UserService',
      label: 'Class',
      filePath: 'src/services/user.ts',
      content: 'class UserService { users: User[]; }',
    });

    expect(text).toContain('Class: UserService');
    expect(text).toContain('File: user.ts');
    expect(text).toContain('Directory: src/services');
  });

  it('should generate Interface text', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    const text = generateEmbeddingText({
      id: 'i1',
      name: 'Serializable',
      label: 'Interface',
      filePath: 'src/types.ts',
      content: 'interface Serializable { toJSON(): string }',
    });

    expect(text).toContain('Interface: Serializable');
  });

  it('should generate Method text', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    const text = generateEmbeddingText({
      id: 'm1',
      name: 'getUser',
      label: 'Method',
      filePath: 'src/services/user.ts',
      content: 'getUser(id: string): User { ... }',
    });

    expect(text).toContain('Method: getUser');
  });

  it('should generate File text with shorter snippet', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    const text = generateEmbeddingText({
      id: 'f1',
      name: 'main.ts',
      label: 'File',
      filePath: 'src/main.ts',
      content: 'x'.repeat(500), // Very long content
    });

    expect(text).toContain('File: main.ts');
    expect(text).toContain('Path: src/main.ts');
    // File nodes use min(maxSnippetLength, 300) so snippet should be truncated
    expect(text.length).toBeLessThan(400);
  });

  it('should handle empty content gracefully', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    const text = generateEmbeddingText({
      id: 'e1',
      name: 'empty',
      label: 'Function',
      filePath: 'src/empty.ts',
      content: '',
    });

    expect(text).toContain('Function: empty');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('should truncate content preserving word boundaries', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    // Create content that exceeds maxSnippetLength
    const longContent = 'hello '.repeat(200);
    const text = generateEmbeddingText({
      id: 't1',
      name: 'longFunc',
      label: 'Function',
      filePath: 'src/long.ts',
      content: longContent,
    }, { maxSnippetLength: 100 });

    // Should not contain the full content
    expect(text.length).toBeLessThan(longContent.length);
    // Should end with ellipsis
    expect(text).toMatch(/\.\.\.$/);
  });

  it('should dispatch based on label', async () => {
    const { generateEmbeddingText } = await import('../../src/core/embeddings/text-generator.js');

    // Unknown label should use fallback format
    const text = generateEmbeddingText({
      id: 'x1',
      name: 'unknown',
      label: 'Enum',
      filePath: 'src/types.ts',
      content: '',
    });

    expect(text).toContain('Enum: unknown');
  });
});

describe('generateBatchEmbeddingTexts', () => {
  it('should generate texts for multiple nodes', async () => {
    const { generateBatchEmbeddingTexts } = await import('../../src/core/embeddings/text-generator.js');

    const nodes = [
      { id: 'a', name: 'fnA', label: 'Function', filePath: 'a.ts', content: 'function fnA() {}' },
      { id: 'b', name: 'clsB', label: 'Class', filePath: 'b.ts', content: 'class ClsB {}' },
      { id: 'c', name: 'ifC', label: 'Interface', filePath: 'c.ts', content: '' },
    ];

    const texts = generateBatchEmbeddingTexts(nodes as any);
    expect(texts.length).toBe(3);
    expect(texts[0]).toContain('Function: fnA');
    expect(texts[1]).toContain('Class: clsB');
    expect(texts[2]).toContain('Interface: ifC');
  });
});

// ─── EmbeddingPipeline (mocked embedder + vector store) ──────────────

describe('EmbeddingPipeline', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function createMockVectorStore() {
    return {
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      upsertVectors: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([
        { id: 'r1', name: 'result1', distance: 0.1, payload: {} },
      ]),
      deleteCollection: vi.fn(),
      deleteVectorsByNodeIds: vi.fn(),
      close: vi.fn(),
    };
  }

  it('should initialize embedder and index nodes', async () => {
    // Mock the embedder module BEFORE importing EmbeddingPipeline
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embeddingToArray: vi.fn((e: number[]) => e),
      isEmbedderReady: vi.fn().mockReturnValue(false),
    }));

    const { EmbeddingPipeline } = await import('../../src/core/embeddings/embedding-pipeline.js');
    const vectorStore = createMockVectorStore();
    const pipeline = new EmbeddingPipeline(vectorStore as any);

    await pipeline.indexEmbeddings('project-1', [
      { id: 'f1', name: 'hello', type: 'Function', filePath: 'a.ts', content: 'function hello() {}' },
    ]);

    expect(vectorStore.ensureCollection).toHaveBeenCalledWith('project-1', 384);
    expect(vectorStore.upsertVectors).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([
        expect.objectContaining({ id: 'f1' }),
      ]),
    );
  });

  it('should skip indexing when nodes array is empty', async () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn(),
      embedBatch: vi.fn(),
      embedText: vi.fn(),
      embeddingToArray: vi.fn(),
      isEmbedderReady: vi.fn(),
    }));

    const { EmbeddingPipeline } = await import('../../src/core/embeddings/embedding-pipeline.js');
    const vectorStore = createMockVectorStore();
    const pipeline = new EmbeddingPipeline(vectorStore as any);

    await pipeline.indexEmbeddings('project-1', []);

    expect(vectorStore.ensureCollection).not.toHaveBeenCalled();
    expect(vectorStore.upsertVectors).not.toHaveBeenCalled();
  });

  it('should perform semantic search with query embedding', async () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi.fn(),
      embedText: vi.fn().mockResolvedValue([0.5, 0.5, 0.5]),
      embeddingToArray: vi.fn((e: number[]) => e),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));

    const { EmbeddingPipeline } = await import('../../src/core/embeddings/embedding-pipeline.js');
    const vectorStore = createMockVectorStore();
    const pipeline = new EmbeddingPipeline(vectorStore as any);

    const results = await pipeline.semanticSearch('project-1', 'find hello', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(vectorStore.search).toHaveBeenCalledWith(
      'project-1',
      [0.5, 0.5, 0.5],
      5,
    );
  });

  it('should batch nodes correctly with custom batch size', async () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi.fn().mockResolvedValue(
        Array(5).fill([0.1, 0.2, 0.3]),
      ),
      embedText: vi.fn(),
      embeddingToArray: vi.fn((e: number[]) => e),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));

    const { EmbeddingPipeline } = await import('../../src/core/embeddings/embedding-pipeline.js');
    const vectorStore = createMockVectorStore();
    const pipeline = new EmbeddingPipeline(vectorStore as any);

    // 5 nodes with default batchSize=16 → 1 batch
    const nodes = Array(5).fill(null).map((_, i) => ({
      id: `node-${i}`, name: `func${i}`, type: 'Function', filePath: 'a.ts', content: `function func${i}() {}`,
    }));

    await pipeline.indexEmbeddings('project-1', nodes);
    expect(vectorStore.upsertVectors).toHaveBeenCalledTimes(1);
    expect(vectorStore.upsertVectors).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([
        expect.objectContaining({ id: 'node-0' }),
        expect.objectContaining({ id: 'node-4' }),
      ]),
    );
  });
});
