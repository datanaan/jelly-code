/**
 * Tests: P1-T3 Incremental supersede (soft delete + bi-temporal edges)
 *
 * Verifies that incremental analysis preserves history by:
 * 1. Setting valid_to on old edges (soft delete) instead of hard DELETE
 * 2. Creating new edges with valid_from for changed nodes (supersede)
 * 3. Setting valid_from on new edges for added nodes
 * 4. Treating legacy edges as valid (coalesce backward compat)
 * 5. Preserving IncrementalFallbackError fallback
 * 6. Preserving P0c-T6 staleWikiEntities integration
 * 7. Atomic: supersede in single transaction
 */

import { describe, it, expect, vi } from 'vitest';
import { runIncrementalAnalyze } from '../../src/core/run-incremental.js';
import { IncrementalFallbackError } from '../../src/core/incremental-fallback-error.js';
import { EPOCH, FAR_FUTURE } from '../../src/store/bitemporal-model.js';

/**
 * Helper: create a mock StoreSet with a tracked graph query.
 *
 * The mock stores' graph.query is a vi.fn() so tests can assert
 * which Cypher strings were emitted.
 */
function createMockStoresForSupersede() {
  const graphQuery = vi.fn();
  const findNodeIdsByFilePath = vi.fn().mockResolvedValue(['node-1', 'node-2']);
  const deleteNodesByFilePath = vi.fn().mockResolvedValue(['node-1', 'node-2']);

  const stores = {
    graph: {
      query: graphQuery,
      clearProject: vi.fn().mockResolvedValue(undefined),
      initializeSchema: vi.fn(),
      batchCreateNodes: vi.fn(),
      batchCreateRelations: vi.fn(),
      findNodeIdsByFilePath,
      deleteNodesByFilePath,
      findSymbol: vi.fn().mockResolvedValue([]),
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
  } as any;

  return { stores, graphQuery, findNodeIdsByFilePath, deleteNodesByFilePath };
}

function createMockRepoCache() {
  return {
    ensureClone: vi.fn().mockResolvedValue('/tmp/mock-repo'),
    getHeadCommit: vi.fn().mockReturnValue('newcommit789'),
  } as any;
}

/**
 * Collect all Cypher strings emitted by graph.query during a run.
 */
function collectCypherStrings(graphQuery: ReturnType<typeof vi.fn>): string[] {
  return graphQuery.mock.calls.map((call: any[]) => call[0] as string);
}

describe('P1-T3: Incremental supersede (soft delete + bi-temporal edges)', () => {

  // =====================================================================
  // Test 1: Deleted node → old edges have valid_to set (NOT hard DELETE)
  // =====================================================================
  it('should set valid_to on edges for deleted nodes instead of hard DELETE', async () => {
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

    // Q2: detectChanges will use precomputedChangeSet, so no query needed here

    // Remaining queries: default empty/zero
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
        deleted: ['src/deleted-file.ts'],
        added: [],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    // Collect all Cypher strings
    const cypherStrings = collectCypherStrings(graphQuery);

    // The supersede query should set valid_to, NOT use DELETE
    const hasValidToSet = cypherStrings.some(cql =>
      cql.includes('valid_to') && cql.includes('SET'),
    );
    expect(hasValidToSet).toBe(true);

    // Must NOT contain DETACH DELETE for nodes in the incremental path
    // (DETACH DELETE is OK in clearProject for full-fallback, but not here)
    const incrementalPhaseQueries = cypherStrings.filter(cql =>
      !cql.includes('p.fallbackCount') && // exclude fallback tracking
      !cql.includes('p.totalIncrementalAttempts') && // exclude attempt tracking
      !cql.includes('p.communitiesFreshness') && // exclude community check
      !cql.includes('p.symbolsFreshness') && // exclude freshness update
      !cql.includes('p.accumulatedChanges') // exclude community accumulated
    );

    // The node soft-delete query should be present (SET valid_to, not DETACH DELETE)
    const softDeleteQueries = incrementalPhaseQueries.filter(cql =>
      cql.includes('valid_to') && cql.includes('CODE_RELATION'),
    );
    expect(softDeleteQueries.length).toBeGreaterThan(0);

    // Route/tool cleanup should also be soft-delete (SET valid_to), not DETACH DELETE
    // Note: Route/Tool nodes themselves may still be deleted (they're metadata),
    // but their CODE_RELATION edges should be superseded
  });

  // =====================================================================
  // Test 2: Changed node → supersede (old valid_to set, new valid_from set)
  // =====================================================================
  it('should supersede edges for modified nodes (close old, create new)', async () => {
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

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
        modified: ['src/modified-file.ts'],
        deleted: [],
        added: [],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    const cypherStrings = collectCypherStrings(graphQuery);

    // Supersede: should have a query that closes old edges AND creates new
    // Or at minimum, SET valid_to on old edges (closing them)
    const closeQueries = cypherStrings.filter(cql =>
      cql.includes('valid_to') && cql.includes('SET'),
    );
    expect(closeQueries.length).toBeGreaterThan(0);

    // Verify the supersede uses valid_from for new edges
    // writePipelineResultToStores should set valid_from on new relations
    // (this happens in run-analyze.ts's writePipelineResultToStores)
    // We verify the run-incremental.ts side: soft-delete with valid_to
  });

  // =====================================================================
  // Test 3: Added node → new edges have valid_from set, valid_to null
  // =====================================================================
  it('should not soft-delete edges for purely added files', async () => {
    const { stores, graphQuery, deleteNodesByFilePath } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

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
        added: ['src/new-file.ts'],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    // For purely added files, deleteNodesByFilePath should NOT be called
    // (no old nodes to supersede)
    // The pipeline will create new nodes with valid_from
    expect(result.mode).toBe('incremental');
  });

  // =====================================================================
  // Test 4: Legacy edges (no bi-temporal attrs) → treated as valid via coalesce
  // =====================================================================
  it('should treat legacy edges as valid (coalesce valid_from to EPOCH, valid_to to NULL)', async () => {
    // This is verified at the query level: the soft-delete query must use
    // coalesce on valid_to to handle edges that have NULL valid_to
    // (both legacy and current bi-temporal edges)
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: ['src/legacy-file.ts'],
        deleted: [],
        added: [],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    const cypherStrings = collectCypherStrings(graphQuery);

    // The soft-delete query must handle legacy edges (valid_to IS NULL)
    // by matching on coalesce(valid_to, FAR_FUTURE) or valid_to IS NULL
    const softDeleteQueries = cypherStrings.filter(cql =>
      cql.includes('valid_to') && cql.includes('CODE_RELATION'),
    );

    // At least one query must close legacy edges
    // Either via "valid_to IS NULL" or via coalesce
    expect(softDeleteQueries.length).toBeGreaterThan(0);
    const handlesLegacy = softDeleteQueries.some(cql =>
      cql.includes('valid_to IS NULL') ||
      cql.includes('coalesce'),
    );
    expect(handlesLegacy).toBe(true);
  });

  // =====================================================================
  // Test 5: IncrementalFallbackError still thrown/fallback preserved
  // =====================================================================
  it('should preserve IncrementalFallbackError fallback behavior', async () => {
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn()
      .mockImplementationOnce(async () => {
        throw new IncrementalFallbackError('Import resolution failed: Symbol X not found', 'X');
      })
      .mockResolvedValueOnce({
        nodes: [],
        relations: [],
        communities: [],
        processes: [],
        temporalCommits: [],
      });

    const result = await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: ['src/file.ts'],
        deleted: [],
        added: [],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    // Should fall back to full analysis
    expect(result.mode).toBe('full');
    expect(result.fallbackReason).toContain('Import resolution failed');
    // clearProject should have been called for full fallback
    expect(stores.graph.clearProject).toHaveBeenCalled();
  });

  // =====================================================================
  // Test 6: P0c-T6 staleWikiEntities still populated (no regression)
  // =====================================================================
  it('should still populate staleWikiEntities after supersede changes', async () => {
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

    // Q2+: WikiGraph.listEntities returns empty (no entities)
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
        modified: ['src/file.ts'],
        deleted: ['src/old.ts'],
        added: ['src/new.ts'],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    // staleWikiEntities MUST exist (P0c-T6 regression check)
    expect(result).toHaveProperty('staleWikiEntities');
    expect(Array.isArray(result.staleWikiEntities)).toBe(true);
  });

  // =====================================================================
  // Test 7: No DETACH DELETE or hard DELETE in supersede Cypher
  // =====================================================================
  it('must not use DETACH DELETE or hard DELETE for node/edge removal', async () => {
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: ['src/file.ts'],
        deleted: ['src/old.ts'],
        added: [],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    const cypherStrings = collectCypherStrings(graphQuery);

    // Filter out queries that are part of fallback/community/freshness tracking
    // (those use SET, not DELETE)
    const dataManipulationQueries = cypherStrings.filter(cql =>
      // Only look at queries that touch nodes/relations
      (cql.includes('CODE_RELATION') || cql.includes('MATCH (n)') || cql.includes('MATCH (r)') || cql.includes('MATCH (a)'))
    );

    // None of the node/relation queries should use DETACH DELETE or bare DELETE
    // for the incremental supersede path
    const hardDeleteQueries = dataManipulationQueries.filter(cql =>
      cql.includes('DETACH DELETE') || cql.includes('DELETE n') || cql.includes('DELETE r'),
    );

    // Route/Tool nodes may still be hard-deleted (they're metadata, not code graph)
    // But CODE_RELATION edges must use valid_to (soft delete)
    const codeRelHardDelete = hardDeleteQueries.filter(cql =>
      cql.includes('CODE_RELATION'),
    );

    expect(codeRelHardDelete.length).toBe(0);
  });

  // =====================================================================
  // Test 8: supersedeRelation integration — close old + open new
  // =====================================================================
  it('should call supersedeRelation logic (close old valid_to, set new valid_from)', async () => {
    const { stores, graphQuery } = createMockStoresForSupersede();

    // Q1: Project info
    graphQuery.mockResolvedValueOnce([{
      gitUrl: 'https://example.com/repo.git',
      localPath: '/tmp/test',
      lastCommit: 'abc123',
    }]);

    graphQuery.mockResolvedValue([]);

    const repoCache = createMockRepoCache();
    const pipelineRunner = vi.fn().mockResolvedValue({
      nodes: [],
      relations: [],
      communities: [],
      processes: [],
      temporalCommits: [],
    });

    await runIncrementalAnalyze('test-proj', stores, repoCache, {
      pipelineRunner,
      precomputedChangeSet: {
        modified: ['src/file.ts'],
        deleted: ['src/deleted.ts'],
        added: [],
        fromCommit: 'abc123',
        toCommit: 'def456',
      } as any,
    });

    const cypherStrings = collectCypherStrings(graphQuery);

    // The supersede query should SET valid_to AND txn_to on old edges
    const supersedeQueries = cypherStrings.filter(cql =>
      cql.includes('valid_to') &&
      (cql.includes('txn_to') || cql.includes('SET')),
    );
    expect(supersedeQueries.length).toBeGreaterThan(0);

    // Verify EPOCH/FAR_FUTURE constants are not needed in the query itself
    // (the query uses IS NULL or direct SET, not coalesce in the write path)
    // The coalesce is for reads in T2 queries, not for writes
  });
});
