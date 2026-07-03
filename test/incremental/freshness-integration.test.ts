/**
 * Tests: P0c-T6 Freshness integration into incremental indexing
 *
 * Verifies that after incremental analysis completes, wiki entity freshness
 * is automatically checked and the result is attached to IncrementalResult.
 *
 * Key requirements:
 * 1. IncrementalResult has staleWikiEntities field after run
 * 2. staleWikiEntities is populated from checkEntityFreshness calls
 * 3. If freshness check throws, incremental still succeeds (defensive)
 * 4. If no wiki entities exist, staleWikiEntities is empty array
 */

import { describe, it, expect, vi } from 'vitest';
import { runIncrementalAnalyze, type IncrementalResult } from '../../src/core/run-incremental.js';

/**
 * Helper: create a minimal mock StoreSet for incremental tests.
 *
 * The mock stores graph.query is heavily used — different calls return
 * different data via mockResolvedValueOnce sequencing.
 */
function createMockStores(overrides?: {
  entities?: any[];
  codeNodes?: any[];
}) {
  const entities = overrides?.entities ?? [];
  const codeNodes = overrides?.codeNodes ?? [];

  const graphQuery = vi.fn();

  return {
    stores: {
      graph: {
        query: graphQuery,
        clearProject: vi.fn().mockResolvedValue(undefined),
        initializeSchema: vi.fn(),
        batchCreateNodes: vi.fn(),
        batchCreateRelations: vi.fn(),
        findNodeIdsByFilePath: vi.fn().mockResolvedValue([]),
        deleteNodesByFilePath: vi.fn().mockResolvedValue([]),
        findSymbol: vi.fn().mockResolvedValue(codeNodes),
        findSymbolByFile: vi.fn().mockResolvedValue([]),
        getNode: vi.fn(),
        getInboundRelations: vi.fn(),
        getOutboundRelations: vi.fn(),
        bfsTraverse: vi.fn(),
        findProcessesByNode: vi.fn(),
        findEntryPoint: vi.fn(),
        findCommunityByNode: vi.fn(),
        findNodeIdsByFilePaths: vi.fn(),
        deleteNodesByIds: vi.fn(),
        listProjects: vi.fn(),
        close: vi.fn(),
      } as any,
      search: {
        search: vi.fn(),
        indexDocuments: vi.fn(),
        deleteCollection: vi.fn(),
        ensureCollection: vi.fn(),
        deleteDocumentsByFilePath: vi.fn().mockResolvedValue(0),
        close: vi.fn(),
      } as any,
      vector: {
        search: vi.fn(),
        upsertVectors: vi.fn(),
        deleteCollection: vi.fn(),
        ensureCollection: vi.fn(),
        deleteVectorsByNodeIds: vi.fn().mockResolvedValue(0),
        close: vi.fn(),
      } as any,
      llm: {
        generate: vi.fn(),
        generateJSON: vi.fn(),
      } as any,
    } as any,
    graphQuery,
    entities,
  };
}

/**
 * Helper: create a mock RepoCacheManager.
 */
function createMockRepoCache() {
  return {
    ensureClone: vi.fn().mockResolvedValue('/tmp/mock-repo'),
    getHeadCommit: vi.fn().mockReturnValue('newcommit456'),
  } as any;
}

