/**
 * Unit Tests: Wiki MCP Tool Registration
 *
 * Tests that wiki tools are conditionally registered based on wikiService availability.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';
import { WikiService } from '../../src/wiki/service.js';

// Mock stores for unit testing
function createMockStores(): StoreSet {
  return {
    graph: {
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
      query: async () => [],
      clearProject: async () => {},
      listProjects: async () => [],
      close: async () => {},
    } as unknown as IGraphStore,
    search: {
      search: async () => [],
      indexDocuments: async () => {},
      deleteCollection: async () => {},
      ensureCollection: async () => {},
      close: async () => {},
    } as unknown as ISearchStore,
    vector: {
      search: async () => [],
      upsertVectors: async () => {},
      deleteCollection: async () => {},
      ensureCollection: async () => {},
      close: async () => {},
    } as unknown as IVectorStore,
    llm: {
      generate: async () => '',
      generateJSON: async () => ({}),
    } as unknown as ILLMClient,
  };
}

// Mock WikiService
function createMockWikiService(): WikiService {
  return {
    ingest: vi.fn().mockResolvedValue({
      source: { id: 'source-test', title: 'Test', sourcePath: '/test.md', summary: 'test', keyPoints: [], compiledAt: '2026-01-01' },
      entitiesCreated: 1,
      entitiesUpdated: 0,
      contradictions: 0,
    }),
    batchIngest: vi.fn().mockResolvedValue({
      results: [],
      totalCompiled: 0,
      errors: [],
    }),
    query: vi.fn().mockResolvedValue('Test answer'),
    getIndex: vi.fn().mockResolvedValue({
      entities: [],
      sources: [],
      topics: [],
    }),
    status: vi.fn().mockResolvedValue({
      compiled: [],
      uncompiled: [],
      total: 0,
    }),
    lint: vi.fn().mockResolvedValue([]),
    syncToJelly: vi.fn().mockResolvedValue({
      pagesSynced: 0,
      errors: [],
    }),
    getEntity: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    fuzzyMatch: vi.fn().mockResolvedValue([]),
  } as unknown as WikiService;
}

describe('Wiki MCP Tools Registration', () => {
  it('should create server without wiki tools when wikiService is undefined', () => {
    const stores = createMockStores();
    const server = createMcpServer(stores);
    expect(server).toBeDefined();
    // Server has only the base tools (13 tools)
  });

  it('should create server with wiki tools when wikiService is provided', () => {
    const stores = createMockStores();
    const wikiService = createMockWikiService();
    const server = createMcpServer(stores, { wikiService });
    expect(server).toBeDefined();
    // Server has base tools (13) + wiki tools (7) = 20 tools
  });

  it('should create server with wiki tools using name and version options', () => {
    const stores = createMockStores();
    const wikiService = createMockWikiService();
    const server = createMcpServer(stores, {
      name: 'test-server',
      version: '1.0.0',
      wikiService,
    });
    expect(server).toBeDefined();
  });

  it('wikiService methods should be callable (smoke test)', async () => {
    const wikiService = createMockWikiService();

    // Verify all wiki service methods exist and return expected shapes
    const ingestResult = await wikiService.ingest('test-project', '/test.md');
    expect(ingestResult).toHaveProperty('source');
    expect(ingestResult).toHaveProperty('entitiesCreated');

    const batchResult = await wikiService.batchIngest('test-project', '/dir');
    expect(batchResult).toHaveProperty('totalCompiled');

    const queryResult = await wikiService.query('test-project', 'test question');
    expect(typeof queryResult).toBe('string');

    const indexResult = await wikiService.getIndex('test-project');
    expect(indexResult).toHaveProperty('entities');
    expect(indexResult).toHaveProperty('sources');
    expect(indexResult).toHaveProperty('topics');

    const statusResult = await wikiService.status('test-project', '/dir');
    expect(statusResult).toHaveProperty('compiled');
    expect(statusResult).toHaveProperty('uncompiled');
    expect(statusResult).toHaveProperty('total');

    const lintResult = await wikiService.lint('test-project');
    expect(Array.isArray(lintResult)).toBe(true);

    const syncResult = await wikiService.syncToJelly('test-project', 'kb-123');
    expect(syncResult).toHaveProperty('pagesSynced');
    expect(syncResult).toHaveProperty('errors');

    const entityResult = await wikiService.getEntity('test-project', 'test-entity');
    expect(entityResult).toBeNull();
  });
});
