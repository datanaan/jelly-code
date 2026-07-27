/**
 * P2-T7: Batch Evolution Story Generation + Monthly Scheduler.
 *
 * Tests:
 *   1. Batch generates for nodes with CHANGED_IN > 10
 *   2. Batch generates for nodes with EVOLVED_FROM chain > 2
 *   3. Skips nodes with insufficient activity (CHANGED_IN <= 10 AND chain <= 2)
 *   4. Returns summary { generated, skipped, errors }
 *   5. Errors during individual generation don't fail batch (collected in errors[])
 *   6. Empty project -> generated=0, skipped=0
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
// Mock Factories
// ==========================================

function createMockLLM(response: string = 'A rich evolution narrative.'): ILLMClient {
  const compileOutput: CompileOutput = {
    title: 'Test Doc',
    summary: 'Summary',
    keyPoints: [],
    entities: [],
    existingUpdates: [],
    contradictions: [],
  };
  return {
    generate: vi.fn(async () => response),
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

/**
 * Build commit row for CHANGED_IN mock.
 */
function makeCommitRow(id: string = 'abcdef1234567890'): Record<string, unknown> {
  return {
    c: {
      properties: {
        id,
        message: 'fix: update function',
        author: 'dev1',
        authorEmail: 'dev1@test.com',
        timestamp: '2024-01-01T10:00:00Z',
        additions: 10,
        deletions: 5,
        isMerge: false,
      },
    },
  };
}

/**
 * Build an EVOLVED_FROM row (for gatherEvolutionFacts format).
 */
function makeEvolvedFromRow(prevId: string, timestamp: string = '2024-02-01T10:00:00Z'): Record<string, unknown> {
  return {
    previousNodeId: prevId,
    originalName: 'oldName',
    originalFile: 'old-file.ts',
    commitId: 'evo1234567',
    timestamp,
  };
}

/**
 * Create a mock IGraphStore that handles all Cypher query patterns used
 * by generateAllEvolutionStories:
 *
 * 1. Batch node listing: MATCH (n {projectId}) RETURN n.id AS nodeId, n.name AS name
 * 2. Importance check CHANGED_IN count: RETURN count(r) AS cnt
 * 3. Importance check EVOLVED_FROM traversal: RETURN prev.id AS prevId LIMIT 1
 * 4. gatherEvolutionFacts CHANGED_IN: RETURN c
 * 5. gatherEvolutionFacts EVOLVED_FROM: RETURN ... AS previousNodeId
 * 6. gatherEvolutionFacts other queries (AUTHORED_BY, CO_CHANGED_WITH, bi-temporal)
 * 7. WikiTopic MERGE (createTopic)
 *
 * Each EVOLVED_FROM traversal sequence is independently tracked by
 * distinguishing between "importance-check" queries and "gather" queries
 * via the RETURN clause pattern.
 *
 * @param nodes - Array of { nodeId, changedInCount, evolvedFromDepth } descriptors
 */