describe('P0c-T6: Freshness integration into incremental indexing', () => {

  // =====================================================================
  // Test 1: IncrementalResult has staleWikiEntities field after run
  // =====================================================================
  it('should include staleWikiEntities field in IncrementalResult after incremental run', async () => {
    const { stores, graphQuery } = createMockStores({ entities: [] });

    // Setup: project exists with gitUrl
    // Call 1: Project info query
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'old123',
    }]);

    // Call 2: detectChanges via graph query (returns null = no previous analysis)
    // → triggers full fallback path
    graphQuery.mockResolvedValueOnce([]); // no changes detected = null changeSet

    // Call 3+: various queries in the full run path
    graphQuery.mockResolvedValue([]); // default empty

    const repoCache = createMockRepoCache();

    // Mock pipelineRunner to return empty result
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    // detectChanges needs to return null for the full-fallback path
    // But we can't easily mock detectChanges — it's imported internally.
    // Instead, use precomputedChangeSet to bypass it.

    // With precomputedChangeSet having 0 changes, the function returns early.
    const result = await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: [],
        deleted: [],
        added: [],
        fromCommit: 'old123',
        toCommit: 'new456',
      } as any,
    });

    // Verify staleWikiEntities exists on the result
    expect(result).toHaveProperty('staleWikiEntities');
    expect(Array.isArray(result.staleWikiEntities)).toBe(true);
  });

  // =====================================================================
  // Test 2: staleWikiEntities is populated when entities are stale
  // =====================================================================
  it('should populate staleWikiEntities with stale entity IDs', async () => {
    // A wiki entity with a codeSignature that won't match the current code
    const staleEntity = {
      id: 'wiki-entity-1',
      projectId: 'test-proj',
      name: 'TestFunction',
      entityType: 'concept',
      definition: 'A test function',
      details: 'Details here',
      firstCompiled: '2025-01-01T00:00:00Z',
      lastUpdated: '2025-01-01T00:00:00Z',
      codeSignature: {
        entityName: 'TestFunction',
        signatureHash: 'old-hash-aaa',
        astHash: 'old-ast-hash-bbb',
        generatedAt: '2025-01-01T00:00:00Z',
        sourceSnippet: 'function TestFunction() { return 1; }',
      },
    };

    // Code node with different content → different hash → stale
    const codeNode = {
      id: 'code-node-1',
      name: 'TestFunction',
      content: 'function TestFunction() { return 2; }',
      filePath: 'src/test.ts',
    };

    const { stores, graphQuery } = createMockStores({
      entities: [staleEntity],
      codeNodes: [codeNode],
    });

    // Setup mock queries:
    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'old123',
    }]);

    // After the early return path (0 changes), freshness check runs.
    // Freshness check calls WikiGraph.listEntities which queries:
    // MATCH (e:WikiEntity) WHERE e.projectId = $projectId RETURN ...
    graphQuery.mockResolvedValueOnce([staleEntity]);

    // findSymbol is called by checkEntityFreshness — returns codeNode
    stores.graph.findSymbol.mockResolvedValue([codeNode]);

    // Default for remaining queries
    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    const result = await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: [],
        deleted: [],
        added: [],
        fromCommit: 'old123',
        toCommit: 'new456',
      } as any,
    });

    // The stale entity should appear in staleWikiEntities
    expect(result.staleWikiEntities).toBeDefined();
    expect(result.staleWikiEntities.length).toBeGreaterThan(0);
    expect(result.staleWikiEntities[0]).toHaveProperty('entityId', 'wiki-entity-1');
    expect(result.staleWikiEntities[0]).toHaveProperty('status', 'stale');
  });

  // =====================================================================
  // Test 3: Freshness check failure is non-fatal (defensive)
  // =====================================================================
  it('should return empty staleWikiEntities and still succeed if freshness check throws', async () => {
    const { stores, graphQuery } = createMockStores({ entities: [] });

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'old123',
    }]);

    // WikiGraph.listEntities query throws — simulating store error
    graphQuery.mockResolvedValueOnce(new Error('Neo4j connection lost'));

    // Default for remaining queries
    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    // The incremental should still succeed
    const result = await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: [],
        deleted: [],
        added: [],
        fromCommit: 'old123',
        toCommit: 'new456',
      } as any,
    });

    // Result should still be returned with empty staleWikiEntities
    expect(result).toBeDefined();
    expect(result.mode).toBe('incremental');
    expect(result.staleWikiEntities).toEqual([]);
  });

  // =====================================================================
  // Test 4: No wiki entities → empty staleWikiEntities
  // =====================================================================
  it('should return empty staleWikiEntities when no wiki entities exist', async () => {
    const { stores, graphQuery } = createMockStores({ entities: [] });

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'old123',
    }]);

    // WikiGraph.listEntities returns empty array
    graphQuery.mockResolvedValueOnce([]);

    // Default for remaining queries
    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    const result = await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: [],
        deleted: [],
        added: [],
        fromCommit: 'old123',
        toCommit: 'new456',
      } as any,
    });

    expect(result.staleWikiEntities).toEqual([]);
  });

  // =====================================================================
  // Test 5: Fresh entities (code matches) are NOT included in stale list
  // =====================================================================
  it('should NOT include fresh entities in staleWikiEntities', async () => {
    // We need a codeSignature that will match the code node exactly.
    // generateSignature produces a hash — we need to use the SAME content
    // to get matching hashes.
    const sourceContent = 'function TestFunction() { return 42; }';

    // First, generate the correct signature from the source
    const { generateSignature } = await import('../../src/wiki/code-signature.js');
    const correctSig = generateSignature(sourceContent, 'TestFunction');

    const freshEntity = {
      id: 'wiki-fresh-1',
      projectId: 'test-proj',
      name: 'TestFunction',
      entityType: 'concept',
      definition: 'A fresh function',
      details: 'Details',
      firstCompiled: '2025-01-01T00:00:00Z',
      lastUpdated: '2025-01-01T00:00:00Z',
      codeSignature: correctSig,
    };

    const codeNode = {
      id: 'code-1',
      name: 'TestFunction',
      content: sourceContent,
      filePath: 'src/test.ts',
    };

    const { stores, graphQuery } = createMockStores({
      entities: [freshEntity],
      codeNodes: [codeNode],
    });

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'old123',
    }]);

    // WikiGraph.listEntities returns the fresh entity
    graphQuery.mockResolvedValueOnce([freshEntity]);

    // findSymbol returns matching code node
    stores.graph.findSymbol.mockResolvedValue([codeNode]);

    // Default for remaining queries
    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    const result = await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: [],
        deleted: [],
        added: [],
        fromCommit: 'old123',
        toCommit: 'new456',
      } as any,
    });

    // Fresh entity should NOT be in the stale list
    expect(result.staleWikiEntities).toEqual([]);
  });
});
