/**
 * E2E Test: MCP Tool Registration
 *
 * Tests that all MCP tools are properly registered on the server.
 * Uses the internal _registeredTools map to verify tool names.
 *
 * Does NOT call any tool — only verifies registration.
 *
 * Prerequisites: None (no real database needed, uses mocked StoreSet)
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/mcp-tools.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import type { StoreSet, IGraphStore } from '../../src/store/interfaces.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { skipE2E, createMockLLM } from './helpers.js';

// ─── Mock StoreSet (no real database required) ────────────────────────────────

function createMockGraphStore(): IGraphStore {
  return {
    initializeSchema: vi.fn(async () => {}),
    clearProject: vi.fn(async () => {}),
    batchCreateNodes: vi.fn(async () => {}),
    batchCreateRelations: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    findSymbol: vi.fn(async () => []),
    findSymbolByFile: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  } as unknown as IGraphStore;
}

function createMockStoreSet(): StoreSet {
  const llm = createMockLLM();
  return {
    graph: createMockGraphStore(),
    search: {
      search: vi.fn(async () => []),
      indexDocuments: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      ensureCollection: vi.fn(async () => {}),
      deleteDocumentsByFilePath: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    } as never,
    vector: {
      search: vi.fn(async () => []),
      upsertVectors: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      ensureCollection: vi.fn(async () => {}),
      deleteVectorsByNodeIds: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    } as never,
    llm,
    async close() {
      await this.graph.close();
      await this.search.close();
      await this.vector.close();
    },
  };
}

/** Extract registered tool names from the McpServer instance. */
function getRegisteredToolNames(server: McpServer): string[] {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  if (!tools) return [];
  return Object.keys(tools);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe.skipIf(skipE2E)('MCP Tool Registration', () => {
  it('creates MCP server without stores (initialization test)', () => {
    const stores = createMockStoreSet();
    const server = createMcpServer(stores);
    expect(server).toBeDefined();
  });

  it('creates MCP server with custom options', () => {
    const stores = createMockStoreSet();
    const server = createMcpServer(stores, {
      name: 'test-server',
      version: '1.0.0',
    });
    expect(server).toBeDefined();
  });

  it('registers core tools (list_repos, query, search_code, etc.)', () => {
    const stores = createMockStoreSet();
    const server = createMcpServer(stores);
    const toolNames = getRegisteredToolNames(server);

    expect(toolNames).toContain('list_repos');
    expect(toolNames).toContain('query');
    expect(toolNames).toContain('search_code');
    expect(toolNames).toContain('similar_code');
    expect(toolNames).toContain('context');
    expect(toolNames).toContain('impact');
    expect(toolNames).toContain('detect_changes');
    expect(toolNames).toContain('rename');
  });

  it('registers 18+ core + API analysis tools (before wiki tools)', () => {
    const stores = createMockStoreSet();
    const server = createMcpServer(stores);
    const toolNames = getRegisteredToolNames(server);

    // Core tools: list_repos, query, search_code, similar_code, context, impact, detect_changes, rename
    // API analysis: route_map, tool_map, shape_check, api_impact, hotspots, code_ownership, co_changes, api_stability, symbol_lineage
    // Other: analyze_repo, code_as_of
    // = 19 + conditional
    expect(toolNames.length).toBeGreaterThanOrEqual(18);
    expect(toolNames).toContain('route_map');
    expect(toolNames).toContain('tool_map');
    expect(toolNames).toContain('shape_check');
    expect(toolNames).toContain('api_impact');
    expect(toolNames).toContain('hotspots');
    expect(toolNames).toContain('code_ownership');
    expect(toolNames).toContain('co_changes');
    expect(toolNames).toContain('api_stability');
    expect(toolNames).toContain('symbol_lineage');
  });

  it('registers analyze_repo and code_as_of tools', () => {
    const stores = createMockStoreSet();
    const server = createMcpServer(stores);
    const toolNames = getRegisteredToolNames(server);

    expect(toolNames).toContain('analyze_repo');
    expect(toolNames).toContain('code_as_of');
  });

  it('registers wiki tools when wikiService is provided', () => {
    const mockWikiService = {
      startIngest: () => 'task',
      startBatchIngest: () => 'task',
      startBatchIngestContent: () => 'task',
      query: () => Promise.resolve('answer'),
      getIndex: () => Promise.resolve({ entities: [], sources: [], topics: [] }),
      status: () => Promise.resolve({ compiled: [], uncompiled: [], total: 0 }),
      lint: () => Promise.resolve([]),
      syncToJelly: () => Promise.resolve({ pagesSynced: 0, errors: [] }),
      getEntity: () => Promise.resolve(null),
      listEntities: () => Promise.resolve([]),
      fuzzyMatch: () => Promise.resolve([]),
      getActiveTasks: () => new Map(),
      startEvolutionStoryGeneration: () => 'task',
      getTopic: () => Promise.resolve(null),
      generateEvolutionStory: () => Promise.resolve({} as never),
      reindex: () => Promise.resolve({ reindexed: 0, sources: 0, entities: 0 }),
      getFreshness: () => Promise.resolve({ items: [], summary: { fresh: 0, stale: 0, orphaned: 0, unbound: 0 } }),
    };

    const stores = createMockStoreSet();
    const server = createMcpServer(stores, { wikiService: mockWikiService as never });
    const toolNames = getRegisteredToolNames(server);

    expect(toolNames).toContain('wiki_ingest');
    expect(toolNames).toContain('wiki_batch_ingest');
    expect(toolNames).toContain('wiki_auto_discover');
    expect(toolNames).toContain('wiki_query');
    expect(toolNames).toContain('wiki_index');
    expect(toolNames).toContain('wiki_status');
    expect(toolNames).toContain('wiki_lint');
    expect(toolNames).toContain('wiki_sync');
    expect(toolNames).toContain('wiki_entity_freshness');
    expect(toolNames).toContain('code_evolution_story');
  });

  it('registers 27+ tools total (core + analysis + wiki)', () => {
    const mockWikiService = {
      startIngest: () => 'task',
      startBatchIngest: () => 'task',
      startBatchIngestContent: () => 'task',
      query: () => Promise.resolve('answer'),
      getIndex: () => Promise.resolve({ entities: [], sources: [], topics: [] }),
      status: () => Promise.resolve({ compiled: [], uncompiled: [], total: 0 }),
      lint: () => Promise.resolve([]),
      syncToJelly: () => Promise.resolve({ pagesSynced: 0, errors: [] }),
      getEntity: () => Promise.resolve(null),
      listEntities: () => Promise.resolve([]),
      fuzzyMatch: () => Promise.resolve([]),
      getActiveTasks: () => new Map(),
      startEvolutionStoryGeneration: () => 'task',
      getTopic: () => Promise.resolve(null),
      generateEvolutionStory: () => Promise.resolve({} as never),
      reindex: () => Promise.resolve({ reindexed: 0, sources: 0, entities: 0 }),
      getFreshness: () => Promise.resolve({ items: [], summary: { fresh: 0, stale: 0, orphaned: 0, unbound: 0 } }),
    };

    const stores = createMockStoreSet();
    const server = createMcpServer(stores, { wikiService: mockWikiService as never });
    const toolNames = getRegisteredToolNames(server);

    // Core(8) + API analysis(9) + analyze_repo(1) + code_as_of(1) + wiki(10) = 29
    expect(toolNames.length).toBeGreaterThanOrEqual(27);
  });

  it('all tool names are non-empty strings', () => {
    const stores = createMockStoreSet();
    const server = createMcpServer(stores);
    const toolNames = getRegisteredToolNames(server);

    expect(toolNames.length).toBeGreaterThan(0);
    for (const name of toolNames) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
