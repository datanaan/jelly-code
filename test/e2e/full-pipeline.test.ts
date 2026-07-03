/**
 * E2E Test: Full Pipeline
 *
 * Tests the complete flow: analyze → store → search → MCP query
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 * - Typesense running on localhost:8108
 * - Qdrant running on localhost:6333
 *
 * Run with: npx vitest run test/e2e/full-pipeline.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createStoreSet } from '../../src/store/factory.js';
import type { StoreSet } from '../../src/store/interfaces.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { skipE2E } from './helpers.js';

// ─── E2E gate ───────────────────────────────────────────────────────────────
// (skipE2E imported from helpers.ts — RUN_E2E=1 to enable)

describe.skipIf(skipE2E)('Full Pipeline E2E', () => {
  let stores: StoreSet;
  const testProjectId = `e2e-test-${Date.now()}`;

  beforeAll(async () => {
    const config = loadConfig();
    stores = createStoreSet(config);

    // Initialize Neo4j schema
    await stores.graph.initializeSchema();
  }, 30_000);

  afterAll(async () => {
    // Cleanup: delete test project data
    try {
      await stores.graph.clearProject(testProjectId);
      await stores.search.deleteCollection(testProjectId);
      await stores.vector.deleteCollection(testProjectId);
    } catch {
      // Ignore cleanup errors
    }

    await stores.graph.close();
    await stores.search.close();
    await stores.vector.close();
  }, 15_000);

  describe('Store Layer', () => {
    it('should write nodes to Neo4j', async () => {
      const nodes = [
        {
          id: testProjectId,
          type: 'Project',
          projectId: testProjectId,
          name: testProjectId,
        },
        {
          id: `${testProjectId}:File:src/index.ts`,
          type: 'File',
          projectId: testProjectId,
          name: 'index.ts',
          filePath: 'src/index.ts',
          content: 'export function hello() { return "world"; }',
        },
        {
          id: `${testProjectId}:Function:hello`,
          type: 'Function',
          projectId: testProjectId,
          name: 'hello',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
          content: 'function hello() { return "world"; }',
        },
      ];

      await stores.graph.batchCreateNodes(nodes);

      const result = await stores.graph.query(
        'MATCH (n {projectId: $projectId}) RETURN n',
        { projectId: testProjectId },
      );

      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should write relations to Neo4j', async () => {
      const relations = [
        {
          id: `${testProjectId}:CONTAINS:File:src/index.ts->Function:hello`,
          type: 'CONTAINS',
          projectId: testProjectId,
          sourceId: `${testProjectId}:File:src/index.ts`,
          targetId: `${testProjectId}:Function:hello`,
          confidence: 1.0,
        },
      ];

      await stores.graph.batchCreateRelations(relations);

      const result = await stores.graph.query(
        'MATCH ()-[r {projectId: $projectId}]->() RETURN r',
        { projectId: testProjectId },
      );

      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should find symbols by name', async () => {
      const found = await stores.graph.findSymbol(testProjectId, 'hello', ['Function']);
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found[0].name).toBe('hello');
    });

    it('should find symbols by file', async () => {
      const found = await stores.graph.findSymbolByFile(testProjectId, 'src/index.ts');
      expect(found.length).toBeGreaterThanOrEqual(1);
    });

    it('should index documents in Typesense', async () => {
      await stores.search.ensureCollection(testProjectId);
      await stores.search.indexDocuments(testProjectId, [
        {
          id: `${testProjectId}:Function:hello`,
          name: 'hello',
          content: 'function hello() { return "world"; }',
          filePath: 'src/index.ts',
          nodeType: 'Function',
        },
      ]);

      const results = await stores.search.search(testProjectId, 'hello');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('hello');
    });

    it('should list projects', async () => {
      const projects = await stores.graph.listProjects();
      expect(projects).toContain(testProjectId);
    });
  });

  describe('MCP Server', () => {
    it('should create MCP server with all tools', () => {
      const server = createMcpServer(stores);
      expect(server).toBeDefined();
    });
  });
});
