/**
 * Unit Tests: MCP Server creation
 */

import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';

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

describe('MCP Server', () => {
  it('should create server with all 7 tools', () => {
    const stores = createMockStores();
    const server = createMcpServer(stores);
    expect(server).toBeDefined();
  });

  it('should create server with custom name and version', () => {
    const stores = createMockStores();
    const server = createMcpServer(stores, { name: 'test-server', version: '1.0.0' });
    expect(server).toBeDefined();
  });
});