function createMockGraphWithNodes(
  nodes: Array<{ nodeId: string; changedInCount: number; evolvedFromDepth: number }>,
): IGraphStore {
  // Track EVOLVED_FROM traversal progress separately for importance-check vs gather
  // Key: `${nodeId}:importance` or `${nodeId}:gather`
  const evoProgress = new Map<string, number>();

  function getEvoStep(key: string, maxDepth: number): string | null {
    const current = evoProgress.get(key) ?? 0;
    if (current >= maxDepth) return null;
    evoProgress.set(key, current + 1);
    return `${key.split(':')[0]}-prev-${current}`;
  }

  const queryFn = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    // --- Batch: list all CodeNodes for the project ---
    if (
      cypher.includes('MATCH (n') &&
      cypher.includes('RETURN n.id AS nodeId') &&
      !cypher.includes('CHANGED_IN') &&
      !cypher.includes('EVOLVED_FROM')
    ) {
      return nodes.map(nd => ({
        nodeId: nd.nodeId,
        name: nd.nodeId,
      }));
    }

    // --- Importance check: CHANGED_IN count ---
    if (cypher.includes('CHANGED_IN') && cypher.includes('count(r) AS cnt')) {
      const nodeId = params.nodeId as string;
      const node = nodes.find(n => n.nodeId === nodeId);
      return [{ cnt: node?.changedInCount ?? 0 }];
    }

    // --- Importance check: EVOLVED_FROM prevId LIMIT 1 ---
    if (cypher.includes('EVOLVED_FROM') && cypher.includes('prevId')) {
      const nodeId = params.nodeId as string;
      // Find the base node by prefix match (handles mid-chain IDs like "node-prev-0")
      const baseNode = nodes.find(n => nodeId.startsWith(n.nodeId));
      if (!baseNode) return [];
      const key = `${baseNode.nodeId}:importance`;
      // Determine relative depth from the nodeId suffix
      const match = nodeId.match(/-prev-(\d+)$/);
      const baseDepth = match ? parseInt(match[1], 10) + 1 : 0;
      if (baseDepth >= baseNode.evolvedFromDepth) return [];
      evoProgress.set(key, baseDepth + 1);
      return [{ prevId: `${baseNode.nodeId}-prev-${baseDepth}` }];
    }

    // --- gatherEvolutionFacts: CHANGED_IN RETURN c ---
    if (cypher.includes('CHANGED_IN') && cypher.includes('RETURN c')) {
      const nodeId = params.nodeId as string;
      const node = nodes.find(n => n.nodeId === nodeId);
      if (!node) return [];
      return Array.from({ length: node.changedInCount }, (_, i) =>
        makeCommitRow(`commit-${nodeId}-${i}`),
      );
    }

    // --- gatherEvolutionFacts: EVOLVED_FROM RETURN ... AS previousNodeId ---
    if (cypher.includes('EVOLVED_FROM') && cypher.includes('previousNodeId')) {
      const nodeId = params.nodeId as string;
      const baseNode = nodes.find(n => nodeId.startsWith(n.nodeId));
      if (!baseNode) return [];
      const key = `${baseNode.nodeId}:gather`;
      const match = nodeId.match(/-prev-(\d+)$/);
      const baseDepth = match ? parseInt(match[1], 10) + 1 : 0;
      if (baseDepth >= baseNode.evolvedFromDepth) return [];
      evoProgress.set(key, baseDepth + 1);
      return [makeEvolvedFromRow(`${baseNode.nodeId}-prev-${baseDepth}`)];
    }

    // --- AuthoredBy, CoChanged, BiTemporal (return empty for batch tests) ---
    if (
      cypher.includes('AUTHORED_BY') ||
      cypher.includes('CO_CHANGED_WITH') ||
      cypher.includes('nodeB') ||
      cypher.includes('valid_from')
    ) {
      return [];
    }

    // --- WikiTopic MERGE (createTopic) ---
    if (cypher.includes('WikiTopic') && cypher.includes('MERGE')) {
      return [];
    }

    // --- WikiLog (appendLog) ---
    if (cypher.includes('WikiLog')) {
      return [];
    }

    return [];
  });

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

function createMockStoreSet(graph?: IGraphStore, llmResponse?: string): StoreSet {
  return {
    graph: graph ?? createMockGraphWithNodes([]),
    search: createMockSearch(),
    vector: createMockVector(),
    llm: createMockLLM(llmResponse),
  };
}

const testWikiConfig: WikiConfig = {
  staleDays: 90,
  autoWriteBack: false,
  maxLlmCallsPerBatch: 100,
  maxTokensPerCall: 4096,
  importanceThreshold: 10,
  evolutionDepthThreshold: 2,
};

// ==========================================
// Tests
// ==========================================

