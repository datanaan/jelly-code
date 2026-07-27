/**
 * E2E Test: find_dead_code
 *
 * Tests the find_dead_code tool against REAL Neo4j data.
 * Requires: Neo4j running (bolt://localhost:7687)
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/e2e/find-dead-code-e2e.test.ts
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

const PROJECT_ID = `e2e-find-dead-code-${Date.now()}`;

if (runE2E()) {
  describe('E2E: find_dead_code', () => {
    let stores: StoreSet;

    beforeAll(async () => {
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      stores = createStoreSet(loadConfig());
      await stores.graph.initializeSchema();
      // Seed test data: one dead symbol and one live symbol
      await stores.graph.query(
        `CREATE (n1 {id: $deadId, projectId: $projectId, name: $deadName, type: 'Function', filePath: $deadPath, isExported: true})
         CREATE (n2 {id: $liveId, projectId: $projectId, name: $liveName, type: 'Function', filePath: $livePath, isExported: true})
         CREATE (caller {id: $callerId, projectId: $projectId, name: 'caller', type: 'Function', filePath: $callerPath})
         CREATE (caller)-[:CODE_RELATION {type: 'CALLS'}]->(n2)`,
        {
          projectId: PROJECT_ID,
          deadId: `dead-fn-${PROJECT_ID}`,
          deadName: 'unusedFunction',
          deadPath: 'src/legacy.ts',
          liveId: `live-fn-${PROJECT_ID}`,
          liveName: 'usedFunction',
          livePath: 'src/active.ts',
          callerId: `caller-${PROJECT_ID}`,
          callerPath: 'src/caller.ts',
        },
      );
    });

    afterAll(async () => {
      try { await stores.graph.clearProject(PROJECT_ID); } catch { /* ignore */ }
      await stores.close();
    });

    it('should find dead exported symbols in real data', async () => {
      const { registerFindDeadCode } = await import('../../src/mcp/tools/find-dead-code.js');
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerFindDeadCode(server, stores);

      // Use a low-level call: manually invoke the tool handler via the server's tool registry
      const result = await server.request(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'tools/call',
          params: { name: 'find_dead_code', arguments: { projectId: PROJECT_ID } },
        } as any,
      );
      expect(result).toBeDefined();
      const content = (result as any).content?.[0];
      expect(content).toBeDefined();
      expect(content.type).toBe('text');
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty('total');
      expect(parsed).toHaveProperty('deadSymbols');
      expect(parsed).toHaveProperty('byFile');
      expect(typeof parsed.total).toBe('number');
      expect(Array.isArray(parsed.deadSymbols)).toBe(true);
      expect(typeof parsed.byFile).toBe('object');
      // Should find at least the dead symbol we seeded (unusedFunction)
      const deadFn = parsed.deadSymbols.find((s: any) => s.name === 'unusedFunction');
      expect(deadFn).toBeDefined();
      expect(deadFn.type).toBe('Function');
      expect(deadFn.filePath).toBe('src/legacy.ts');
      expect(deadFn.confidence).toBeGreaterThanOrEqual(0.9);
      expect(deadFn.reason).toMatch(/no_callers|self_reference/);
    });

    it('should not mark live symbols as dead', async () => {
      const { registerFindDeadCode } = await import('../../src/mcp/tools/find-dead-code.js');
      const server2 = new McpServer({ name: 'test', version: '1.0.0' });
      registerFindDeadCode(server2, stores);

      const result = await server2.request(
        {
          jsonrpc: '2.0',
          id: '2',
          method: 'tools/call',
          params: { name: 'find_dead_code', arguments: { projectId: PROJECT_ID } },
        } as any,
      );
      expect(result).toBeDefined();
      const content = (result as any).content?.[0];
      const parsed = JSON.parse(content.text);
      // usedFunction is called by caller — should NOT appear in dead symbols
      const liveFn = parsed.deadSymbols.find((s: any) => s.name === 'usedFunction');
      expect(liveFn).toBeUndefined();
    });
  });
}
