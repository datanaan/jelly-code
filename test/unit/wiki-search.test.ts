/**
 * Unit Tests: WikiSearch (Typesense + Qdrant hybrid search with RRF)
 * Updated for ISSUE-002: WikiPageDoc now includes projectId
 */

import { describe, it, expect, vi } from 'vitest';
import { WikiSearch } from '../../src/wiki/search.js';
import type { ISearchStore, IVectorStore, SearchResult, VectorResult } from '../../src/store/interfaces.js';
import type { WikiPageDoc } from '../../src/wiki/models.js';

const testProjectId = 'test-project';

function createMockSearchStore(results: SearchResult[] = []): ISearchStore {
  return {
    search: vi.fn(async () => results),
    indexDocuments: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    ensureCollection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as ISearchStore;
}

function createMockVectorStore(results: VectorResult[] = []): IVectorStore {
  return {
    search: vi.fn(async () => results),
    upsertVectors: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    ensureCollection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as IVectorStore;
}

const samplePage: WikiPageDoc = {
  id: 'test-entity',
  projectId: testProjectId,
  pageType: 'entity',
  title: 'Test Entity',
  content: 'A test entity for search',
  entityType: 'concept',
  compiledAt: 1716120000,
};

const sampleEmbedding = new Array(1024).fill(0).map((_, i) => i * 0.001);

describe('WikiSearch indexing', () => {
  it('initializes collection in both stores', async () => {
    const search = createMockSearchStore();
    const vector = createMockVectorStore();
    const wiki = new WikiSearch(search, vector);

    await wiki.initializeCollection();

    expect(search.ensureCollection).toHaveBeenCalledWith('wiki');
    expect(vector.ensureCollection).toHaveBeenCalledWith('wiki', 1024);
  });

  it('indexes page in both Typesense and Qdrant', async () => {
    const search = createMockSearchStore();
    const vector = createMockVectorStore();
    const wiki = new WikiSearch(search, vector);

    await wiki.indexPage(samplePage, sampleEmbedding);

    expect(search.indexDocuments).toHaveBeenCalledWith('wiki', expect.arrayContaining([
      expect.objectContaining({
        id: 'test-entity',
        name: 'Test Entity',
        nodeType: 'entity',
      }),
    ]));

    expect(vector.upsertVectors).toHaveBeenCalledWith('wiki', [
      expect.objectContaining({
        id: 'test-entity',
        payload: expect.objectContaining({
          pageType: 'entity',
          title: 'Test Entity',
          projectId: testProjectId,
        }),
      }),
    ]);
  });
});

describe('WikiSearch hybrid RRF', () => {
  it('returns fused results from keyword + vector search', async () => {
    const keywordResults: SearchResult[] = [
      { nodeId: 'entity-a', nodeType: 'entity', filePath: '', name: 'A', score: 10 },
      { nodeId: 'entity-b', nodeType: 'entity', filePath: '', name: 'B', score: 8 },
      { nodeId: 'entity-c', nodeType: 'entity', filePath: '', name: 'C', score: 5 },
    ];

    const vectorResults: VectorResult[] = [
      { nodeId: 'entity-c', score: 0.95, payload: { projectId: testProjectId, pageType: 'entity' } },
      { nodeId: 'entity-a', score: 0.9, payload: { projectId: testProjectId, pageType: 'entity' } },
      { nodeId: 'entity-d', score: 0.85, payload: { projectId: testProjectId, pageType: 'entity' } },
    ];

    const search = createMockSearchStore(keywordResults);
    const vector = createMockVectorStore(vectorResults);
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.searchPages('test query', sampleEmbedding, 5);

    expect(results.length).toBeGreaterThan(0);
    const ids = results.map(r => r.id);
    expect(ids).toContain('entity-a');
    expect(ids).toContain('entity-c');
    // projectId should be populated from Qdrant payload
    expect(results[0].projectId).toBe(testProjectId);
  });

  it('returns empty when no results from either store', async () => {
    const search = createMockSearchStore([]);
    const vector = createMockVectorStore([]);
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.searchPages('nonexistent', sampleEmbedding);
    expect(results).toHaveLength(0);
  });

  it('works with keyword-only results', async () => {
    const keywordResults: SearchResult[] = [
      { nodeId: 'entity-x', nodeType: 'entity', filePath: '', name: 'X', score: 10 },
    ];

    const search = createMockSearchStore(keywordResults);
    const vector = createMockVectorStore([]);
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.searchPages('query', sampleEmbedding);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('entity-x');
  });

  it('works with vector-only results', async () => {
    const vectorResults: VectorResult[] = [
      { nodeId: 'entity-y', score: 0.9, payload: { projectId: testProjectId } },
    ];

    const search = createMockSearchStore([]);
    const vector = createMockVectorStore(vectorResults);
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.searchPages('query', sampleEmbedding);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('entity-y');
  });

  it('respects limit parameter', async () => {
    const keywordResults = Array.from({ length: 20 }, (_, i) => ({
      nodeId: `entity-${i}`,
      nodeType: 'entity',
      filePath: '',
      name: `Entity ${i}`,
      score: 20 - i,
    }));

    const search = createMockSearchStore(keywordResults);
    const vector = createMockVectorStore([]);
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.searchPages('query', sampleEmbedding, 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe('WikiSearch direct methods', () => {
  it('keywordSearch returns id+score pairs', async () => {
    const keywordResults: SearchResult[] = [
      { nodeId: 'a', nodeType: 'entity', filePath: '', name: 'A', score: 10 },
      { nodeId: 'b', nodeType: 'entity', filePath: '', name: 'B', score: 5 },
    ];

    const search = createMockSearchStore(keywordResults);
    const vector = createMockVectorStore();
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.keywordSearch('test', 10);
    expect(results).toEqual([
      { id: 'a', score: 10 },
      { id: 'b', score: 5 },
    ]);
  });

  it('vectorSearch returns id+score pairs', async () => {
    const vectorResults: VectorResult[] = [
      { nodeId: 'a', score: 0.9, payload: {} },
    ];

    const search = createMockSearchStore();
    const vector = createMockVectorStore(vectorResults);
    const wiki = new WikiSearch(search, vector);

    const results = await wiki.vectorSearch(sampleEmbedding, 10);
    expect(results).toEqual([{ id: 'a', score: 0.9 }]);
  });
});
