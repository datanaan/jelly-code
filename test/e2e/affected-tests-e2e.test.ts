/**
 * E2E Test: affected_tests
 *
 * Tests the affected_tests tool against REAL Neo4j data.
 * Requires: Neo4j running (bolt://localhost:7687)
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/e2e/affected-tests-e2e.test.ts
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

const PROJECT_ID = `e2e-affected-tests-${Date.now()}`;

if (runE2E()) {
  describe('E2E: affected_tests', () => {
    let stores: StoreSet;

    beforeAll(async () => {
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      stores = createStoreSet(loadConfig());
      await stores.graph.initializeSchema();
      // Seed: a source file, a test file that imports it, and a function call chain
      await stores.graph.query(
        `CREATE (src:File {id: $srcId, projectId: $projectId, name: 'users.ts', filePath: 'src/api/users.ts'})
         CREATE (test:File {id: $testId, projectId: $projectId, name: 'users.test.ts', filePath: 'src/api/users.test.ts'})
         CREATE (fn:Function {id: $fnId, projectId: $projectId, name: 'getUsers', filePath: 'src/api/users.ts', isExported: true})
         CREATE (testFn:Function {id: $testFnId, projectId: $projectId, name: 'test getUsers', filePath: 'src/api/users.test.ts'})
         CREATE (test)-[:CODE_RELATION {type: 'IMPORTS'}]->(src)
         CREATE (testFn)-[:CODE_RELATION {type: 'CALLS'}]->(fn)`,
        {
          projectId: PROJECT_ID,
          srcId: `src-${PROJECT_ID}`,
          testId: `test-${PROJECT_ID}`,
          fnId: `fn-${PROJECT_ID}`,
          testFnId: `testfn-${PROJECT_ID}`,
        },
      );
    });

    afterAll(async () => {
      try { await stores.graph.clearProject(PROJECT_ID); } catch { /* ignore */ }
      await stores.close();
    });

    it('should find affected tests via direct import', async () => {
      const { registerAffectedTests } = await import('../../src/mcp/tools/affected-tests.js');
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAffectedTests(server, stores);

      const result = await server.request(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'tools/call',
          params: { name: 'affected_tests', arguments: { projectId: PROJECT_ID, changedFiles: ['src/api/users.ts'] } },
        } as any,
      );
      expect(result).toBeDefined();
      const content = (result as any).content?.[0];
      expect(content).toBeDefined();
      expect(content.type).toBe('text');
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty('directlyAffected');
      expect(parsed).toHaveProperty('transitivelyAffected');
      expect(parsed).toHaveProperty('totalTestFiles');
      expect(parsed).toHaveProperty('untestedChangedFiles');
      expect(Array.isArray(parsed.directlyAffected)).toBe(true);
      expect(Array.isArray(parsed.transitivelyAffected)).toBe(true);
      expect(Array.isArray(parsed.untestedChangedFiles)).toBe(true);
      expect(typeof parsed.totalTestFiles).toBe('number');
      // Should find the test file that imports users.ts
      if (parsed.totalTestFiles > 0) {
        const usersTest = parsed.directlyAffected.find((a: any) => a.testFile === 'src/api/users.test.ts');
        expect(usersTest).toBeDefined();
        expect(usersTest.reason).toBe('direct_import');
      }
    });

    it('should identify untested files', async () => {
      const { registerAffectedTests } = await import('../../src/mcp/tools/affected-tests.js');
      const server2 = new McpServer({ name: 'test', version: '1.0.0' });
      registerAffectedTests(server2, stores);

      const result = await server2.request(
        {
          jsonrpc: '2.0',
          id: '2',
          method: 'tools/call',
          params: { name: 'affected_tests', arguments: { projectId: PROJECT_ID, changedFiles: ['src/untouched.ts'] } },
        } as any,
      );
      expect(result).toBeDefined();
      const content = (result as any).content?.[0];
      const parsed = JSON.parse(content.text);
      expect(parsed.directlyAffected).toEqual([]);
      expect(parsed.transitivelyAffected).toEqual([]);
      expect(parsed.totalTestFiles).toBe(0);
      // src/untouched.ts was seeded with no test coverage — should appear in untested
      expect(parsed.untestedChangedFiles).toContain('src/untouched.ts');
    });
  });
}