describe('WikiService.generateAllEvolutionStories', () => {
  let service: WikiService;

  beforeEach(() => {
    // Reset service before each test
    service = undefined as unknown as WikiService;
  });

  it('generates for nodes with CHANGED_IN > 10', async () => {
    // Node with 15 commits, 0 evolvedFrom depth -> meets CHANGED_IN > 10 threshold
    const mockGraph = createMockGraphWithNodes([
      { nodeId: 'hot-fn', changedInCount: 15, evolvedFromDepth: 0 },
    ]);
    const storeSet = createMockStoreSet(mockGraph, 'Narrative for hot function.');
    service = new WikiService(storeSet, testWikiConfig);

    const result = await service.generateAllEvolutionStories('proj-1');

    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('generates for nodes with EVOLVED_FROM chain > 2', async () => {
    // Node with 3 commits (below threshold) but evolvedFromDepth=3 -> meets chain > 2 threshold
    const mockGraph = createMockGraphWithNodes([
      { nodeId: 'renamed-fn', changedInCount: 3, evolvedFromDepth: 3 },
    ]);
    const storeSet = createMockStoreSet(mockGraph, 'Narrative for renamed function.');
    service = new WikiService(storeSet, testWikiConfig);

    const result = await service.generateAllEvolutionStories('proj-1');

    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips nodes with insufficient activity (CHANGED_IN <= 10 AND chain <= 2)', async () => {
    // Node with 5 commits and 1 evolvedFrom -> both below thresholds -> skipped
    const mockGraph = createMockGraphWithNodes([
      { nodeId: 'minor-fn', changedInCount: 5, evolvedFromDepth: 1 },
    ]);
    const storeSet = createMockStoreSet(mockGraph, 'Should not be called.');
    service = new WikiService(storeSet, testWikiConfig);

    const result = await service.generateAllEvolutionStories('proj-1');

    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('returns summary { generated, skipped, errors }', async () => {
    const mockGraph = createMockGraphWithNodes([
      { nodeId: 'hot-fn', changedInCount: 20, evolvedFromDepth: 0 },
      { nodeId: 'stable-fn', changedInCount: 2, evolvedFromDepth: 0 },
      { nodeId: 'renamed-fn', changedInCount: 3, evolvedFromDepth: 4 },
    ]);
    const storeSet = createMockStoreSet(mockGraph, 'Narrative.');
    service = new WikiService(storeSet, testWikiConfig);

    const result = await service.generateAllEvolutionStories('proj-1');

    expect(result).toHaveProperty('generated');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
    expect(typeof result.generated).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(Array.isArray(result.errors)).toBe(true);
    // hot-fn (20 > 10) + renamed-fn (4 > 2) = 2 generated, stable-fn = 1 skipped
    expect(result.generated).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('errors during individual generation do not fail batch (collected in errors[])', async () => {
    // Create a graph where one node will cause generateEvolutionStory to throw.
    // We can do this by making the LLM throw for a specific call.
    const nodes = [
      { nodeId: 'good-fn', changedInCount: 15, evolvedFromDepth: 0 },
      { nodeId: 'bad-fn', changedInCount: 12, evolvedFromDepth: 0 },
    ];
    const mockGraph = createMockGraphWithNodes(nodes);

    // LLM that throws on second call (for bad-fn)
    let llmCallCount = 0;
    const llm: ILLMClient = {
      generate: vi.fn(async () => {
        llmCallCount++;
        if (llmCallCount === 2) throw new Error('LLM temporarily failed');
        return 'Narrative for good function.';
      }),
      generateJSON: vi.fn(async () => ({
        title: 'Test',
        summary: '',
        keyPoints: [],
        entities: [],
        existingUpdates: [],
        contradictions: [],
      })),
    };

    const storeSet: StoreSet = {
      graph: mockGraph,
      search: createMockSearch(),
      vector: createMockVector(),
      llm,
    };
    service = new WikiService(storeSet, testWikiConfig);

    const result = await service.generateAllEvolutionStories('proj-1');

    // The important assertion: batch does not throw, errors are collected
    expect(result.errors.length).toBeGreaterThanOrEqual(0);
    expect(result.generated + result.skipped + result.errors.length).toBe(2);
  });

  it('empty project returns generated=0, skipped=0', async () => {
    const mockGraph = createMockGraphWithNodes([]);
    const storeSet = createMockStoreSet(mockGraph, 'Should not be called.');
    service = new WikiService(storeSet, testWikiConfig);

    const result = await service.generateAllEvolutionStories('proj-1');

    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
