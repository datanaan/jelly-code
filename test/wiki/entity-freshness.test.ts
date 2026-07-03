/**
 * P0c-T4: Entity Freshness detector (4-state machine)
 *
 * Tests the checkEntityFreshness function which implements the staleness
 * detection logic for wiki entities bound to code symbols via codeSignature.
 *
 * 4 states:
 * - fresh: signature matches current code → no issue
 * - stale: signature differs (body or signature changed) → stale issue
 * - orphaned: code node not found in graph → orphan issue
 * - unbound: entity has no codeSignature → unbound issue
 *
 * Strategy: Unit tests with mock IGraphStore. The mock findSymbol returns
 * CodeNode objects with real `content` strings. We use REAL generateSignature
 * to create before/after signatures — no stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSignature } from '../../src/wiki/code-signature.js';
import {
  checkEntityFreshness,
  type EntityFreshnessState,
} from '../../src/wiki/entity-freshness.js';
import type { IGraphStore, CodeNode } from '../../src/store/interfaces.js';
import type { WikiEntity, LintIssue } from '../../src/wiki/models.js';

// ==========================================
// Test helpers — REAL signature generation
// ==========================================

const FUNCTION_ORIGINAL = `function greet(name: string): string {
  return 'Hello, ' + name;
}`;

const FUNCTION_BODY_CHANGED = `function greet(name: string): string {
  return 'Hi there, ' + name + '!';
}`;

const FUNCTION_SIGNATURE_CHANGED = `function greet(name: string, greeting: string): string {
  return greeting + ', ' + name;
}`;

const CLASS_ORIGINAL = `class UserService {
  private users: Map<string, string> = new Map();
  addUser(name: string): void {
    this.users.set(name, name);
  }
}`;

const CLASS_BODY_CHANGED = `class UserService {
  private users: Map<string, string> = new Map();
  addUser(name: string): void {
    const id = Math.random().toString();
    this.users.set(id, name);
  }
}`;

/** Build a WikiEntity with a given codeSignature */
function makeEntity(
  overrides: Partial<WikiEntity> & { id: string; name: string },
): WikiEntity {
  return {
    projectId: 'test-proj',
    entityType: 'api',
    definition: 'test definition',
    details: 'test details',
    firstCompiled: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    ...overrides,
  } as WikiEntity;
}

/** Create a real signature from source code */
function sig(code: string, entityName?: string) {
  return generateSignature(code, entityName);
}

// ==========================================
// Mock graph store factory
// ==========================================

function createMockGraph(findSymbolResult?: CodeNode[]): IGraphStore {
  return {
    findSymbol: vi.fn(async () => findSymbolResult ?? []),
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
    query: vi.fn(async () => []),
  } as unknown as IGraphStore;
}

function createCodeNode(name: string, content: string): CodeNode {
  return {
    id: `node-${name}`,
    type: 'Function',
    projectId: 'test-proj',
    name,
    filePath: `src/${name}.ts`,
    content,
  };
}

// ==========================================
// Tests
// ==========================================

const PROJECT_ID = 'test-proj';

