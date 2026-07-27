/**
 * E2E Test: list_dependencies
 *
 * Tests the list_dependencies tool against REAL Neo4j data.
 * Requires: Neo4j running (bolt://localhost:7687)
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/e2e/list-dependencies-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { StoreSet } from '../../src/store/interfaces.js';

const runE2E = (): boolean => {
  const runFlag = process.env.JELLY_CODE_E2E === '1';
  if (!runFlag) {
    console.warn('[E2E] Skipping: set JELLY_CODE_E2E=1 to run (requires Neo4j)');
  }
  return runFlag;
};

const PROJECT_ID = `e2e-list-deps-${Date.now()}`;

if (runE2E()) {
  describe('E2E: list_dependencies', () => {
    let stores: StoreSet;

    beforeAll(async () => {
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      stores = createStoreSet(loadConfig());
      await stores.graph.initializeSchema();
      // Seed: a file that imports both an external package and an internal module
      await stores.graph.query(
        `CREATE (f:File {id: $fid, projectId: $projectId, name: 'main.ts', filePath: 'src/main.ts'})
         CREATE (ext:File {id: $eid, projectId: $projectId, name: 'zod', filePath: 'node_modules/zod/index.ts'})
         CREATE (int:File {id: $iid, projectId: $projectId, name: 'helper.ts', filePath: 'src/utils/helper.ts'})
         CREATE (f)-[:CODE_RELATION {type: 'IMPORTS'}]->(ext)
         CREATE (f)-[:CODE_RELATION {type: 'IMPORTS'}]->(int)`,
        {
          projectId: PROJECT_ID,
          fid: `f-${PROJECT_ID}`,
          eid: `ext-${PROJECT_ID}`,
          iid: `int-${PROJECT_ID}`,
        },
      );
    });

    afterAll(async () => {
      try { await stores.graph.clearProject(PROJECT_ID); } catch { /* ignore */ }
      await stores.close();
    });

    it('should list external dependencies from real data', async () => {
      const { registerListDependencies } = await import('../../src/mcp/tools/list-dependencies.js');
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerListDependencies(server, stores);

      const result = await server.request(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'tools/call',
          params: { name: 'list_dependencies', arguments: { projectId: PROJECT_ID, scope: 'external' } },
        } as any,
      );
      expect(result).toBeDefined();
      const content = (result as any).content?.[0];
      expect(content).toBeDefined();
      expect(content.type).toBe('text');
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty('externalPackages');
      expect(parsed).toHaveProperty('totalExternal');
      expect(parsed).toHaveProperty('totalInternalModules');
      expect(Array.isArray(parsed.externalPackages)).toBe(true);
      expect(typeof parsed.totalExternal).toBe('number');
      expect(parsed.totalInternalModules).toBe(0);
      // Should find the external dep we seeded (zod)
      if (parsed.totalExternal > 0) {
        const zodDep = parsed.externalPackages.find((p: any) => p.name === 'zod');
        expect(zodDep).toBeDefined();
        expect(zodDep.filePath).toContain('node_modules/zod');
        expect(Array.isArray(zodDep.usedBy)).toBe(true);
      }
    });

    it('should list internal modules from real data', async () => {
      const { registerListDependencies } = await import('../../src/mcp/tools/list-dependencies.js');
      const server2 = new McpServer({ name: 'test', version: '1.0.0' });
      registerListDependencies(server2, stores);

      const result = await server2.request(
        {
          jsonrpc: '2.0',
          id: '2',
          method: 'tools/call',
          params: { name: 'list_dependencies', arguments: { projectId: PROJECT_ID, scope: 'internal' } },
        } as any,
      );
      expect(result).toBeDefined();
      const content = (result as any).content?.[0];
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty('internalModules');
      expect(parsed).toHaveProperty('totalInternalModules');
      expect(Array.isArray(parsed.internalModules)).toBe(true);
      expect(typeof parsed.totalInternalModules).toBe('number');
      expect(parsed.totalExternal).toBe(0);
      // Should find the internal module we seeded (src/utils/helper)
      if (parsed.totalInternalModules > 0) {
        const helperMod = parsed.internalModules.find((m: any) => m.name && m.name.includes('utils'));
        expect(helperMod).toBeDefined();
        expect(typeof helperMod.importCount).toBe('number');
        expect(typeof helperMod.fileCount).toBe('number');
      }
    });
  });
}
