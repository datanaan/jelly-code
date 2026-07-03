/**
 * Unit Tests: WikiService core business logic
 *
 * Tests WikiService methods with mock WikiGraph, WikiSearch, and ILLMClient.
 * The service is tested in isolation — no real Neo4j, Typesense, Qdrant, or Ollama needed.
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
import type {
  WikiEntity,
  WikiSource,
  CompileOutput,
  WikiPageDoc,
} from '../../src/wiki/models.js';

// ==========================================
// Mock Factories
// ==========================================

/** Create a minimal mock IGraphStore that captures queries. */
function createMockGraph(): IGraphStore & {
  queries: Array<{ cypher: string; params: Record<string, unknown> }>;
} {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const queryFn = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    queries.push({ cypher, params });
    return [];
  });

  return {
    queries,
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
  } as unknown as IGraphStore & {
    queries: Array<{ cypher: string; params: Record<string, unknown> }>;
  };
}

/** Create a mock ILLMClient with controllable responses. */
function createMockLLM(options?: {
  jsonResponse?: CompileOutput;
  textResponse?: string;
}): ILLMClient {
  return {
    generate: vi.fn(async (_prompt: string) => {
      return options?.textResponse ?? 'Synthesized answer text';
    }),
    generateJSON: vi.fn(async <T>(_prompt: string): Promise<T> => {
      return (options?.jsonResponse ?? {
        title: 'Test Document',
        summary: 'A test summary',
        keyPoints: ['point1'],
        entities: [],
        existingUpdates: [],
        contradictions: [],
      }) as T;
    }),
  };
}

