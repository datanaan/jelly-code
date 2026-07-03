/**
 * E2E Test: Concurrency & Project Isolation
 *
 * Tests that multiple projects in Neo4j don't interfere with each other.
 *
 * Requires:
 *   - Neo4j running (bolt://localhost:7687)
 *   - Typesense running (localhost:8108, api key: xyz123)
 *   - Qdrant running (localhost:6333)
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/e2e/concurrency-and-isolation.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const runE2E = (): boolean => {
  const runFlag = process.env.JELLY_CODE_E2E === '1';
  if (!runFlag) {
    console.warn('[E2E] Skipping: set JELLY_CODE_E2E=1 to run (requires backends)');
  }
  return runFlag;
};

const PROJ_A = `e2e-iso-a-${Date.now()}`;
const PROJ_B = `e2e-iso-b-${Date.now()}`;

if (runE2E()) {
  describe('E2E: Concurrency — project isolation', () => {
    let stores: import('../../src/store/interfaces.js').StoreSet;

    beforeAll(async () => {
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      stores = createStoreSet(loadConfig());
      await stores.graph.initializeSchema();
    });

    afterAll(async () => {
      try { await stores.graph.clearProject(PROJ_A); } catch { /* ignore */ }
      try { await stores.graph.clearProject(PROJ_B); } catch { /* ignore */ }
      try { await stores.search.deleteCollection(PROJ_A); } catch { /* ignore */ }
      try { await stores.search.deleteCollection(PROJ_B); } catch { /* ignore */ }
      try { await stores.vector.deleteCollection(PROJ_A); } catch { /* ignore */ }
      try { await stores.vector.deleteCollection(PROJ_B); } catch { /* ignore */ }
      await stores.close();
    });

    it('should write project A data without polluting project B', async () => {
      const { writePipelineResultToStores } = await import('../../src/core/run-analyze.js');

      await writePipelineResultToStores({
        nodes: [
          { id: 'func:a_only', type: 'Function', name: 'a_only', filePath: 'src/a.ts', content: 'function a_only() {}' },
          { id: 'file:a_main', type: 'File', name: 'a_main.ts', filePath: 'src/a_main.ts', content: '// A' },
        ],
        relations: [
          { sourceId: 'file:a_main', targetId: 'func:a_only', type: 'CONTAINS', confidence: 1.0, reason: 'scope' },
        ],
        communities: [],
        processes: [],
      } as any, PROJ_A, stores);

      // Verify project B has NO data
      const bNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN n.id AS id',
        { pid: PROJ_B },
      );
      expect(bNodes.length).toBe(0); // Should be 0 or just the Project node
      const bProjects = bNodes.filter((n: any) => n.id === PROJ_B);
      expect(bProjects.length).toBe(0);
    });

    it('should write project B data and verify both projects coexist', async () => {
      const { writePipelineResultToStores } = await import('../../src/core/run-analyze.js');

      await writePipelineResultToStores({
        nodes: [
          { id: 'func:b_only', type: 'Function', name: 'b_only', filePath: 'src/b.ts', content: 'function b_only() {}' },
          { id: 'file:b_main', type: 'File', name: 'b_main.ts', filePath: 'src/b_main.ts', content: '// B' },
        ],
        relations: [
          { sourceId: 'file:b_main', targetId: 'func:b_only', type: 'CONTAINS', confidence: 1.0, reason: 'scope' },
        ],
        communities: [],
        processes: [],
      } as any, PROJ_B, stores);

      // Project A should still have its original data
      const aNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN n.id AS id',
        { pid: PROJ_A },
      );
      const aIds = aNodes.map((n: any) => n.id);
      expect(aIds).toContain('func:a_only'); // A's data intact

      // Project B should have its data
      const bNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN n.id AS id',
        { pid: PROJ_B },
      );
      const bIds = bNodes.map((n: any) => n.id);
      expect(bIds).toContain('func:b_only');
      expect(bIds).not.toContain('func:a_only'); // No cross-contamination
    });

    it('should query each project independently and get correct counts', async () => {
      const aNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN count(n) AS cnt',
        { pid: PROJ_A },
      );
      const bNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN count(n) AS cnt',
        { pid: PROJ_B },
      );
      const bNodeCount = (bNodes[0] as any)?.cnt || 0;
      const aNodeCount = (aNodes[0] as any)?.cnt || 0;

      // A should have fewer nodes than (A+B)
      expect(aNodeCount).toBeGreaterThan(0);
      expect(bNodeCount).toBeGreaterThan(0);

      // Neither should contain the other's nodes
      const aNames: { name: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN n.name AS name',
        { pid: PROJ_A },
      );
      const aNameList = (aNames as any[]).map((n: any) => n.name);
      expect(aNameList).toContain('a_only');
      expect(aNameList).not.toContain('b_only');
    });

    it('should clear project A without affecting project B', async () => {
      await stores.graph.clearProject(PROJ_A);

      const aNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN n.id AS id',
        { pid: PROJ_A },
      );
      expect(aNodes.length).toBe(0); // A is gone

      // B should be untouched
      const bNodes: { id: string }[] = await stores.graph.query(
        'MATCH (n {projectId: $pid}) RETURN n.id AS id',
        { pid: PROJ_B },
      );
      const bIds = bNodes.map((n: any) => n.id);
      expect(bIds).toContain('func:b_only');
    });
  });
} else {
  describe.skip('E2E: Concurrency & Isolation', () => {
    it('skipped — requires JELLY_CODE_E2E=1', () => {
      expect(true).toBe(true);
    });
  });
}
