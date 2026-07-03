/**
 * P2-T4: WikiTopic Storage — topicType field + generateEvolutionStory service method.
 *
 * Tests:
 *   1. WikiTopic accepts topicType='evolution'
 *   2. WikiTopic defaults topicType='general' (backward compat)
 *   3. generateEvolutionStory returns topic with topicType='evolution'
 *   4. generateEvolutionStory title contains "演化史" (or "Evolution")
 *   5. generateEvolutionStory stores to graph (verify createTopic call)
 *   6. generateEvolutionStory handles insufficient data (returns topic with "data insufficient" content)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the embedding module before importing WikiService
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
  embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
}));

import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import type { WikiTopic } from '../../src/wiki/models.js';
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';
import type { CompileOutput } from '../../src/wiki/models.js';

// ==========================================
// Mock Factories (mirrors service-auto-discover.test.ts)
// ==========================================

/**
 * Create a mock IGraphStore whose query() returns Neo4j-shaped rows.
 *
 * The temporal query functions (findCommitsByNode, findEvolvedFromChain, etc.)
 * internally parse Neo4j result rows. We need to return data in the same
 * shape that Neo4j would produce:
 *
 * - Commits: { c: { properties: { id, message, author, ... } } }
 * - EvolvedFrom: { previousNodeId, commitId, timestamp, ... }
 * - AuthoredBy: { authorId, authorName, changeCount, ... }
 * - CoChanged: { nodeB, coChangeCount, support, ... }
 * - BiTemporal: { valid_from, valid_to, ... }
 */
function createMockGraphWithData(
  options: {
    hasCommits?: boolean;
    hasEvolvedFrom?: boolean;
  } = {},
): IGraphStore {
  const { hasCommits = true, hasEvolvedFrom = false } = options;
  let evolvedFromCalled = false;

  const queryFn = vi.fn(async (cypher: string, _params: Record<string, unknown> = {}) => {
    // findCommitsByNode: MATCH ... RETURN c
    if (cypher.includes('CHANGED_IN') && cypher.includes('RETURN c')) {
      if (!hasCommits) return [];
      return [{
        c: {
          properties: {
            id: 'abcdef1234567890',
            message: 'fix: update function',
            author: 'dev1',
            authorEmail: 'dev1@test.com',
            timestamp: '2024-01-01T10:00:00Z',
            additions: 10,
            deletions: 5,
            isMerge: false,
          },
        },
      }];
    }

    // findEvolvedFromChain: MATCH ... RETURN prev.id AS previousNodeId ...
    if (cypher.includes('EVOLVED_FROM') && cypher.includes('previousNodeId')) {
      if (!hasEvolvedFrom || evolvedFromCalled) return [];
      evolvedFromCalled = true;
      return [{
        previousNodeId: 'old-node-1',
        originalName: 'oldName',
        originalFile: 'old-file.ts',
        commitId: 'evo1234567',
        timestamp: '2024-02-01T10:00:00Z',
      }];
    }

    // findAuthoredBy: MATCH ... RETURN a.id AS authorId ...
    if (cypher.includes('AUTHORED_BY') && cypher.includes('authorId')) {
      return [];
    }

    // findCoChangedWith: MATCH ... RETURN m.id AS nodeB ...
    if (cypher.includes('CO_CHANGED_WITH') || cypher.includes('nodeB')) {
      return [];
    }

    // BiTemporal findChangesBetween: MATCH ... RETURN ... valid_from ...
    if (cypher.includes('valid_from')) {
      return [];
    }

    // WikiTopic MERGE (createTopic)
    if (cypher.includes('WikiTopic') && cypher.includes('MERGE')) {
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

function createMockGraphEmpty(): IGraphStore {
  return createMockGraphWithData({ hasCommits: false, hasEvolvedFrom: false });
}

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

function createMockStoreSet(graph?: IGraphStore, llmResponse?: string): StoreSet {
  return {
    graph: graph ?? createMockGraphWithData(),
    search: createMockSearch(),
    vector: createMockVector(),
    llm: createMockLLM(llmResponse),
  };
}

const testWikiConfig: WikiConfig = {
  staleDays: 90,
  autoWriteBack: false,
};

// ==========================================
// Tests
// ==========================================

describe('WikiTopic.topicType', () => {
  it('accepts topicType=evolution', () => {
    const topic: WikiTopic = {
      id: 'topic-evolution-1',
      projectId: 'proj-1',
      title: 'Symbol 演化史',
      content: 'A narrative.',
      compiledAt: '2024-01-01T00:00:00Z',
      topicType: 'evolution',
    };

    expect(topic.topicType).toBe('evolution');
  });

  it('defaults topicType=general when not set (backward compat)', () => {
    // Construct without topicType — should still be valid
    const topic: WikiTopic = {
      id: 'topic-1',
      projectId: 'proj-1',
      title: 'General topic',
      content: 'Some content.',
      compiledAt: '2024-01-01T00:00:00Z',
    };

    // topicType should be optional; when undefined, consumers default to 'general'
    expect(topic.topicType ?? 'general').toBe('general');
  });
});

describe('WikiService.generateEvolutionStory', () => {
  let service: WikiService;
  let mockGraph: IGraphStore;

  beforeEach(() => {
    mockGraph = createMockGraphWithData({ hasCommits: true });
    const storeSet = createMockStoreSet(mockGraph, 'Evolution narrative for test symbol.');
    service = new WikiService(storeSet, testWikiConfig);
  });

  it('returns topic with topicType=evolution', async () => {
    const topic = await service.generateEvolutionStory('proj-1', 'node-abc');

    expect(topic).toBeDefined();
    expect(topic.topicType).toBe('evolution');
  });

  it('title contains "演化史" or "Evolution"', async () => {
    const topic = await service.generateEvolutionStory('proj-1', 'node-abc');

    expect(topic.title).toMatch(/演化史|Evolution/i);
  });

  it('stores to graph by calling createTopic (graph.query with MERGE WikiTopic)', async () => {
    const topic = await service.generateEvolutionStory('proj-1', 'node-abc');

    // The service should have called graph.query with a WikiTopic MERGE
    const queryFn = mockGraph.query as ReturnType<typeof vi.fn>;
    const calls = queryFn.mock.calls;
    const createTopicCall = calls.find(
      ([cypher]: [string]) => cypher.includes('WikiTopic') && cypher.includes('MERGE'),
    );

    expect(createTopicCall).toBeDefined();
    expect(topic.id).toMatch(/^topic-/);
  });

  it('handles insufficient data: returns topic with "data insufficient" content', async () => {
    // Use a graph mock that returns empty for all queries
    mockGraph = createMockGraphEmpty();
    const storeSet = createMockStoreSet(mockGraph, 'should not be used');
    service = new WikiService(storeSet, testWikiConfig);

    const topic = await service.generateEvolutionStory('proj-1', 'node-empty');

    expect(topic).toBeDefined();
    expect(topic.topicType).toBe('evolution');
    // Content should mention insufficient data
    expect(topic.content).toMatch(/insufficient|no.*data|无.*数据|数据.*不足|不足/i);
  });
});
