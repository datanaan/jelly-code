/**
 * Unit Tests: WikiGraph Neo4j operations
 * Updated for ISSUE-002: all methods now require projectId
 */

import { describe, it, expect, vi } from 'vitest';
import { WikiGraph } from '../../src/wiki/graph.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import type {
  WikiSource,
  WikiEntity,
  WikiTopic,
  WikiLogEntry,
} from '../../src/wiki/models.js';

const testProjectId = 'test-project';

function createMockGraph(): IGraphStore & { queries: Array<{ cypher: string; params: Record<string, unknown> }> } {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  return {
    queries,
    initializeSchema: async () => {},
    findSymbol: async () => [],
    findSymbolByFile: async () => [],
    getNode: async () => null,
    getInboundRelations: async () => [],
    getOutboundRelations: async () => [],
    bfsTraverse: async () => ({ visited: [], edges: [], depths: new Map() }),
    findProcessesByNode: async () => [],
    findEntryPoint: async () => null,
    findCommunityByNode: async () => null,
    batchCreateNodes: async () => {},
    batchCreateRelations: async () => {},
    clearProject: async () => {},
    listProjects: async () => [],
    close: async () => {},
    query: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      queries.push({ cypher, params });
      return [];
    }),
  } as unknown as IGraphStore & { queries: Array<{ cypher: string; params: Record<string, unknown> }> };
}

function createMockGraphWithResults(
  resultMap: Map<string, Record<string, unknown>[]>,
): IGraphStore {
  return {
    initializeSchema: async () => {},
    findSymbol: async () => [],
    findSymbolByFile: async () => [],
    getNode: async () => null,
    getInboundRelations: async () => [],
    getOutboundRelations: async () => [],
    bfsTraverse: async () => ({ visited: [], edges: [], depths: new Map() }),
    findProcessesByNode: async () => [],
    findEntryPoint: async () => null,
    findCommunityByNode: async () => null,
    batchCreateNodes: async () => {},
    batchCreateRelations: async () => {},
    clearProject: async () => {},
    listProjects: async () => [],
    close: async () => {},
    query: async (cypher: string, _params: Record<string, unknown> = {}) => {
      for (const [pattern, results] of resultMap.entries()) {
        if (cypher.includes(pattern)) return results;
      }
      return [];
    },
  } as unknown as IGraphStore;
}

function createIndexMockGraph(
  entities: Record<string, unknown>[],
  sources: Record<string, unknown>[],
  topics: Record<string, unknown>[],
): IGraphStore {
  const callIndex = { value: 0 };
  return {
    initializeSchema: async () => {},
    findSymbol: async () => [],
    findSymbolByFile: async () => [],
    getNode: async () => null,
    getInboundRelations: async () => [],
    getOutboundRelations: async () => [],
    bfsTraverse: async () => ({ visited: [], edges: [], depths: new Map() }),
    findProcessesByNode: async () => [],
    findEntryPoint: async () => null,
    findCommunityByNode: async () => null,
    batchCreateNodes: async () => {},
    batchCreateRelations: async () => {},
    clearProject: async () => {},
    listProjects: async () => [],
    close: async () => {},
    query: async (_cypher: string, _params: Record<string, unknown> = {}) => {
      const idx = callIndex.value++;
      if (idx === 0) return entities;
      if (idx === 1) return sources;
      if (idx === 2) return topics;
      return [];
    },
  } as unknown as IGraphStore;
}

const sampleSource: WikiSource = {
  id: 'source-test',
  projectId: testProjectId,
  title: 'Test Source',
  sourcePath: 'raw/specs/test.md',
  summary: 'A test source document',
  keyPoints: ['point1', 'point2'],
  compiledAt: '2026-05-19T12:00:00Z',
};

const sampleEntity: WikiEntity = {
  id: 'test-entity',
  projectId: testProjectId,
  name: 'Test Entity',
  entityType: 'concept',
  definition: 'A test entity definition',
  details: 'Detailed description here',
  firstCompiled: '2026-05-19T12:00:00Z',
  lastUpdated: '2026-05-19T12:00:00Z',
};

describe('WikiGraph Source', () => {
  it('creates a source node', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.createSource(sampleSource);

    expect(graph.queries.length).toBe(1);
    expect(graph.queries[0].cypher).toContain('WikiSource');
    expect(graph.queries[0].params.id).toBe('source-test');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
    expect(graph.queries[0].params.title).toBe('Test Source');
  });

  it('returns null when source not found', async () => {
    const graph = createMockGraphWithResults(new Map());
    const wiki = new WikiGraph(graph);
    const result = await wiki.getSource(testProjectId, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns source when found', async () => {
    const graph = createMockGraphWithResults(new Map([
      ['WikiSource', [{
        id: 'source-test',
        projectId: testProjectId,
        title: 'Test',
        sourcePath: 'raw/test.md',
        summary: 'Summary',
        keyPoints: ['p1'],
        compiledAt: '2026-05-19T12:00:00Z',
      }]],
    ]));
    const wiki = new WikiGraph(graph);
    const result = await wiki.getSource(testProjectId, 'source-test');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('source-test');
    expect(result!.sourcePath).toBe('raw/test.md');
  });

  it('lists source paths', async () => {
    const graph = createMockGraphWithResults(new Map([
      ['source_path', [
        { path: 'raw/a.md' },
        { path: 'raw/b.md' },
      ]],
    ]));
    const wiki = new WikiGraph(graph);
    const paths = await wiki.listSourcePaths(testProjectId);
    expect(paths).toEqual(['raw/a.md', 'raw/b.md']);
  });
});

