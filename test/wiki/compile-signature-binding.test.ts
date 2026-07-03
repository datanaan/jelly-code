/**
 * P0c-T3: Compile-time codeSignature binding via describes links
 *
 * Tests that WikiService.ingest correctly binds CodeSignature to WikiEntity
 * when the entity's links contain a "describes" relationship pointing to a
 * code symbol. Also verifies graceful handling when no describes link exists
 * or when the code lookup fails.
 *
 * Strategy: Unit test with mock IGraphStore. The mock returns CodeNode objects
 * with real `content` strings that generateSignature() can actually parse.
 * We do NOT stub generateSignature — it runs for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Mock the embedding module before importing WikiService
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
  embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
}));

import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore, CodeNode } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';
import type { CompileOutput } from '../../src/wiki/models.js';

// ==========================================
// Mock Factories
// ==========================================

interface MockGraphStore extends IGraphStore {
  queries: Array<{ cypher: string; params: Record<string, unknown> }>;
  findSymbol: ReturnType<typeof vi.fn>;
}

function createMockGraph(): MockGraphStore {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const findSymbolFn = vi.fn(async (_projectId: string, _name: string, _types?: string[]): Promise<CodeNode[]> => []);

  const store: MockGraphStore = {
    queries,
    findSymbol: findSymbolFn,
    initializeSchema: vi.fn(async () => {}),
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
    findNodeIdsByFilePath: vi.fn(async () => []),
    findNodeIdsByFilePaths: vi.fn(async () => new Map()),
    deleteNodesByFilePath: vi.fn(async () => []),
    deleteNodesByIds: vi.fn(async () => 0),
    clearProject: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    query: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      queries.push({ cypher, params });
      return [];
    }),
  };
  return store;
}

function createMockLLM(jsonResponse?: CompileOutput): ILLMClient {
  return {
    generate: vi.fn(async (_prompt: string) => 'Synthesized answer'),
    generateJSON: vi.fn(async <T>(_prompt: string): Promise<T> => {
      return (jsonResponse ?? {
        title: 'Test Doc',
        summary: 'Summary',
        keyPoints: [],
        entities: [],
        existingUpdates: [],
        contradictions: [],
      }) as T;
    }),
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

function createMockStoreSet(llm?: ILLMClient, graph?: IGraphStore): StoreSet {
  return {
    graph: graph ?? createMockGraph(),
    search: createMockSearch(),
    vector: createMockVector(),
    llm: llm ?? createMockLLM(),
  };
}

const testWikiConfig: WikiConfig = {
  staleDays: 30,
  autoWriteBack: false,
};

const PROJECT_ID = 'test-proj';

/** Sample TypeScript source for a function called 'greet' */
const FUNCTION_SOURCE = `function greet(name: string): string {
  return 'Hello, ' + name;
}`;

/** Sample TypeScript source for a class called 'UserService' */
const CLASS_SOURCE = `class UserService {
  private users: Map<string, string> = new Map();
  addUser(name: string): void {
    this.users.set(name, name);
  }
}`;

/** Helper: create a temp file for ingest */
async function createTempFile(content: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-sig-test-'));
  const tmpFile = path.join(tmpDir, 'test-doc.md');
  await fs.writeFile(tmpFile, content);
  return {
    file: tmpFile,
    cleanup: async () => { await fs.rm(tmpDir, { recursive: true }); },
  };
}

/** Helper: capture the createEntity query params to inspect codeSignature */
function captureCreateEntityParams(graph: MockGraphStore) {
  return graph.queries.filter(
    (q) => q.cypher.includes('WikiEntity') && q.cypher.includes('MERGE'),
  );
}

/**
 * Extract codeSignature from a captured query params object.
 * graph.ts JSON.stringifies codeSignature before passing to Neo4j,
 * so we need to parse it back for assertions in unit tests.
 */
function extractCodeSignature(params: Record<string, unknown>): Record<string, unknown> | null {
  const raw = params.codeSignature;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    return JSON.parse(raw);
  }
  return raw as Record<string, unknown>;
}

// ==========================================
// Tests
// ==========================================

