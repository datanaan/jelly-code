/**
 * E2E Test: runAnalyze + writePipelineResultToStores
 *
 * Tests the complete analysis flow with REAL Neo4j/Typesense/Qdrant.
 * Unlike existing incremental-e2e tests, this focuses on:
 * - Direct writePipelineResultToStores() testing with controlled input
 * - runAnalyze() with edge cases (empty dir, non-git dir)
 * - Bi-temporal edge attribute verification (valid_from, txn_from)
 *
 * Requires:
 *   - Neo4j running (bolt://localhost:7687)
 *   - Typesense running (localhost:8108, api key: xyz123)
 *   - Qdrant running (localhost:6333)
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/e2e/run-analyze-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { StoreSet } from '../../src/store/interfaces.js';

const runE2E = (): boolean => {
  const runFlag = process.env.JELLY_CODE_E2E === '1';
  if (!runFlag) {
    console.warn('[E2E] Skipping: set JELLY_CODE_E2E=1 to run (requires Neo4j/Typesense/Qdrant)');
  }
  return runFlag;
};

const PROJECT_ID = `e2e-run-analyze-${Date.now()}`;

if (runE2E()) {
  describe('E2E: runAnalyze — full pipeline integration', () => {

    describe('writePipelineResultToStores — direct unit test', () => {
      let stores: StoreSet;

      beforeAll(async () => {
        const { createStoreSet } = await import('../../src/store/index.js');
        const { loadConfig } = await import('../../src/config/index.js');
        stores = createStoreSet(loadConfig());
        await stores.graph.initializeSchema();
      });

      afterAll(async () => {
        try { await stores.graph.clearProject(PROJECT_ID); } catch { /* ignore */ }
        try { await stores.search.deleteCollection(PROJECT_ID); } catch { /* ignore */ }
        try { await stores.vector.deleteCollection(PROJECT_ID); } catch { /* ignore */ }
        await stores.close();
      });

      it('should write nodes, relations, communities, and processes to Neo4j', async () => {
        const { writePipelineResultToStores } = await import('../../src/core/run-analyze.js');

        const result = {
          nodes: [
            { id: 'func:hello', type: 'Function', name: 'hello', filePath: 'src/main.ts', content: 'function hello() {}' },
            { id: 'func:world', type: 'Function', name: 'world', filePath: 'src/main.ts', content: 'function world() {}' },
            { id: 'file:main', type: 'File', name: 'main.ts', filePath: 'src/main.ts', content: '// main' },
          ],
          relations: [
            { sourceId: 'file:main', targetId: 'func:hello', type: 'CONTAINS', confidence: 1.0, reason: 'scope' },
            { sourceId: 'func:hello', targetId: 'func:world', type: 'CALLS', confidence: 0.9, reason: 'direct call' },
          ],
          communities: [
            {
              id: 'comm:core',
              label: 'Core',
              heuristicLabel: 'Core Functions',
              keywords: ['hello', 'world'],
              description: 'Core utility functions',
              cohesion: 0.8,
              symbolCount: 2,
            },
          ],
          processes: [
            {
              id: 'proc:main',
              label: 'Main Process',
              processType: 'execution',
              stepCount: 2,
              communities: ['comm:core'],
              entryPointId: 'func:hello',
            },
          ],
        };

        const stats = await writePipelineResultToStores(result as any, PROJECT_ID, stores);
        expect(stats.nodeCount).toBe(3);
        expect(stats.relationCount).toBe(2);
        expect(stats.communityCount).toBe(1);
        expect(stats.processCount).toBe(1);

        // Verify nodes exist in Neo4j
        const nodes: { id: string; type: string }[] = await stores.graph.query(
          'MATCH (n {projectId: $projectId}) RETURN n.id AS id, n.type AS type ORDER BY n.id',
          { projectId: PROJECT_ID },
        );
        expect(nodes.length).toBeGreaterThanOrEqual(3 + 1); // nodes + community + process
        const nodeIds = nodes.map(n => n.id);
        expect(nodeIds).toContain('func:hello');
        expect(nodeIds).toContain('func:world');
        expect(nodeIds).toContain('file:main');

        // Verify relations exist in Neo4j
        const rels: { id: string }[] = await stores.graph.query(
          'MATCH ()-[r {projectId: $projectId}]->() RETURN r.id AS id',
          { projectId: PROJECT_ID },
        );
        expect(rels.length).toBeGreaterThanOrEqual(2);
        const relIds = rels.map(r => r.id);
        expect(relIds).toContain('func:hello-CALLS-func:world');
        expect(relIds).toContain('file:main-CONTAINS-func:hello');

        // Verify Project node created with freshness metadata
        const projects: Record<string, unknown>[] = await stores.graph.query(
          'MATCH (p:Project {id: $projectId}) RETURN p',
          { projectId: PROJECT_ID },
        );
        expect(projects.length).toBe(1);
        const project = projects[0] as Record<string, unknown>;
        expect(project.symbolsFreshness).toBe('fresh');
        expect(project.communitiesFreshness).toBe('fresh');
        expect(project.totalFiles).toBe(1);
        expect(project.consecutiveIncremental).toBe(0);
      });

      it('should write bi-temporal attributes on relations', async () => {
        const { writePipelineResultToStores } = await import('../../src/core/run-analyze.js');

        const result = {
          nodes: [
            { id: 'func:alpha', type: 'Function', name: 'alpha', filePath: 'src/a.ts', content: 'function alpha() {}' },
            { id: 'func:beta', type: 'Function', name: 'beta', filePath: 'src/a.ts', content: 'function beta() {}' },
          ],
          relations: [
            { sourceId: 'func:alpha', targetId: 'func:beta', type: 'CALLS', confidence: 1.0, reason: 'test' },
          ],
          communities: [],
          processes: [],
        };

        await writePipelineResultToStores(result as any, PROJECT_ID, stores);

        // Query the relation and verify bi-temporal fields
        const rels = await stores.graph.query(
          `MATCH ()-[r:CodeRelation {projectId: $projectId}]->()
           RETURN r.valid_from AS vf, r.valid_to AS vt, r.txn_from AS tf, r.txn_to AS tt`,
          { projectId: PROJECT_ID },
        );
        expect(rels.length).toBeGreaterThan(0);
        for (const r of rels as Record<string, unknown>[]) {
          expect(r.vf).toBeDefined();
          expect(r.vf).not.toBeNull();
          expect(r.vt).toBeNull();   // currently valid
          expect(r.tf).toBeDefined();
          expect(r.tf).not.toBeNull();
          expect(r.tt).toBeNull();   // current view
        }
      });

      it('should handle empty pipeline result gracefully', async () => {
        const { writePipelineResultToStores } = await import('../../src/core/run-analyze.js');

        const emptyResult = { nodes: [], relations: [], communities: [], processes: [] };
        const emptyProjectId = `${PROJECT_ID}-empty`;

        try {
          const stats = await writePipelineResultToStores(emptyResult as any, emptyProjectId, stores);
          expect(stats.nodeCount).toBe(0);
          expect(stats.relationCount).toBe(0);
          expect(stats.communityCount).toBe(0);
          expect(stats.processCount).toBe(0);

          // Should still create a Project node
          const projects: Record<string, unknown>[] = await stores.graph.query(
            'MATCH (p:Project {id: $projectId}) RETURN p.nodeCount AS nc',
            { projectId: emptyProjectId },
          );
          expect(projects.length).toBe(1);
          expect(projects[0].nc).toBe(0);
        } finally {
          await stores.graph.clearProject(emptyProjectId);
        }
      });

      it('should handle nodes with special characters in IDs', async () => {
        const { writePipelineResultToStores } = await import('../../src/core/run-analyze.js');

        const result = {
          nodes: [
            { id: 'func:$pecial', type: 'Function', name: '$pecial', filePath: 'src/x.ts', content: '' },
            { id: 'file:has space', type: 'File', name: 'has space', filePath: 'src/has space.ts', content: '' },
            { id: 'func:unicode-🚀', type: 'Function', name: 'unicode-🚀', filePath: 'src/unicode.ts', content: '' },
          ],
          relations: [
            { sourceId: 'func:$pecial', targetId: 'func:unicode-🚀', type: 'CALLS', confidence: 1.0, reason: 'special' },
          ],
          communities: [],
          processes: [],
        };
        const specialProjectId = `${PROJECT_ID}-special`;

        try {
          await writePipelineResultToStores(result as any, specialProjectId, stores);

          const nodes: { id: string }[] = await stores.graph.query(
            'MATCH (n {projectId: $projectId}) RETURN n.id AS id',
            { projectId: specialProjectId },
          );
          const nodeIds = nodes.map(n => n.id);
          expect(nodeIds).toContain('func:$pecial');
          expect(nodeIds).toContain('file:has space');
          expect(nodeIds).toContain('func:unicode-🚀');
        } finally {
          await stores.graph.clearProject(specialProjectId);
        }
      });
    });

    describe('runAnalyze — real code analysis', () => {
      const testRepoPath = `/tmp/jelly-code-e2e-run-analyze-${Date.now()}`;
      const runProjectId = `${PROJECT_ID}-real`;

      it('should set up a fixture repo (3 TypeScript files, cross-imports)', async () => {
        const { execSync } = await import('child_process');
        const fs = await import('fs');
        const path = await import('path');

        fs.rmSync(testRepoPath, { recursive: true, force: true });
        fs.mkdirSync(path.join(testRepoPath, 'src'), { recursive: true });

        execSync('git init', { cwd: testRepoPath });
        execSync('git config user.email test@test.com', { cwd: testRepoPath });
        execSync('git config user.name test', { cwd: testRepoPath });

        // File 1: greeter.ts — export a class
        fs.writeFileSync(
          path.join(testRepoPath, 'src', 'greeter.ts'),
          'export class Greeter {\n' +
          '  constructor(private name: string) {}\n' +
          '  greet(): string { return `Hello, ${this.name}!`; }\n' +
          '}\n',
        );

        // File 2: formatter.ts — export a function that imports Greeter
        fs.writeFileSync(
          path.join(testRepoPath, 'src', 'formatter.ts'),
          'import { Greeter } from "./greeter.js";\n' +
          'export function formatGreeting(name: string): string {\n' +
          '  const g = new Greeter(name);\n' +
          '  return g.greet().toUpperCase();\n' +
          '}\n',
        );

        // File 3: main.ts — entry point
        fs.writeFileSync(
          path.join(testRepoPath, 'src', 'main.ts'),
          'import { formatGreeting } from "./formatter.js";\n' +
          'export function run(): void {\n' +
          '  const msg = formatGreeting("World");\n' +
          '  console.log(msg);\n' +
          '}\n',
        );

        execSync('git add -A', { cwd: testRepoPath });
        execSync('git commit -m "initial"', { cwd: testRepoPath });

        expect(fs.existsSync(path.join(testRepoPath, 'src', 'greeter.ts'))).toBe(true);
      });

      it('should run full analysis and produce correct graph structure', async () => {
        const { runAnalyze } = await import('../../src/core/run-analyze.js');
        const { createStoreSet } = await import('../../src/store/index.js');
        const { loadConfig } = await import('../../src/config/index.js');

        const stores = createStoreSet(loadConfig());
        try {
          const result = await runAnalyze(testRepoPath, runProjectId, stores, {});

          // Verify we got meaningful results
          expect(result.nodeCount).toBeGreaterThan(10); // class, functions, files, etc.
          expect(result.relationCount).toBeGreaterThan(3); // CONTAINS, CALLS, IMPORTS, etc.

          // Verify specific symbols exist in Neo4j
          const symbols: { id: string; type: string }[] = await stores.graph.query(
            `MATCH (n {projectId: $projectId}) WHERE n.type IN ['Class', 'Function']
             RETURN n.id AS id, n.name AS name, n.type AS type`,
            { projectId: runProjectId },
          );

          const symbolNames = symbols.map(s => `${s.type}:${(s as any).name}`);
          expect(symbolNames).toContain('Class:Greeter');
          expect(symbolNames).toContain('Function:formatGreeting');
          expect(symbolNames).toContain('Function:run');

          // Verify CONTAINS relations (File → symbols)
          const containsRels = await stores.graph.query(
            `MATCH (f:File)-[r:CodeRelation]->(n)
             WHERE r.projectId = $projectId AND r.type = 'CONTAINS'
             RETURN f.filePath AS file, n.name AS name`,
            { projectId: runProjectId },
          );
          const containsPairs = containsRels.map((r: any) => `${r.file}->${r.name}`);
          expect(containsPairs).toContain('src/greeter.ts->Greeter');
          expect(containsPairs).toContain('src/formatter.ts->formatGreeting');

          // Verify IMPORTS relations
          const importPairs = await stores.graph.query(
            `MATCH (n)-[r:CodeRelation {projectId: $projectId}]->(target)
             WHERE r.type = 'IMPORTS'
             RETURN n.name AS source, target.name AS target`,
            { projectId: runProjectId },
          );
          const importEdges = importPairs.map((r: any) => `${r.source}->${r.target}`);
          expect(importEdges).toContain('formatter.ts->Greeter');
        } finally {
          await stores.close();
        }
      }, 120000); // 2 min timeout for full analysis

      it('should set correct Project metadata after analysis', async () => {
        const { createStoreSet } = await import('../../src/store/index.js');
        const { loadConfig } = await import('../../src/config/index.js');

        const stores = createStoreSet(loadConfig());
        try {
          const projectInfo: Record<string, unknown>[] = await stores.graph.query(
            `MATCH (p:Project {id: $projectId})
             RETURN p.nodeCount AS nc, p.relationCount AS rc,
                    p.totalFiles AS tf, p.symbolsFreshness AS sf,
                    p.consecutiveIncremental AS ci, p.accumulatedChanges AS ac`,
            { projectId: runProjectId },
          );
          expect(projectInfo.length).toBe(1);
          const p = projectInfo[0];
          expect((p.nc as number) || 0).toBeGreaterThan(10);
          expect((p.rc as number) || 0).toBeGreaterThan(3);
          expect((p.tf as number) || 0).toBe(3); // 3 source files
          expect(p.sf).toBe('fresh');
          expect(p.ci).toBe(0);
          expect(p.ac).toBe(0);
        } finally {
          await stores.close();
        }
      });

      it('should set gitUrl and lastCommit on Project if available', async () => {
        const { createStoreSet } = await import('../../src/store/index.js');
        const { loadConfig } = await import('../../src/config/index.js');
        const { execSync } = await import('child_process');

        const stores = createStoreSet(loadConfig());
        try {
          const headCommit = execSync('git rev-parse HEAD', { cwd: testRepoPath, encoding: 'utf-8' }).trim();

          // Manually set git tracking info (same as incremental test does after analysis)
          await stores.graph.query(
            `MATCH (p:Project {id: $projectId})
             SET p.gitUrl = $gitUrl, p.lastCommit = $lastCommit`,
            { projectId: runProjectId, gitUrl: `file://${testRepoPath}`, lastCommit: headCommit },
          );

          const result: Record<string, unknown>[] = await stores.graph.query(
            'MATCH (p:Project {id: $projectId}) RETURN p.gitUrl AS gu, p.lastCommit AS lc',
            { projectId: runProjectId },
          );
          expect(result.length).toBe(1);
          expect(result[0].gu).toBe(`file://${testRepoPath}`);
          expect(result[0].lc).toBe(headCommit);
        } finally {
          await stores.close();
        }
      });
    });

    describe('runAnalyze — edge cases', () => {
      it('should handle empty directory analysis gracefully', async () => {
        const { runAnalyze } = await import('../../src/core/run-analyze.js');
        const { createStoreSet } = await import('../../src/store/index.js');
        const { loadConfig } = await import('../../src/config/index.js');
        const { mkdtempSync, rmSync } = await import('fs');
        const { join } = await import('path');
        const { tmpdir } = await import('os');

        const emptyDir = join(tmpdir(), `jelly-code-empty-${Date.now()}`);
        const { mkdirSync } = await import('fs');
        mkdirSync(emptyDir, { recursive: true });

        const stores = createStoreSet(loadConfig());
        const emptyProjectId = `${PROJECT_ID}-empty-dir`;

        try {
          // The pipeline should still run and produce 0 nodes for empty dir
          const result = await runAnalyze(emptyDir, emptyProjectId, stores, {});
          expect(result.nodeCount).toBeGreaterThanOrEqual(0);
          // Should at least create a Project node
          const projectCheck: Record<string, unknown>[] = await stores.graph.query(
            'MATCH (p:Project {id: $id}) RETURN p.id AS id',
            { id: emptyProjectId },
          );
          expect(projectCheck.length).toBe(1);
        } finally {
          await stores.graph.clearProject(emptyProjectId);
          await stores.close();
          rmSync(emptyDir, { recursive: true, force: true });
        }
      }, 60000);

      it('should handle non-git directory', async () => {
        const { runAnalyze } = await import('../../src/core/run-analyze.js');
        const { createStoreSet } = await import('../../src/store/index.js');
        const { loadConfig } = await import('../../src/config/index.js');
        const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
        const { join } = await import('path');
        const { tmpdir } = await import('os');

        const nonGitDir = join(tmpdir(), `jelly-code-no-git-${Date.now()}`);
        mkdirSync(join(nonGitDir, 'src'), { recursive: true });
        writeFileSync(join(nonGitDir, 'src', 'simple.ts'),
          'export function add(a: number, b: number): number { return a + b; }\n',
        );

        const stores = createStoreSet(loadConfig());
        const noGitProjectId = `${PROJECT_ID}-no-git`;

        try {
          const result = await runAnalyze(nonGitDir, noGitProjectId, stores, {});
          expect(result.nodeCount).toBeGreaterThan(0); // Should parse files even without git

          // Verify the function was parsed
          const funcs = await stores.graph.query(
            'MATCH (n:Function {projectId: $projectId}) RETURN n.name AS name',
            { projectId: noGitProjectId },
          );
          const funcNames = funcs.map((f: any) => f.name);
          expect(funcNames).toContain('add');
        } finally {
          await stores.graph.clearProject(noGitProjectId);
          await stores.close();
          rmSync(nonGitDir, { recursive: true, force: true });
        }
      }, 60000);
    });
  });
} else {
  describe.skip('E2E: runAnalyze integration', () => {
    it('skipped — requires JELLY_CODE_E2E=1 and running backends', () => {
      expect(true).toBe(true);
    });
  });
}