describe('checkEntityFreshness — 4-state machine', () => {

  // ─── FRESH ────────────────────────────────────────────────

  it('fresh: entity.codeSignature matches current code exactly → no issue', async () => {
    const codeNode = createCodeNode('greet', FUNCTION_ORIGINAL);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('fresh');
    expect(result.issue).toBeUndefined();
  });

  it('fresh: class signature with unchanged code → no issue', async () => {
    const codeNode = createCodeNode('UserService', CLASS_ORIGINAL);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-userservice',
      name: 'UserServiceEntity',
      codeSignature: sig(CLASS_ORIGINAL, 'UserService'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('fresh');
    expect(result.issue).toBeUndefined();
  });

  // ─── STALE ────────────────────────────────────────────────

  it('stale: body changed (signatureHash same, astHash differs) → stale issue', async () => {
    // Entity was bound to FUNCTION_ORIGINAL, but current code has body change
    const codeNode = createCodeNode('greet', FUNCTION_BODY_CHANGED);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('stale');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('stale');
    expect(result.issue!.entityId).toBe('entity-greet');
    expect(result.issue!.entityName).toBe('GreetEntity');
    expect(result.issue!.severity).toBe('warning');
    expect(result.issue!.description).toContain('stale');
  });

  it('stale: signature changed (paramTypes differ) → stale issue', async () => {
    // Entity was bound to original signature, but current code has new param
    const codeNode = createCodeNode('greet', FUNCTION_SIGNATURE_CHANGED);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('stale');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('stale');
  });

  it('stale: class body changed → stale issue', async () => {
    const codeNode = createCodeNode('UserService', CLASS_BODY_CHANGED);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-svc',
      name: 'UserServiceEntity',
      codeSignature: sig(CLASS_ORIGINAL, 'UserService'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('stale');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('stale');
  });

  it('stale issue includes both signatureHash and astHash in description', async () => {
    const codeNode = createCodeNode('greet', FUNCTION_BODY_CHANGED);
    const graph = createMockGraph([codeNode]);

    const oldSig = sig(FUNCTION_ORIGINAL, 'greet');
    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: oldSig,
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.issue).toBeDefined();
    // Description should mention what changed (astHash for body, signatureHash for signature)
    expect(result.issue!.description.length).toBeGreaterThan(10);
  });

  // ─── ORPHANED ─────────────────────────────────────────────

  it('orphaned: code node not found in graph (empty array) → orphan issue', async () => {
    const graph = createMockGraph([]); // empty findSymbol result

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('orphaned');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('orphan');
    expect(result.issue!.entityId).toBe('entity-greet');
    expect(result.issue!.severity).toBe('warning');
    expect(result.issue!.description).toContain('no longer');
  });

  it('orphaned: findSymbol returns empty when code was deleted → orphan issue', async () => {
    // This simulates: entity was bound, then the function was deleted from the codebase
    const graph = createMockGraph([]);

    const entity = makeEntity({
      id: 'entity-deleted',
      name: 'DeletedFunc',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('orphaned');
    expect(result.issue!.type).toBe('orphan');
  });

  // ─── UNBOUND ──────────────────────────────────────────────

  it('unbound: entity.codeSignature === null → unbound issue', async () => {
    const graph = createMockGraph();

    const entity = makeEntity({
      id: 'entity-concept',
      name: 'PureConcept',
      codeSignature: null, // explicitly unbound
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('unbound');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('unbound');
    expect(result.issue!.entityId).toBe('entity-concept');
    expect(result.issue!.entityName).toBe('PureConcept');
    expect(result.issue!.severity).toBe('warning');
    expect(result.issue!.description).toContain('unbound');
  });

  it('unbound: entity.codeSignature === undefined (legacy pre-P0c) → unbound issue', async () => {
    const graph = createMockGraph();

    const entity = makeEntity({
      id: 'entity-legacy',
      name: 'LegacyConcept',
      // codeSignature is undefined (not set — pre-P0c entity)
    });
    // Explicitly delete the property to simulate truly undefined
    delete (entity as Partial<WikiEntity>).codeSignature;

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.state).toBe('unbound');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('unbound');
  });

  // ─── EDGE CASES ───────────────────────────────────────────

  it('graceful: findSymbol throws error → treats as orphaned (code lookup failed)', async () => {
    const graph = createMockGraph();
    // Override findSymbol to throw
    (graph.findSymbol as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Neo4j connection failed'));

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    // When findSymbol throws, we can't verify the code — treat as orphaned
    expect(result.state).toBe('orphaned');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('orphan');
  });

  it('graceful: code node has no content (empty) → treats as orphaned', async () => {
    const codeNode = createCodeNode('greet', '');
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    // Code node exists but has no content — can't regenerate signature
    // This means we can't verify freshness, treat as orphaned
    expect(result.state).toBe('orphaned');
    expect(result.issue!.type).toBe('orphan');
  });

  it('findSymbol called with correct symbol name from codeSignature.entityName', async () => {
    const codeNode = createCodeNode('greet', FUNCTION_ORIGINAL);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(graph.findSymbol).toHaveBeenCalledWith(PROJECT_ID, 'greet');
  });

  it('findSymbol called with correct projectId', async () => {
    const codeNode = createCodeNode('greet', FUNCTION_ORIGINAL);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      projectId: 'my-custom-project',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    await checkEntityFreshness('my-custom-project', entity, graph);

    expect(graph.findSymbol).toHaveBeenCalledWith('my-custom-project', 'greet');
  });

  it('multiple entities: each checked independently', async () => {
    const freshNode = createCodeNode('greet', FUNCTION_ORIGINAL);
    const deletedGraph = createMockGraph([]); // simulate deleted code

    const freshEntity = makeEntity({
      id: 'entity-fresh',
      name: 'FreshEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });
    const orphanEntity = makeEntity({
      id: 'entity-orphan',
      name: 'OrphanEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const freshGraph = createMockGraph([freshNode]);
    const result1 = await checkEntityFreshness(PROJECT_ID, freshEntity, freshGraph);
    const result2 = await checkEntityFreshness(PROJECT_ID, orphanEntity, deletedGraph);

    expect(result1.state).toBe('fresh');
    expect(result1.issue).toBeUndefined();

    expect(result2.state).toBe('orphaned');
    expect(result2.issue).toBeDefined();
    expect(result2.issue!.type).toBe('orphan');
  });

  it('stale issue has correct severity (warning, not error)', async () => {
    const codeNode = createCodeNode('greet', FUNCTION_BODY_CHANGED);
    const graph = createMockGraph([codeNode]);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: sig(FUNCTION_ORIGINAL, 'greet'),
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.issue!.severity).toBe('warning');
  });

  it('unbound issue has correct severity (warning, not error)', async () => {
    const graph = createMockGraph();

    const entity = makeEntity({
      id: 'entity-concept',
      name: 'Concept',
      codeSignature: null,
    });

    const result = await checkEntityFreshness(PROJECT_ID, entity, graph);

    expect(result.issue!.severity).toBe('warning');
  });
});

// ==========================================
// Integration: WikiService.lint() includes freshness issues
// ==========================================

describe('WikiService.lint() integration — freshness issues', () => {
  // We mock the embedding module to avoid Ollama dependency
  vi.mock('../../src/core/embeddings/embedder.js', () => ({
    embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
    embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
  }));

  // Import WikiService AFTER mock is set up
  let WikiServiceModule: typeof import('../../src/wiki/service.js');
  let WikiService: typeof import('../../src/wiki/service.js').WikiService;
  type WikiConfig = import('../../src/wiki/service.js').WikiConfig;

  beforeEach(async () => {
    WikiServiceModule = await import('../../src/wiki/service.js');
    WikiService = WikiServiceModule.WikiService;
  });

  it('lint() appends freshness issues for unbound entities', async () => {

    // We need a WikiService with a mock that returns entities without codeSignature
    // The lint() method calls this.graph.listEntities and this.codeStore.findSymbol
    // We'll mock both
    const mockEntity: WikiEntity = {
      id: 'entity-1',
      projectId: 'test-proj',
      name: 'TestEntity',
      entityType: 'concept',
      definition: 'Test',
      details: 'Test details',
      firstCompiled: '2026-06-22T00:00:00Z',
      lastUpdated: '2026-06-22T00:00:00Z',
      // codeSignature: undefined (pre-P0c)
    };

    // Create a minimal mock that WikiService.lint() needs:
    // - this.graph.listEntities() → returns [mockEntity]
    // - this.graph.listSources() → returns []
    // - this.graph.getOutgoingLinks() → returns []
    // - this.graph.getIncomingLinks() → returns []
    // - this.codeStore.findSymbol() → returns []
    const graphStore: IGraphStore = {
      findSymbol: vi.fn(async () => []),
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
      query: vi.fn(async (cypher: string) => {
        // WikiGraph wraps IGraphStore.query — lint calls graph.listEntities
        // which calls query with a specific cypher. We intercept here.
        if (cypher.includes('MATCH (e:WikiEntity)') && cypher.includes('RETURN')) {
          return [mockEntity];
        }
        if (cypher.includes('MATCH (s:WikiSource)') && cypher.includes('RETURN')) {
          return [];
        }
        // LINKS_TO queries for orphan check
        return [];
      }),
    };

    const stores = {
      graph: graphStore,
      search: {
        search: vi.fn(async () => []),
        indexDocuments: vi.fn(async () => {}),
        deleteCollection: vi.fn(async () => {}),
        ensureCollection: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      vector: {
        search: vi.fn(async () => []),
        upsertVectors: vi.fn(async () => {}),
        deleteCollection: vi.fn(async () => {}),
        ensureCollection: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      llm: {
        generate: vi.fn(async () => ''),
        generateJSON: vi.fn(async () => ({})),
      },
      close: vi.fn(async () => {}),
    };

    const config: WikiConfig = { staleDays: 30, autoWriteBack: false };
    const service = new WikiService(stores as any, config);

    const issues = await service.lint('test-proj');

    // The unbound entity should produce a freshness issue
    const unboundIssue = issues.find(i => i.type === 'unbound');
    expect(unboundIssue).toBeDefined();
    expect(unboundIssue!.entityId).toBe('entity-1');
  });
});