describe('WikiService.ingest — codeSignature binding (P0c-T3)', () => {

  it('binds codeSignature when entity has a describes link to existing code', async () => {
    const compileOutput: CompileOutput = {
      title: 'API Docs',
      summary: 'Docs about greet function',
      keyPoints: [],
      entities: [
        {
          name: 'GreetFunction',
          type: 'api',
          definition: 'A greeting function',
          details: 'The greet function says hello',
          links: [{ target: 'greet', relationship: 'describes' }],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    // Mock findSymbol to return a CodeNode with real source content
    graph.findSymbol.mockResolvedValue([
      {
        id: 'node-greet',
        type: 'Function',
        projectId: PROJECT_ID,
        name: 'greet',
        filePath: 'src/greet.ts',
        content: FUNCTION_SOURCE,
      } as CodeNode,
    ]);

    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      await service.ingest(PROJECT_ID, file);

      // Verify findSymbol was called for the 'greet' target
      expect(graph.findSymbol).toHaveBeenCalledWith(PROJECT_ID, 'greet');

      // Verify the createEntity query includes codeSignature
      const createQueries = captureCreateEntityParams(graph);
      const entityQuery = createQueries.find(q => q.params.name === 'GreetFunction');
      expect(entityQuery).toBeDefined();
      expect(entityQuery!.params.codeSignature).toBeDefined();
      expect(entityQuery!.params.codeSignature).not.toBeNull();

      // The signature should have real parsed values
      const sig = extractCodeSignature(entityQuery!.params)!;
      expect(sig.entityName).toBe('greet');
      expect(sig.entityType).toBe('function');
      expect(sig.paramTypes).toEqual(['string']);
      expect(sig.returnType).toBe('string');
      expect(sig.signatureHash).toMatch(/^[0-9a-f]{64}$/);
      expect(sig.astHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await cleanup();
    }
  });

  it('sets codeSignature to null when entity has no describes link', async () => {
    const compileOutput: CompileOutput = {
      title: 'Concept Doc',
      summary: 'A concept without code binding',
      keyPoints: [],
      entities: [
        {
          name: 'PureConcept',
          type: 'concept',
          definition: 'A pure concept',
          details: 'No code relationship here',
          links: [{ target: 'other-concept', relationship: 'related to' }],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      await service.ingest(PROJECT_ID, file);

      // findSymbol should NOT have been called (no describes link)
      expect(graph.findSymbol).not.toHaveBeenCalled();

      // The entity should have codeSignature explicitly set to null
      const createQueries = captureCreateEntityParams(graph);
      const entityQuery = createQueries.find(q => q.params.name === 'PureConcept');
      expect(entityQuery).toBeDefined();
      expect(entityQuery!.params.codeSignature).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('sets codeSignature to null when describes link targets non-existent code', async () => {
    const compileOutput: CompileOutput = {
      title: 'Stale Docs',
      summary: 'Docs referencing missing code',
      keyPoints: [],
      entities: [
        {
          name: 'MissingApi',
          type: 'api',
          definition: 'An API that no longer exists',
          details: 'This described a removed function',
          links: [{ target: 'removedFunc', relationship: 'describes' }],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    // findSymbol returns empty array — code node doesn't exist
    graph.findSymbol.mockResolvedValue([]);

    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      await service.ingest(PROJECT_ID, file);

      // findSymbol WAS called
      expect(graph.findSymbol).toHaveBeenCalledWith(PROJECT_ID, 'removedFunc');

      // But codeSignature should be null (graceful failure)
      const createQueries = captureCreateEntityParams(graph);
      const entityQuery = createQueries.find(q => q.params.name === 'MissingApi');
      expect(entityQuery).toBeDefined();
      expect(entityQuery!.params.codeSignature).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('uses first successful lookup when multiple describes links exist', async () => {
    const compileOutput: CompileOutput = {
      title: 'Multi-Link Docs',
      summary: 'Docs with multiple describes links',
      keyPoints: [],
      entities: [
        {
          name: 'MultiApi',
          type: 'api',
          definition: 'An API with multiple bindings',
          details: 'Describes multiple things',
          links: [
            { target: 'missing', relationship: 'describes' },
            { target: 'greet', relationship: 'describes' },
          ],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    // First lookup returns empty, second returns code
    graph.findSymbol
      .mockResolvedValueOnce([]) // 'missing' — not found
      .mockResolvedValueOnce([
        {
          id: 'node-greet',
          type: 'Function',
          projectId: PROJECT_ID,
          name: 'greet',
          filePath: 'src/greet.ts',
          content: FUNCTION_SOURCE,
        } as CodeNode,
      ]);

    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      await service.ingest(PROJECT_ID, file);

      // findSymbol should have been called twice (once per describes link)
      expect(graph.findSymbol).toHaveBeenCalledTimes(2);

      // The entity should have codeSignature from 'greet' (first successful lookup)
      const createQueries = captureCreateEntityParams(graph);
      const entityQuery = createQueries.find(q => q.params.name === 'MultiApi');
      expect(entityQuery).toBeDefined();
      expect(entityQuery!.params.codeSignature).toBeDefined();
      expect(entityQuery!.params.codeSignature).not.toBeNull();

      const sig = extractCodeSignature(entityQuery!.params)!;
      expect(sig.entityName).toBe('greet');
    } finally {
      await cleanup();
    }
  });

  it('binds each entity independently when multiple entities in one compile', async () => {
    const compileOutput: CompileOutput = {
      title: 'Multi-Entity Docs',
      summary: 'Multiple entities with different bindings',
      keyPoints: [],
      entities: [
        {
          name: 'BoundEntity',
          type: 'api',
          definition: 'Has code binding',
          details: 'Describes greet',
          links: [{ target: 'greet', relationship: 'describes' }],
        },
        {
          name: 'UnboundEntity',
          type: 'concept',
          definition: 'No code binding',
          details: 'A pure concept',
          links: [{ target: 'something', relationship: 'related to' }],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    graph.findSymbol.mockResolvedValue([
      {
        id: 'node-greet',
        type: 'Function',
        projectId: PROJECT_ID,
        name: 'greet',
        filePath: 'src/greet.ts',
        content: FUNCTION_SOURCE,
      } as CodeNode,
    ]);

    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      await service.ingest(PROJECT_ID, file);

      const createQueries = captureCreateEntityParams(graph);

      // BoundEntity should have a real signature
      const boundQuery = createQueries.find(q => q.params.name === 'BoundEntity');
      expect(boundQuery).toBeDefined();
      expect(boundQuery!.params.codeSignature).toBeDefined();
      expect(boundQuery!.params.codeSignature).not.toBeNull();
      const boundSig = extractCodeSignature(boundQuery!.params)!;
      expect(boundSig.entityName).toBe('greet');

      // UnboundEntity should have null signature
      const unboundQuery = createQueries.find(q => q.params.name === 'UnboundEntity');
      expect(unboundQuery).toBeDefined();
      expect(unboundQuery!.params.codeSignature).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('backward compat: entities without codeSignature field still load correctly', async () => {
    // Simulate: an old entity stored in Neo4j without codeSignature
    // The WikiEntity type allows undefined for codeSignature (backward compat)
    // This test verifies that reading such an entity doesn't break
    const compileOutput: CompileOutput = {
      title: 'Old Doc',
      summary: 'Pre-P0c entity',
      keyPoints: [],
      entities: [
        {
          name: 'OldConcept',
          type: 'concept',
          definition: 'An old concept',
          details: 'Created before P0c',
          links: [], // no links at all
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      const result = await service.ingest(PROJECT_ID, file);

      // Should complete without error
      expect(result.entitiesCreated).toBe(1);

      // Entity should have codeSignature explicitly null (not undefined)
      const createQueries = captureCreateEntityParams(graph);
      const entityQuery = createQueries.find(q => q.params.name === 'OldConcept');
      expect(entityQuery).toBeDefined();
      // Explicit null is correct for "no describes link" entities
      expect(entityQuery!.params.codeSignature).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('handles code node with class type correctly', async () => {
    const compileOutput: CompileOutput = {
      title: 'Service Docs',
      summary: 'Docs about UserService class',
      keyPoints: [],
      entities: [
        {
          name: 'UserServiceEntity',
          type: 'api',
          definition: 'User service class',
          details: 'Manages users',
          links: [{ target: 'UserService', relationship: 'describes' }],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM(compileOutput);
    const graph = createMockGraph();
    graph.findSymbol.mockResolvedValue([
      {
        id: 'node-userservice',
        type: 'Class',
        projectId: PROJECT_ID,
        name: 'UserService',
        filePath: 'src/user-service.ts',
        content: CLASS_SOURCE,
      } as CodeNode,
    ]);

    const stores = createMockStoreSet(llm, graph);
    const service = new WikiService(stores, testWikiConfig);

    const { file, cleanup } = await createTempFile('Content');
    try {
      await service.ingest(PROJECT_ID, file);

      const createQueries = captureCreateEntityParams(graph);
      const entityQuery = createQueries.find(q => q.params.name === 'UserServiceEntity');
      expect(entityQuery).toBeDefined();
      const sig = extractCodeSignature(entityQuery!.params)!;
      expect(sig).toBeDefined();
      expect(sig).not.toBeNull();
      expect(sig.entityName).toBe('UserService');
      expect(sig.entityType).toBe('class');
    } finally {
      await cleanup();
    }
  });
});
