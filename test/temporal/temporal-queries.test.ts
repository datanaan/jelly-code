import { describe, it, expect, vi } from 'vitest';
import {
  findCommitsByNode,
  findAuthors,
  countChangedInByNode,
} from '../../src/store/neo4j/temporal-queries.js';
import type { IGraphStore } from '../../src/store/interfaces.js';

/** Create a mock IGraphStore with vi.fn() for all methods */
function createMockGraphStore(
  queryResult: Record<string, unknown>[] = [],
): IGraphStore {
  return {
    initializeSchema: vi.fn(),
    findSymbol: vi.fn(),
    findSymbolByFile: vi.fn(),
    getNode: vi.fn(),
    getInboundRelations: vi.fn(),
    getOutboundRelations: vi.fn(),
    bfsTraverse: vi.fn(),
    findProcessesByNode: vi.fn(),
    findEntryPoint: vi.fn(),
    findCommunityByNode: vi.fn(),
    batchCreateNodes: vi.fn(),
    batchCreateRelations: vi.fn(),
    findNodeIdsByFilePath: vi.fn(),
    deleteNodesByFilePath: vi.fn(),
    deleteNodesByIds: vi.fn(),
    query: vi.fn().mockResolvedValue(queryResult),
    clearProject: vi.fn(),
    listProjects: vi.fn(),
    close: vi.fn(),
  };
}

describe('findCommitsByNode', () => {
  it('should return parsed CommitData from Neo4j commit nodes', async () => {
    const neo4jResults = [
      {
        c: {
          identity: 1,
          labels: ['Commit'],
          properties: {
            id: 'abc123def456',
            message: 'feat: add parser',
            author: 'Alice',
            authorEmail: 'alice@example.com',
            timestamp: '2026-01-15T10:00:00+08:00',
            additions: 10,
            deletions: 3,
            isMerge: false,
          },
          elementId: '1',
        },
      },
    ];

    const store = createMockGraphStore(neo4jResults);
    const commits = await findCommitsByNode(store, 'proj-1', 'node-1');

    expect(commits).toHaveLength(1);
    expect(commits[0].hash).toBe('abc123def456');
    expect(commits[0].message).toBe('feat: add parser');
    expect(commits[0].author).toBe('Alice');
    expect(commits[0].authorEmail).toBe('alice@example.com');
    expect(commits[0].timestamp).toBe('2026-01-15T10:00:00+08:00');
    expect(commits[0].additions).toBe(10);
    expect(commits[0].deletions).toBe(3);
    expect(commits[0].isMerge).toBe(false);
    expect(commits[0].changedFiles).toEqual([]);

    // Verify query was called with correct params
    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    expect(cypher).toContain('CHANGED_IN');
    expect(params).toEqual({ projectId: 'proj-1', nodeId: 'node-1' });
  });
});

describe('findAuthors', () => {
  it('should filter by projectId on the AUTHORED_BY relation', async () => {
    const neo4jResults = [
      {
        id: 'alice@example.com',
        name: 'Alice',
        email: 'alice@example.com',
        commitCount: 42,
        activeDays: 15,
      },
      {
        id: 'bob@example.com',
        name: 'Bob',
        email: 'bob@example.com',
        commitCount: 10,
        activeDays: 5,
      },
    ];

    const store = createMockGraphStore(neo4jResults);
    const authors = await findAuthors(store, 'proj-1');

    expect(authors).toHaveLength(2);
    expect(authors[0].id).toBe('alice@example.com');
    expect(authors[0].name).toBe('Alice');
    expect(authors[0].commitCount).toBe(42);
    expect(authors[0].activeDays).toBe(15);

    // Verify the Cypher filters by projectId on the relation
    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    expect(cypher).toContain('AUTHORED_BY');
    expect(cypher).toContain('projectId: $projectId');
    expect(params).toEqual({ projectId: 'proj-1' });
  });
});

describe('countChangedInByNode', () => {
  it('should return aggregated change counts per node', async () => {
    const neo4jResults = [
      { nodeId: 'node-hot-1', changeCount: 25 },
      { nodeId: 'node-hot-2', changeCount: 18 },
      { nodeId: 'node-calm', changeCount: 3 },
    ];

    const store = createMockGraphStore(neo4jResults);
    const counts = await countChangedInByNode(store, 'proj-1');

    expect(counts).toHaveLength(3);
    expect(counts[0].nodeId).toBe('node-hot-1');
    expect(counts[0].changeCount).toBe(25);
    expect(counts[1].nodeId).toBe('node-hot-2');
    expect(counts[1].changeCount).toBe(18);
    expect(counts[2].nodeId).toBe('node-calm');
    expect(counts[2].changeCount).toBe(3);

    // Verify the Cypher uses correct aggregation
    const [cypher, params] = vi.mocked(store.query).mock.calls[0];
    expect(cypher).toContain('CHANGED_IN');
    expect(cypher).toContain('count(r)');
    expect(cypher).toContain('changeCount DESC');
    expect(params).toEqual({ projectId: 'proj-1' });
  });
});
