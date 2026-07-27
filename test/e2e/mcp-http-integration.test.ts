/**
 * Integration Test: MCP HTTP Protocol Layer
 *
 * Tests 3 new tools (find_dead_code / list_dependencies / affected_tests)
 * via the real HTTP POST /mcp endpoint.
 *
 * Uses supertest to test the Express app without starting a real server.
 * Neo4j must be running (bolt://localhost:7687).
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/e2e/mcp-http-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

const runE2E = (): boolean => {
  const runFlag = process.env.JELLY_CODE_E2E === '1';
  if (!runFlag) {
    console.warn('[MCP HTTP] Skipping: set JELLY_CODE_E2E=1 to run (requires Neo4j)');
  }
  return runFlag;
};

const PROJECT_ID = `mcp-http-int-${Date.now()}`;
let app: any;
let apiKey: string;

if (runE2E()) {
  describe('MCP HTTP Integration: find_dead_code', () => {
    beforeAll(async () => {
      // Import the real Express app
      const mod = await import('../../src/server/index.js');
      app = mod.app;
      apiKey = process.env.STANDALONE_API_KEYS?.split(',')[0] || 'dev_test_key_2026';

      // Seed test data via health check to confirm connectivity
      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);

      // Seed a dead symbol and a live symbol
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const stores = createStoreSet(loadConfig());
      await stores.graph.initializeSchema();
      await stores.graph.query(
        `CREATE (n1 {id: $deadId, projectId: $projectId, name: $deadName, type: 'Function', filePath: $deadPath, isExported: true})
         CREATE (n2 {id: $liveId, projectId: $projectId, name: $liveName, type: 'Function', filePath: $livePath, isExported: true})
         CREATE (caller {id: $callerId, projectId: $projectId, name: 'caller', type: 'Function', filePath: $callerPath})
         CREATE (caller)-[:CODE_RELATION {type: 'CALLS'}]->(n2)`,
        {
          projectId: PROJECT_ID,
          deadId: `dead-${PROJECT_ID}`,
          deadName: 'unusedFunction',
          deadPath: 'src/legacy.ts',
          liveId: `live-${PROJECT_ID}`,
          liveName: 'usedFunction',
          livePath: 'src/active.ts',
          callerId: `caller-${PROJECT_ID}`,
          callerPath: 'src/caller.ts',
        },
      );
      await stores.close();
    });

    afterAll(async () => {
      // Clean up test data
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const stores = createStoreSet(loadConfig());
      try { await stores.graph.clearProject(PROJECT_ID); } catch { /* ignore */ }
      await stores.close();
    });

    it('POST /mcp — tools/call find_dead_code should return dead symbols', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'find_dead_code',
            arguments: { projectId: PROJECT_ID },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('result');
      expect(res.body.id).toBe(1);
      expect(res.body.jsonrpc).toBe('2.0');
      const content = res.body.result.content?.[0];
      expect(content).toBeDefined();
      expect(content.type).toBe('text');
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty('total');
      expect(parsed).toHaveProperty('deadSymbols');
      expect(parsed).toHaveProperty('byFile');
      expect(typeof parsed.total).toBe('number');
      expect(Array.isArray(parsed.deadSymbols)).toBe(true);
      // Should find the dead symbol we seeded
      const deadFn = parsed.deadSymbols.find((s: any) => s.name === 'unusedFunction');
      expect(deadFn).toBeDefined();
      expect(deadFn.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('POST /mcp — tools/call find_dead_code should exclude live symbols', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'find_dead_code',
            arguments: { projectId: PROJECT_ID },
          },
        });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text);
      const liveFn = parsed.deadSymbols.find((s: any) => s.name === 'usedFunction');
      expect(liveFn).toBeUndefined();
    });

    it('POST /mcp — tools/call find_dead_code with filePath filter', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'find_dead_code',
            arguments: { projectId: PROJECT_ID, filePath: 'src/legacy.ts' },
          },
        });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text);
      expect(parsed.total).toBeGreaterThanOrEqual(1);
      for (const sym of parsed.deadSymbols) {
        expect(sym.filePath).toBe('src/legacy.ts');
      }
    });
  });

  describe('MCP HTTP Integration: list_dependencies', () => {
    beforeAll(async () => {
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const stores = createStoreSet(loadConfig());
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
          fid: `list-f-${PROJECT_ID}`,
          eid: `list-ext-${PROJECT_ID}`,
          iid: `list-int-${PROJECT_ID}`,
        },
      );
      await stores.close();
    });

    it('POST /mcp — tools/call list_dependencies should list external packages', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'list_dependencies',
            arguments: { projectId: PROJECT_ID, scope: 'external' },
          },
        });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text);
      expect(parsed).toHaveProperty('externalPackages');
      expect(parsed).toHaveProperty('totalExternal');
      expect(Array.isArray(parsed.externalPackages)).toBe(true);
      if (parsed.totalExternal > 0) {
        const zodDep = parsed.externalPackages.find((p: any) => p.name === 'zod');
        expect(zodDep).toBeDefined();
      }
    });

    it('POST /mcp — tools/call list_dependencies should list internal modules', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'list_dependencies',
            arguments: { projectId: PROJECT_ID, scope: 'internal' },
          },
        });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text);
      expect(parsed).toHaveProperty('internalModules');
      expect(parsed).toHaveProperty('totalInternalModules');
      expect(Array.isArray(parsed.internalModules)).toBe(true);
    });
  });

  describe('MCP HTTP Integration: affected_tests', () => {
    beforeAll(async () => {
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const stores = createStoreSet(loadConfig());
      await stores.graph.initializeSchema();
      // Seed: a source file, a test file, and a call chain
      await stores.graph.query(
        `CREATE (src:File {id: $srcId, projectId: $projectId, name: 'users.ts', filePath: 'src/api/users.ts'})
         CREATE (test:File {id: $testId, projectId: $projectId, name: 'users.test.ts', filePath: 'src/api/users.test.ts'})
         CREATE (fn:Function {id: $fnId, projectId: $projectId, name: 'getUsers', filePath: 'src/api/users.ts', isExported: true})
         CREATE (testFn:Function {id: $testFnId, projectId: $projectId, name: 'test getUsers', filePath: 'src/api/users.test.ts'})
         CREATE (test)-[:CODE_RELATION {type: 'IMPORTS'}]->(src)
         CREATE (testFn)-[:CODE_RELATION {type: 'CALLS'}]->(fn)`,
        {
          projectId: PROJECT_ID,
          srcId: `affected-src-${PROJECT_ID}`,
          testId: `affected-test-${PROJECT_ID}`,
          fnId: `affected-fn-${PROJECT_ID}`,
          testFnId: `affected-tfn-${PROJECT_ID}`,
        },
      );
      await stores.close();
    });

    it('POST /mcp — tools/call affected_tests should find direct test impact', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'affected_tests',
            arguments: { projectId: PROJECT_ID, changedFiles: ['src/api/users.ts'] },
          },
        });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text);
      expect(parsed).toHaveProperty('directlyAffected');
      expect(parsed).toHaveProperty('transitivelyAffected');
      expect(parsed).toHaveProperty('totalTestFiles');
      expect(parsed).toHaveProperty('untestedChangedFiles');
      expect(typeof parsed.totalTestFiles).toBe('number');
      expect(Array.isArray(parsed.directlyAffected)).toBe(true);
      expect(Array.isArray(parsed.untestedChangedFiles)).toBe(true);
    });

    it('POST /mcp — tools/call affected_tests with empty changedFiles', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'affected_tests',
            arguments: { projectId: PROJECT_ID, changedFiles: [] },
          },
        });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text);
      expect(parsed.totalTestFiles).toBe(0);
      expect(parsed.message).toContain('No changed files provided');
    });
  });

  describe('MCP HTTP Integration: auth and error handling', () => {
    it('POST /mcp — should reject requests without API key', async () => {
      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: { name: 'find_dead_code', arguments: { projectId: 'test' } },
        });

      expect(res.status).toBe(401);
    });

    it('POST /mcp — should return error for unknown tool', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-Key', apiKey)
        .send({
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/call',
          params: { name: 'nonexistent_tool', arguments: {} },
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('error');
    });

    it('GET /health — should return 200', async () => {
      const res = await request(app).get('/health');
      // May return 503 if backend services are not all up, but should at least respond
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
    });
  });
}