describe('WikiGraph Entity', () => {
  it('creates an entity node', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.createEntity(sampleEntity);

    expect(graph.queries.length).toBe(1);
    expect(graph.queries[0].cypher).toContain('WikiEntity');
    expect(graph.queries[0].params.id).toBe('test-entity');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
    expect(graph.queries[0].params.entityType).toBe('concept');
  });

  it('updates entity with partial data', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.updateEntity(testProjectId, 'test-entity', {
      details: 'Updated details',
      lastUpdated: '2026-05-20T00:00:00Z',
    });

    expect(graph.queries[0].cypher).toContain('e.details = $details');
    expect(graph.queries[0].cypher).toContain('e.last_updated = $lastUpdated');
    expect(graph.queries[0].params.details).toBe('Updated details');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });

  it('finds entity by name', async () => {
    const graph = createMockGraphWithResults(new Map([
      ['WikiEntity', [{
        id: 'test-entity',
        projectId: testProjectId,
        name: 'Test Entity',
        entityType: 'concept',
        definition: 'Def',
        details: 'Details',
        firstCompiled: '2026-05-19T12:00:00Z',
        lastUpdated: '2026-05-19T12:00:00Z',
      }]],
    ]));
    const wiki = new WikiGraph(graph);
    const result = await wiki.findEntityByName(testProjectId, 'Test Entity');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Test Entity');
  });

  it('lists entities with type filter', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.listEntities(testProjectId, 'concept');

    expect(graph.queries[0].cypher).toContain('entity_type = $entityType');
    expect(graph.queries[0].params.entityType).toBe('concept');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });

  it('deletes entity with DETACH', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.deleteEntity(testProjectId, 'test-entity');

    expect(graph.queries[0].cypher).toContain('DETACH DELETE');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });
});

describe('WikiGraph Relations', () => {
  it('creates EXTRACTS relation', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.createExtractsRelation(testProjectId, 'source-1', 'entity-1', 'Document mentions entity');

    expect(graph.queries[0].cypher).toContain('EXTRACTS');
    expect(graph.queries[0].params.reason).toBe('Document mentions entity');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });

  it('creates SOURCED_FROM relation', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.createSourcedFromRelation(testProjectId, 'entity-1', 'source-1', 'Section 3');

    expect(graph.queries[0].cypher).toContain('SOURCED_FROM');
    expect(graph.queries[0].params.section).toBe('Section 3');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });

  it('creates LINKS_TO relation', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.createLinksToRelation(testProjectId, 'entity-a', 'entity-b', 'depends on');

    expect(graph.queries[0].cypher).toContain('LINKS_TO');
    expect(graph.queries[0].params.relationship).toBe('depends on');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });

  it('gets incoming links', async () => {
    const graph = createMockGraphWithResults(new Map([
      ['LINKS_TO', [{ id: 'other-1' }, { id: 'other-2' }]],
    ]));
    const wiki = new WikiGraph(graph);
    const links = await wiki.getIncomingLinks(testProjectId, 'target-entity');
    expect(links).toEqual(['other-1', 'other-2']);
  });

  it('gets outgoing links', async () => {
    const graph = createMockGraphWithResults(new Map([
      ['[r:LINKS_TO]->(other', [{ id: 'target-1' }]],
    ]));
    const wiki = new WikiGraph(graph);
    const links = await wiki.getOutgoingLinks(testProjectId, 'source-entity');
    expect(links).toEqual(['target-1']);
  });
});

describe('WikiGraph Log', () => {
  it('appends a log entry', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    const entry: WikiLogEntry = {
      id: 'log-001',
      projectId: testProjectId,
      action: 'ingest',
      description: 'Compiled test.md',
      details: 'Created 3 entities',
      pageCount: 4,
      createdAt: '2026-05-19T12:00:00Z',
    };
    await wiki.appendLog(entry);

    expect(graph.queries[0].cypher).toContain('WikiLogEntry');
    expect(graph.queries[0].params.action).toBe('ingest');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });
});

describe('WikiGraph Topic', () => {
  it('creates a topic', async () => {
    const graph = createMockGraph();
    const wiki = new WikiGraph(graph);
    await wiki.createTopic({
      id: 'topic-1',
      projectId: testProjectId,
      title: 'Test Topic',
      content: 'Topic content',
      compiledAt: '2026-05-19T12:00:00Z',
    });

    expect(graph.queries[0].cypher).toContain('WikiTopic');
    expect(graph.queries[0].params.title).toBe('Test Topic');
    expect(graph.queries[0].params.projectId).toBe(testProjectId);
  });
});

describe('WikiGraph Index', () => {
  it('returns aggregated index', async () => {
    const graph = createIndexMockGraph(
      [
        { id: 'e1', name: 'Entity1', type: 'concept', linkCount: 3 },
        { id: 'e2', name: 'Entity2', type: 'project', linkCount: 1 },
      ],
      [{ id: 's1', title: 'Source1', entityCount: 2 }],
      [{ id: 't1', title: 'Topic1' }],
    );
    const wiki = new WikiGraph(graph);
    const index = await wiki.getIndex(testProjectId);

    expect(index.entities).toHaveLength(2);
    expect(index.sources).toHaveLength(1);
    expect(index.topics).toHaveLength(1);
    expect(index.entities[0].name).toBe('Entity1');
    expect(index.sources[0].entityCount).toBe(2);
  });
});
