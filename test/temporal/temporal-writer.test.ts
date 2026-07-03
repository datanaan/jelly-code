import { describe, it, expect, vi } from 'vitest';
import {
  writeCommits,
  writeAuthors,
  writeChangedInRelations,
  writeAuthoredByRelations,
} from '../../src/temporal/temporal-writer.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import type {
  CommitData,
  AuthorInfo,
  ChangedInRelation,
  AuthoredByRelation,
} from '../../src/temporal/types.js';

/** Create a mock IGraphStore with vi.fn() for all methods */
function createMockGraphStore(): IGraphStore {
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
    batchCreateNodes: vi.fn().mockResolvedValue(undefined),
    batchCreateRelations: vi.fn().mockResolvedValue(undefined),
    findNodeIdsByFilePath: vi.fn(),
    findNodeIdsByFilePaths: vi.fn().mockResolvedValue(new Map()),
    deleteNodesByFilePath: vi.fn(),
    deleteNodesByIds: vi.fn(),
    query: vi.fn().mockResolvedValue([]),
    clearProject: vi.fn(),
    listProjects: vi.fn(),
    close: vi.fn(),
  };
}

describe('writeCommits', () => {
  it('should call batchCreateNodes with Commit nodes that have projectId', async () => {
    const store = createMockGraphStore();
    const commits: CommitData[] = [
      {
        hash: 'abc123def456',
        message: 'feat: add parser',
        author: 'Alice',
        authorEmail: 'alice@example.com',
        timestamp: '2026-01-15T10:00:00+08:00',
        additions: 10,
        deletions: 3,
        isMerge: false,
        changedFiles: [],
      },
    ];

    await writeCommits(commits, 'proj-1', store);

    expect(store.batchCreateNodes).toHaveBeenCalledTimes(1);
    const nodes = vi.mocked(store.batchCreateNodes).mock.calls[0][0] as any[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('abc123def456');
    expect(nodes[0].type).toBe('Commit');
    expect(nodes[0].projectId).toBe('proj-1');
    expect(nodes[0].message).toBe('feat: add parser');
    expect(nodes[0].author).toBe('Alice');
    expect(nodes[0].additions).toBe(10);
    expect(nodes[0].isMerge).toBe(false);
  });
});

describe('writeAuthors', () => {
  it('should call query with Author nodes that have NO projectId', async () => {
    const store = createMockGraphStore();
    const authors: AuthorInfo[] = [
      { name: 'Alice', email: 'alice@example.com', commitCount: 42, activeDays: 15 },
      { name: 'Bob', email: 'bob@example.com', commitCount: 10, activeDays: 5 },
    ];

    await writeAuthors(authors, store);

    expect(store.query).toHaveBeenCalledOnce();
    const [cypher, params] = vi.mocked(store.query).mock.calls[0] as [string, { rows: any[] }];
    expect(cypher).toContain('MERGE (n:Author {id: row.id})');
    expect(cypher).toContain('SET n += row');
    expect(params.rows).toHaveLength(2);
    expect(params.rows[0].id).toBe('alice@example.com');
    expect(params.rows[0].name).toBe('Alice');
    expect(params.rows[0].commitCount).toBe(42);
  });
});

describe('writeChangedInRelations', () => {
  it('should call batchCreateRelations with Relation objects containing CHANGED_IN type', async () => {
    const store = createMockGraphStore();
    const changes: ChangedInRelation[] = [
      {
        nodeId: 'node-1',
        commitHash: 'abc123',
        changeType: 'modified',
        additions: 5,
        deletions: 2,
        timestamp: '2026-01-15T10:00:00+08:00',
      },
    ];

    await writeChangedInRelations(changes, 'proj-1', store);

    expect(store.batchCreateRelations).toHaveBeenCalledTimes(1);
    const relations = vi.mocked(store.batchCreateRelations).mock.calls[0][0];

    expect(relations).toHaveLength(1);
    expect(relations[0].sourceId).toBe('node-1');
    expect(relations[0].targetId).toBe('abc123');
    expect(relations[0].type).toBe('CHANGED_IN');
    expect(relations[0].projectId).toBe('proj-1');
    expect((relations[0] as any).changeType).toBe('modified');
    expect((relations[0] as any).additions).toBe(5);
    expect((relations[0] as any).deletions).toBe(2);
  });
});

describe('writeAuthoredByRelations', () => {
  it('should resolve source labels and use label-specific Cypher with Author target', async () => {
    const store = createMockGraphStore();

    // Mock query to return label for source node resolution
    vi.mocked(store.query).mockResolvedValue([
      { id: 'node-1', label: 'Function' },
    ] as any);

    const ownerships: AuthoredByRelation[] = [
      {
        nodeId: 'node-1',
        authorEmail: 'alice@example.com',
        projectId: 'proj-1',
        changeCount: 10,
        lastChangeAt: '2026-01-15T10:00:00+08:00',
        ownership: 0.75,
      },
    ];

    await writeAuthoredByRelations(ownerships, store);

    // First call: resolve labels, second call: write relations
    expect(store.query).toHaveBeenCalledTimes(2);

    // Verify label resolution query
    const labelCall = vi.mocked(store.query).mock.calls[0];
    expect(labelCall[0]).toContain('labels(n)');
    expect(labelCall[0]).toContain('n.id IN $ids');

    // Verify relation write query
    const writeCall = vi.mocked(store.query).mock.calls[1];
    const [cypher, params] = writeCall;

    // Verify Cypher uses AUTHORED_BY type
    expect(cypher).toContain('AUTHORED_BY');
    // Verify label-specific source MATCH
    expect(cypher).toContain('MATCH (a:Function {id: row.sourceId, projectId: $projectId})');
    // Verify Author MATCH does NOT include projectId
    expect(cypher).toContain('MATCH (b:Author {id: row.targetId})');
    // Verify params
    expect((params as any).projectId).toBe('proj-1');
    expect((params as any).rows).toHaveLength(1);
    expect((params as any).rows[0].ownership).toBe(0.75);
  });
});