/** Create a mock ISearchStore. */
function createMockSearch(): ISearchStore {
  return {
    search: vi.fn(async () => []),
    indexDocuments: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    ensureCollection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as ISearchStore;
}

/** Create a mock IVectorStore. */
function createMockVector(): IVectorStore {
  return {
    search: vi.fn(async () => []),
    upsertVectors: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    ensureCollection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as IVectorStore;
}

/** Create a StoreSet with all mocks. */
function createMockStoreSet(llm?: ILLMClient): StoreSet {
  return {
    graph: createMockGraph(),
    search: createMockSearch(),
    vector: createMockVector(),
    llm: llm ?? createMockLLM(),
  };
}

/** Standard WikiConfig for tests. */
const testProjectId = 'test-project';

const testWikiConfig: WikiConfig = {
  staleDays: 30,
  autoWriteBack: false, // Disable auto-write-back for most tests
};

// ==========================================
// Tests
// ==========================================

describe('WikiService', () => {
  describe('ingest', () => {
    it('reads a file and calls LLM compile with correct prompt', async () => {
      // Create a temp file to ingest
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-test-'));
      const tmpFile = path.join(tmpDir, 'test-doc.md');
      await fs.writeFile(tmpFile, '# Test Document\n\nThis is a test document about things.');

      const llm = createMockLLM();
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);

      const result = await service.ingest(testProjectId, tmpFile);

      // LLM generateJSON should have been called (for compile)
      expect(llm.generateJSON).toHaveBeenCalled();

      // Result should have zero created/updated (empty entities array)
      expect(result.entitiesCreated).toBe(0);
      expect(result.entitiesUpdated).toBe(0);
      expect(result.source.title).toBe('Test Document');

      // Cleanup
      await fs.rm(tmpDir, { recursive: true });
    });

    it('creates new entities from compile output', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-test-'));
      const tmpFile = path.join(tmpDir, 'entities.md');
      await fs.writeFile(tmpFile, 'Content about things.');

      const compileOutput: CompileOutput = {
        title: 'Entity Doc',
        summary: 'Doc with entities',
        keyPoints: ['k1'],
        entities: [
          {
            name: 'my-concept',
            type: 'concept',
            definition: 'A concept definition',
            details: 'Detailed info about the concept',
            links: [{ target: 'other-concept', relationship: 'related to' }],
          },
        ],
        existingUpdates: [],
        contradictions: [],
      };

      const llm = createMockLLM({ jsonResponse: compileOutput });
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);

      const result = await service.ingest(testProjectId, tmpFile);

      expect(result.entitiesCreated).toBe(1);
      expect(result.entitiesUpdated).toBe(0);
      expect(result.source.title).toBe('Entity Doc');

      await fs.rm(tmpDir, { recursive: true });
    });

    it('updates existing entities instead of creating duplicates', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-test-'));
      const tmpFile = path.join(tmpDir, 'update.md');
      await fs.writeFile(tmpFile, 'Updated content.');

      const compileOutput: CompileOutput = {
        title: 'Update Doc',
        summary: 'Updating existing entity',
        keyPoints: [],
        entities: [
          {
            name: 'existing-entity',
            type: 'concept',
            definition: 'Already exists',
            details: 'New details to merge',
            links: [],
          },
        ],
        existingUpdates: [],
        contradictions: [],
      };

      const llm = createMockLLM({ jsonResponse: compileOutput, textResponse: 'Merged details' });
      const mockGraph = createMockGraph();

      // Make findEntityByName return an existing entity for "existing-entity"
      let queryCallCount = 0;
      const originalQuery = mockGraph.query;
      (mockGraph as any).query = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
        queryCallCount++;
        // Return existing entity when the query looks for WikiEntity by name
        if (cypher.includes('WikiEntity') && cypher.includes('e.name = $name')) {
          return [{
            id: 'existing-entity',
            name: 'existing-entity',
            entityType: 'concept',
            definition: 'Old def',
            details: 'Old details',
            firstCompiled: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          }];
        }
        return originalQuery(cypher, params);
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm,
      };
      const service = new WikiService(stores, testWikiConfig);
      const result = await service.ingest(testProjectId, tmpFile);

      expect(result.entitiesCreated).toBe(0);
      expect(result.entitiesUpdated).toBe(1);

      await fs.rm(tmpDir, { recursive: true });
    });

    it('throws on non-existent file', async () => {
      const stores = createMockStoreSet();
      const service = new WikiService(stores, testWikiConfig);

      await expect(service.ingest(testProjectId, '/nonexistent/file.md')).rejects.toThrow();
    });

    it('reports contradictions count from compile output', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-test-'));
      const tmpFile = path.join(tmpDir, 'contra.md');
      await fs.writeFile(tmpFile, 'Contradictory content.');

      const compileOutput: CompileOutput = {
        title: 'Contra Doc',
        summary: 'Has contradictions',
        keyPoints: [],
        entities: [],
        existingUpdates: [],
        contradictions: [
          { entityName: 'entity-x', description: 'Says both A and B' },
          { entityName: 'entity-y', description: 'Conflicting definitions' },
        ],
      };

      const llm = createMockLLM({ jsonResponse: compileOutput });
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);
      const result = await service.ingest(testProjectId, tmpFile);

      expect(result.contradictions).toBe(2);

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe('batchIngest', () => {
    it('ingests all matching files in a directory', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-batch-'));
      await fs.writeFile(path.join(tmpDir, 'a.md'), 'File A');
      await fs.writeFile(path.join(tmpDir, 'b.md'), 'File B');
      await fs.writeFile(path.join(tmpDir, 'c.txt'), 'Not a markdown file');

      const llm = createMockLLM();
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);

      const result = await service.batchIngest(testProjectId, tmpDir, '*.md');

      expect(result.totalCompiled).toBe(2);
      expect(result.errors).toHaveLength(0);

      await fs.rm(tmpDir, { recursive: true });
    });

    it('collects errors from individual ingest failures', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-batch-'));
      await fs.writeFile(path.join(tmpDir, 'good.md'), 'Good file');

      // LLM that always throws
      const llm: ILLMClient = {
        generate: vi.fn(async () => { throw new Error('LLM unavailable'); }),
        generateJSON: vi.fn(async () => { throw new Error('LLM unavailable'); }),
      };
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);

      const result = await service.batchIngest(testProjectId, tmpDir, '*.md');

      expect(result.totalCompiled).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('LLM unavailable');

      await fs.rm(tmpDir, { recursive: true });
    });

    it('handles empty directory gracefully', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-batch-'));

      const stores = createMockStoreSet();
      const service = new WikiService(stores, testWikiConfig);
      const result = await service.batchIngest(testProjectId, tmpDir, '*.md');

      expect(result.totalCompiled).toBe(0);
      expect(result.results).toHaveLength(0);
      expect(result.errors).toHaveLength(0);

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe('query', () => {
    it('calls LLM synthesize with search context', async () => {
      const llm = createMockLLM({ textResponse: 'Answer: The answer is 42.' });
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);

      const answer = await service.query(testProjectId, 'What is the meaning?');

      expect(llm.generate).toHaveBeenCalled();
      expect(answer).toBe('Answer: The answer is 42.');
    });

    it('writes back as Topic when autoWriteBack is true', async () => {
      const llm = createMockLLM({ textResponse: 'Auto-written answer.' });
      const stores = createMockStoreSet(llm);
      const configWithWriteBack: WikiConfig = {
        staleDays: 30,
        autoWriteBack: true,
      };
      const service = new WikiService(stores, configWithWriteBack);

      const answer = await service.query(testProjectId, 'Test question');

      expect(answer).toBe('Auto-written answer.');
      // Verify graph query was called (createTopic uses MERGE WikiTopic)
      const mockGraph = stores.graph as any;
      const topicQueries = mockGraph.queries.filter(
        (q: any) => q.cypher.includes('WikiTopic'),
      );
      expect(topicQueries.length).toBeGreaterThan(0);
    });

    it('does not write back when autoWriteBack is false', async () => {
      const llm = createMockLLM({ textResponse: 'No write-back answer.' });
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig);

      await service.query(testProjectId, 'Test question');

      const mockGraph = stores.graph as any;
      const topicQueries = mockGraph.queries.filter(
        (q: any) => q.cypher.includes('WikiTopic'),
      );
      expect(topicQueries.length).toBe(0);
    });

    it('explicit writeBack=true overrides config', async () => {
      const llm = createMockLLM({ textResponse: 'Explicit write-back.' });
      const stores = createMockStoreSet(llm);
      const service = new WikiService(stores, testWikiConfig); // autoWriteBack = false

      await service.query(testProjectId, 'Test question', true);

      const mockGraph = stores.graph as any;
      const topicQueries = mockGraph.queries.filter(
        (q: any) => q.cypher.includes('WikiTopic'),
      );
      expect(topicQueries.length).toBeGreaterThan(0);
    });
  });

  describe('getIndex', () => {
    it('delegates to WikiGraph.getIndex', async () => {
      const mockGraph = createMockGraph();
      // Override query to return index data
      let callIdx = 0;
      (mockGraph as any).query = vi.fn(async () => {
        callIdx++;
        if (callIdx === 1) return [{ id: 'e1', name: 'Ent1', type: 'concept', linkCount: 2 }];
        if (callIdx === 2) return [{ id: 's1', title: 'Src1', entityCount: 3 }];
        if (callIdx === 3) return [{ id: 't1', title: 'Top1' }];
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const index = await service.getIndex(testProjectId);

      expect(index.entities).toHaveLength(1);
      expect(index.entities[0].name).toBe('Ent1');
      expect(index.sources).toHaveLength(1);
      expect(index.topics).toHaveLength(1);
    });
  });

  describe('status', () => {
    it('returns compiled sources from graph', async () => {
      const mockGraph = createMockGraph();
      let callIdx = 0;
      (mockGraph as any).query = vi.fn(async (_cypher: string, _params: Record<string, unknown> = {}) => {
        callIdx++;
        // listSourcePaths query (simple: only returns path)
        if (_cypher.includes('source_path') && _cypher.includes(' AS path')) return [{ path: '/data/test.md' }];
        // listSources query (returns id, title, sourcePath etc.)
        if (_cypher.includes('WikiSource') && _cypher.includes(' AS id')) {
          return [{
            id: 'source-test',
            title: 'Test',
            sourcePath: '/data/test.md',
            summary: 'Summary',
            keyPoints: [],
            compiledAt: '2026-05-19T12:00:00Z',
          }];
        }
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const status = await service.status(testProjectId);

      expect(status.compiled).toHaveLength(1);
      expect(status.compiled[0].sourceId).toBe('source-test');
    });

    it('classifies uncompiled files when dir is given', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-status-'));
      await fs.writeFile(path.join(tmpDir, 'uncompiled.md'), 'Not yet compiled');

      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async (cypher: string) => {
        // No compiled sources
        if (cypher.includes('source_path')) return [];
        if (cypher.includes('WikiSource')) return [];
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const status = await service.status(testProjectId, tmpDir);

      expect(status.compiled).toHaveLength(0);
      expect(status.uncompiled).toHaveLength(1);
      expect(status.total).toBe(1);

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe('getEntity', () => {
    it('returns entity from graph', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async (cypher: string) => {
        if (cypher.includes('WikiEntity')) {
          return [{
            id: 'test-entity',
            name: 'Test',
            entityType: 'concept',
            definition: 'Def',
            details: 'Details',
            firstCompiled: '2026-05-19T12:00:00Z',
            lastUpdated: '2026-05-19T12:00:00Z',
          }];
        }
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const entity = await service.getEntity(testProjectId, 'test-entity');

      expect(entity).not.toBeNull();
      expect(entity!.name).toBe('Test');
    });

    it('returns null for non-existent entity', async () => {
      const stores = createMockStoreSet();
      const service = new WikiService(stores, testWikiConfig);
      const entity = await service.getEntity(testProjectId, 'nonexistent');
      expect(entity).toBeNull();
    });
  });

  describe('listEntities', () => {
    it('delegates to WikiGraph with optional type filter', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async () => [
        {
          id: 'e1',
          name: 'Concept1',
          entityType: 'concept',
          definition: 'Def',
          details: 'Details',
          firstCompiled: '2026-05-19T12:00:00Z',
          lastUpdated: '2026-05-19T12:00:00Z',
        },
      ]);

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const entities = await service.listEntities(testProjectId, 'concept');

      expect(entities).toHaveLength(1);
      expect(entities[0].entityType).toBe('concept');
    });
  });

  describe('fuzzyMatch', () => {
    it('finds entities by exact name match', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async () => [
        {
          id: 'search-service',
          name: 'SearchService',
          entityType: 'service',
          definition: 'The search service',
          details: 'Handles search',
          firstCompiled: '2026-05-19T12:00:00Z',
          lastUpdated: '2026-05-19T12:00:00Z',
        },
        {
          id: 'other-thing',
          name: 'OtherThing',
          entityType: 'concept',
          definition: 'Something else entirely',
          details: 'Not related',
          firstCompiled: '2026-05-19T12:00:00Z',
          lastUpdated: '2026-05-19T12:00:00Z',
        },
      ]);

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const results = await service.fuzzyMatch(testProjectId, 'SearchService');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entity.name).toBe('SearchService');
      expect(results[0].score).toBe(1.0); // Exact match
    });

    it('finds entities by partial name match', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async () => [
        {
          id: 'jelly-search',
          name: 'jelly-search-v3',
          entityType: 'project',
          definition: 'Search backend',
          details: 'Details',
          firstCompiled: '2026-05-19T12:00:00Z',
          lastUpdated: '2026-05-19T12:00:00Z',
        },
      ]);

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const results = await service.fuzzyMatch(testProjectId, 'jelly');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('returns empty array when no matches', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async () => [
        {
          id: 'e1',
          name: 'Unrelated',
          entityType: 'concept',
          definition: 'Completely unrelated',
          details: 'No match',
          firstCompiled: '2026-05-19T12:00:00Z',
          lastUpdated: '2026-05-19T12:00:00Z',
        },
      ]);

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const results = await service.fuzzyMatch(testProjectId, 'xyzzy-nothing-matches-this');

      expect(results).toHaveLength(0);
    });
  });

  describe('lint', () => {
    it('detects stale entities', async () => {
      const mockGraph = createMockGraph();
      let callIdx = 0;
      (mockGraph as any).query = vi.fn(async (cypher: string) => {
        callIdx++;
        // listEntities
        if (cypher.includes('WikiEntity') && !cypher.includes('LINKS_TO')) {
          return [{
            id: 'stale-entity',
            name: 'StaleEntity',
            entityType: 'concept',
            definition: 'Old entity',
            details: 'Not updated recently',
            firstCompiled: '2026-03-20T12:00:00Z',
            lastUpdated: '2026-03-20T12:00:00Z',
          }];
        }
        // getOutgoingLinks / getIncomingLinks — return empty for orphan detection
        if (cypher.includes('LINKS_TO')) return [{ id: 'other' }];
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, { staleDays: 30, autoWriteBack: false });
      const issues = await service.lint(testProjectId);

      const staleIssues = issues.filter(i => i.type === 'stale');
      expect(staleIssues.length).toBeGreaterThan(0);
      expect(staleIssues[0].entityName).toBe('StaleEntity');
    });

    it('detects orphan entities', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async (cypher: string) => {
        if (cypher.includes('WikiEntity') && !cypher.includes('LINKS_TO')) {
          return [{
            id: 'orphan-entity',
            name: 'Orphan',
            entityType: 'concept',
            definition: 'No links',
            details: 'All alone',
            firstCompiled: new Date(Date.now() - 2 * 86400000).toISOString(),
            lastUpdated: new Date().toISOString(),
          }];
        }
        // getOutgoingLinks returns empty, getIncomingLinks returns empty
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const issues = await service.lint(testProjectId);

      const orphanIssues = issues.filter(i => i.type === 'orphan');
      expect(orphanIssues.length).toBeGreaterThan(0);
      expect(orphanIssues[0].entityName).toBe('Orphan');
    });

    it('detects missing references', async () => {
      const mockGraph = createMockGraph();
      (mockGraph as any).query = vi.fn(async (cypher: string) => {
        if (cypher.includes('WikiEntity') && !cypher.includes('LINKS_TO')) {
          return [{
            id: 'entity-a',
            name: 'EntityA',
            entityType: 'concept',
            definition: 'Links to missing',
            details: 'Has dangling ref',
            firstCompiled: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          }];
        }
        // getOutgoingLinks: (e)-[r:LINKS_TO]->(other)
        if (cypher.includes('e)-[r:LINKS_TO]->(other')) {
          return [{ id: 'nonexistent-target' }];
        }
        // getIncomingLinks: (other)-[r:LINKS_TO]->(e)
        if (cypher.includes('other)-[r:LINKS_TO]->(e')) {
          return [{ id: 'some-source' }];
        }
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const issues = await service.lint(testProjectId);

      const missingRefIssues = issues.filter(i => i.type === 'missing_ref');
      expect(missingRefIssues.length).toBeGreaterThan(0);
      expect(missingRefIssues[0].description).toContain('nonexistent-target');
    });
  });

  describe('syncToJelly', () => {
    it('counts all entities and topics as synced pages', async () => {
      const mockGraph = createMockGraph();
      let callIdx = 0;
      (mockGraph as any).query = vi.fn(async (cypher: string) => {
        callIdx++;
        if (cypher.includes('WikiEntity') && !cypher.includes('LINKS_TO')) {
          return [{
            id: 'e1', name: 'E1', entityType: 'concept',
            definition: 'D', details: 'Det',
            firstCompiled: '2026-05-19T12:00:00Z',
            lastUpdated: '2026-05-19T12:00:00Z',
          }];
        }
        if (cypher.includes('WikiTopic')) {
          return [{
            id: 't1', title: 'T1', content: 'Content',
            compiledAt: '2026-05-19T12:00:00Z',
          }];
        }
        return [];
      });

      const stores: StoreSet = {
        graph: mockGraph,
        search: createMockSearch(),
        vector: createMockVector(),
        llm: createMockLLM(),
      };
      const service = new WikiService(stores, testWikiConfig);
      const result = await service.syncToJelly(testProjectId, 'kb-test');

      expect(result.pagesSynced).toBe(2); // 1 entity + 1 topic
      expect(result.errors).toHaveLength(0);
    });
  });
});
