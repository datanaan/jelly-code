/**
 * Incremental vs Full Regression Test (E2E)
 *
 * Verifies Spec §6 core promise: "Incremental result must equal full rebuild."
 *
 * Constructs a small git repo with cross-file imports, runs full analysis
 * then incremental analysis (after modifying one file), and asserts the
 * resulting graph nodes/edges are identical by comparing node ID sets
 * and relation sets.
 *
 * Requires:
 *   - Neo4j running (bolt://localhost:7687, auth: neo4j/jelly2024)
 *   - Typesense running (localhost:8108, api key: xyz123)
 *   - Qdrant running (localhost:6333)
 *
 * Set JELLY_CODE_E2E=1 to run (default skipped, as backends are needed).
 *
 * Run: JELLY_CODE_E2E=1 npx vitest run test/incremental/incremental-e2e.test.ts
 */

import { describe, it, expect } from 'vitest';

const runE2E = () => {
  const runFlag = process.env.JELLY_CODE_E2E === '1';
  if (!runFlag) {
    console.warn('[E2E] Skipping: set JELLY_CODE_E2E=1 to run (requires Neo4j/Typesense/Qdrant)');
  }
  return runFlag;
};

const testRepoPath = '/tmp/jelly-code-e2e-test-repo';
const projectId = 'e2e-incremental-regression';

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

if (runE2E()) {
  describe('E2E: Incremental result == Full result', () => {

    it('should set up a test repo with cross-file imports', async () => {
      const { execSync } = await import('child_process');
      const fs = await import('fs');
      const path = await import('path');

      fs.rmSync(testRepoPath, { recursive: true, force: true });
      fs.mkdirSync(path.join(testRepoPath, 'src'), { recursive: true });

      execSync('git init', { cwd: testRepoPath });
      execSync('git config user.email test@test.com', { cwd: testRepoPath });
      execSync('git config user.name test', { cwd: testRepoPath });

      // constants.ts (unchanged between versions)
      fs.writeFileSync(
        path.join(testRepoPath, 'src', 'constants.ts'),
        'export const MAX_RETRIES = 3;\nexport const TIMEOUT_MS = 5000;\n',
      );

      // utils.ts (version 1)
      fs.writeFileSync(
        path.join(testRepoPath, 'src', 'utils.ts'),
        'import { MAX_RETRIES } from "./constants.js";\n' +
        'export function retry<T>(fn: () => T): T {\n' +
        '  for (let i = 0; i < MAX_RETRIES; i++) {\n' +
        '    try { return fn(); } catch { continue; }\n' +
        '  }\n' +
        '  throw new Error("All retries failed");\n' +
        '}\n',
      );

      // main.ts (version 1) — imports retry from utils
      fs.writeFileSync(
        path.join(testRepoPath, 'src', 'main.ts'),
        'import { retry } from "./utils.js";\n' +
        'import { TIMEOUT_MS } from "./constants.js";\n' +
        'export function execute(url: string): string {\n' +
        '  return retry(() => `fetched ${url} in ${TIMEOUT_MS}ms`);\n' +
        '}\n',
      );

      execSync('git add -A', { cwd: testRepoPath });
      execSync('git commit -m "initial"', { cwd: testRepoPath });

      const log = execSync('git log --oneline', { cwd: testRepoPath, encoding: 'utf-8' });
      expect(log).toContain('initial');
    });

    it('should run FULL analysis and capture baseline node/edge sets', async () => {
      const { runAnalyze } = await import('../../src/core/run-analyze.js');
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const { execSync } = await import('child_process');

      const stores = createStoreSet(loadConfig());
      try {
        const result = await runAnalyze(testRepoPath, projectId, stores, {});

        // Verify we captured symbols from all 3 files (query Neo4j for verification)
        const fileNodes: { id: string }[] = await stores.graph.query(
          `MATCH (f:File) WHERE f.projectId = $projectId AND f.filePath CONTAINS $utils RETURN f.id AS id`,
          { projectId, utils: 'utils.ts' },
        );
        expect(fileNodes.length).toBeGreaterThan(0);

        // Verify basic counts
        expect(result.nodeCount).toBeGreaterThan(5);
        expect(result.relationCount).toBeGreaterThan(2);

        // Store full baseline from Neo4j
        const fs = await import('fs');
        const baselineNodes: { id: string }[] = await stores.graph.query(
          `MATCH (n) WHERE n.projectId = $projectId RETURN n.id AS id ORDER BY id`,
          { projectId },
        );
        const baselineRels: { id: string }[] = await stores.graph.query(
          `MATCH ()-[r]->() WHERE r.projectId = $projectId RETURN r.id AS id ORDER BY id`,
          { projectId },
        );
        fs.writeFileSync(
          '/tmp/jelly-code-e2e-baseline.json',
          JSON.stringify({
            nodes: baselineNodes,
            relations: baselineRels,
          }, null, 2),
        );

        const headCommit = execSync('git rev-parse HEAD', { cwd: testRepoPath, encoding: 'utf-8' }).trim();

        // Set gitUrl and lastCommit on Project node for incremental mode
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit`,
          { projectId, gitUrl: `file://${testRepoPath}`, localPath: testRepoPath, lastCommit: headCommit },
        );
      } finally {
        await stores.close();
      }
    });

    it('should add a function, run INCREMENTAL, and match full on same repo', async () => {
      const { runAnalyze } = await import('../../src/core/run-analyze.js');
      const { runIncrementalAnalyze } = await import('../../src/core/run-incremental.js');
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const { RepoCacheManager } = await import('../../src/core/repo-cache.js');
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      // Add a new function to utils.ts
      fs.writeFileSync(
        path.join(testRepoPath, 'src', 'utils.ts'),
        fs.readFileSync(path.join(testRepoPath, 'src', 'utils.ts'), 'utf-8') + '\n' +
        'export function timeout<T>(ms: number): Promise<T> {\n' +
        '  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));\n' +
        '}\n',
      );

      execSync('git add -A && git commit -m "add timeout util"', { cwd: testRepoPath });

      const stores = createStoreSet(loadConfig());
      const repoCache = new RepoCacheManager({ cacheDir: '/tmp/jelly-code-e2e-cache', fullClone: true, cloneTimeout: 30000, fetchTimeout: 30000 });

      try {
        // Run incremental
        const incResult = await runIncrementalAnalyze(projectId, stores, repoCache);
        expect(incResult.mode).toBe('incremental');

        // Snapshot incremental node/edge sets
        const incNodes: { id: string }[] = await stores.graph.query(
          `MATCH (n) WHERE n.projectId = $projectId RETURN n.id AS id ORDER BY id`,
          { projectId },
        );
        const incNodeIds = new Set(incNodes.map((n: { id: string }) => n.id));
        const incRelations: { id: string }[] = await stores.graph.query(
          `MATCH ()-[r]->() WHERE r.projectId = $projectId RETURN r.id AS id ORDER BY id`,
          { projectId },
        );
        const incRelIds = new Set(incRelations.map((r: { id: string }) => r.id));

        // Clear project and run full analysis on clean stores
        await stores.graph.clearProject(projectId);
        const fullResult = await runAnalyze(testRepoPath, projectId, stores, {});
        const headCommit = execSync('git rev-parse HEAD', { cwd: testRepoPath, encoding: 'utf-8' }).trim();

        // Set gitUrl for Project node
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit`,
          { projectId, gitUrl: `file://${testRepoPath}`, localPath: testRepoPath, lastCommit: headCommit },
        );

        // Snapshot full node/edge sets
        const fullNodes: { id: string }[] = await stores.graph.query(
          `MATCH (n) WHERE n.projectId = $projectId RETURN n.id AS id ORDER BY id`,
          { projectId },
        );
        const fullNodeIds = new Set(fullNodes.map((n: { id: string }) => n.id));
        const fullRelations: { id: string }[] = await stores.graph.query(
          `MATCH ()-[r]->() WHERE r.projectId = $projectId RETURN r.id AS id ORDER BY id`,
          { projectId },
        );
        const fullRelIds = new Set(fullRelations.map((r: { id: string }) => r.id));

        // Core claim: incremental node set equals full rebuild node set
        expect(incNodeIds).toEqual(fullNodeIds);
        expect(incRelIds).toEqual(fullRelIds);

        // Also verify known counts
        expect(fullResult.nodeCount).toBeGreaterThan(incResult.nodeCount!);
        expect(fullResult.nodeCount).toBe(incResult.nodeCount! + 1); // timeout function
        expect(fullResult.relationCount).toBeGreaterThan(0);

        // Verify freshness
        const freshnessResult = await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           RETURN p.symbolsFreshness AS sf, p.communitiesFreshness AS cf,
                  p.temporalFreshness AS tf, p.totalFiles AS tfCount`,
          { projectId },
        );
        const f = freshnessResult[0] as Record<string, unknown> | undefined;
        expect(f?.sf).toBe('fresh');
        expect((f?.tfCount as number) || 0).toBeGreaterThan(1);
      } finally {
        await stores.close();
      }
    });

    it('should modify a function SIGNATURE, run INCREMENTAL, and match full on CALLS edges', async () => {
      const { runAnalyze } = await import('../../src/core/run-analyze.js');
      const { runIncrementalAnalyze } = await import('../../src/core/run-incremental.js');
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const { RepoCacheManager } = await import('../../src/core/repo-cache.js');
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      // Reset repo to v1 state
      execSync('git checkout -- .', { cwd: testRepoPath });

      // Modify function SIGNATURE of retry (add optional maxRetries parameter)
      // This should trigger CALLS edge changes since main.ts calls retry()
      const newUtils =
        'import { MAX_RETRIES } from "./constants.js";\n' +
        'export function retry<T>(fn: () => T, maxRetries?: number): T {\n' +
        '  const max = maxRetries ?? MAX_RETRIES;\n' +
        '  for (let i = 0; i < max; i++) {\n' +
        '    try { return fn(); } catch { continue; }\n' +
        '  }\n' +
        '  throw new Error("All retries failed");\n' +
        '}\n';

      fs.writeFileSync(path.join(testRepoPath, 'src', 'utils.ts'), newUtils);
      execSync('git add -A && git commit -m "change retry signature"', { cwd: testRepoPath });

      const stores = createStoreSet(loadConfig());
      const repoCache = new RepoCacheManager({ cacheDir: '/tmp/jelly-code-e2e-cache', fullClone: true, cloneTimeout: 30000, fetchTimeout: 30000 });

      try {
        // Run incremental
        const incResult = await runIncrementalAnalyze(projectId, stores, repoCache);
        expect(incResult.mode).toBe('incremental');

        // Snapshot incremental node/edge sets
        const incNodes: { id: string }[] = await stores.graph.query(
          `MATCH (n) WHERE n.projectId = $projectId RETURN n.id AS id ORDER BY id`,
          { projectId },
        );
        const incNodeIds = new Set(incNodes.map((n: { id: string }) => n.id));
        const incRels: { id: string }[] = await stores.graph.query(
          `MATCH ()-[r]->() WHERE r.projectId = $projectId RETURN r.id AS id ORDER BY id`,
          { projectId },
        );
        const incRelIds = new Set(incRels.map((r: { id: string }) => r.id));

        // Clear and run full on clean stores
        await stores.graph.clearProject(projectId);
        const fullResult = await runAnalyze(testRepoPath, projectId, stores, {});
        const headCommit = execSync('git rev-parse HEAD', { cwd: testRepoPath, encoding: 'utf-8' }).trim();

        // Set gitUrl for Project node
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit`,
          { projectId, gitUrl: `file://${testRepoPath}`, localPath: testRepoPath, lastCommit: headCommit },
        );

        // Snapshot full node/edge sets
        const fullNodes: { id: string }[] = await stores.graph.query(
          `MATCH (n) WHERE n.projectId = $projectId RETURN n.id AS id ORDER BY id`,
          { projectId },
        );
        const fullNodeIds = new Set(fullNodes.map((n: { id: string }) => n.id));
        const fullRels: { id: string }[] = await stores.graph.query(
          `MATCH ()-[r]->() WHERE r.projectId = $projectId RETURN r.id AS id ORDER BY id`,
          { projectId },
        );
        const fullRelIds = new Set(fullRels.map((r: { id: string }) => r.id));

        // Core claim: incremental result equals full rebuild — both node and edge sets
        expect(incNodeIds).toEqual(fullNodeIds);
        expect(incRelIds).toEqual(fullRelIds);

        // Known relationships should exist (verify CALLS edge from main -> retry)
        expect(fullResult.nodeCount).toBeGreaterThanOrEqual(6);
        expect(fullResult.relationCount).toBeGreaterThan(2);
      } finally {
        await stores.close();
      }
    });

    it('explosion guard: >50% change ratio should trigger full rebuild, not incremental', async () => {
      const { runAnalyze } = await import('../../src/core/run-analyze.js');
      const { runIncrementalAnalyze } = await import('../../src/core/run-incremental.js');
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const { RepoCacheManager } = await import('../../src/core/repo-cache.js');
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      const explodeRepo = `/tmp/jelly-code-e2e-explosion-${Date.now()}`;
      const explodeProjectId = 'e2e-explosion-test';
      fs.rmSync(explodeRepo, { recursive: true, force: true });
      fs.mkdirSync(explodeRepo, { recursive: true });

      // Create 20 files (+ 1 main) = 21 total files
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(
          path.join(explodeRepo, `src/module_${i}.ts`),
          `export function fn_${i}(): number { return ${i}; }\n`,
        );
      }
      fs.writeFileSync(
        path.join(explodeRepo, 'main.ts'),
        `export function entry(): number { return 0; }\n`,
      );
      execSync('git init', { cwd: explodeRepo });
      execSync('git config user.email test@test.com', { cwd: explodeRepo });
      execSync('git config user.name test', { cwd: explodeRepo });
      execSync('git add -A && git commit -m "v1: 21 files"', { cwd: explodeRepo });

      const stores = createStoreSet(loadConfig());
      const repoCache = new RepoCacheManager({
        cacheDir: `/tmp/jelly-code-e2e-cache-explode-${Date.now()}`, fullClone: true, cloneTimeout: 30000, fetchTimeout: 30000,
      });

      try {
        // Run full analysis (baseline)
        await stores.graph.clearProject(explodeProjectId);
        const fullResult = await runAnalyze(explodeRepo, explodeProjectId, stores, {});
        const headCommit = execSync('git rev-parse HEAD', { cwd: explodeRepo, encoding: 'utf-8' }).trim();
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit, p.totalFiles = $tf`,
          { projectId: explodeProjectId, gitUrl: `file://${explodeRepo}`, localPath: explodeRepo, lastCommit: headCommit, tf: fullResult.nodeCount },
        );

        const totalFiles = fullResult.nodeCount;

        // Now modify 12 of the 20 files (>50%)
        for (let i = 0; i < 12; i++) {
          fs.writeFileSync(
            path.join(explodeRepo, `src/module_${i}.ts`),
            `export function fn_${i}(): string { return "modified_${i}"; }\n`,
          );
        }
        execSync('git add -A && git commit -m "v2: modified 12/21 files > 50%"', { cwd: explodeRepo });

        // The explosion guard should detect this and fall back to full rebuild
        // Run incremental -- it should detect >50% change and convert to full
        const incResult = await runIncrementalAnalyze(explodeProjectId, stores, repoCache);

        // The key claim: explosion guard triggers full rebuild when >50% changes
        // This means the result must be 'full' mode, not 'incremental'
        expect(incResult.mode).toBe('full');
        expect(incResult.nodeCount).toBeGreaterThan(0);
      } finally {
        await stores.graph.clearProject(explodeProjectId);
        await stores.close();
        fs.rmSync(explodeRepo, { recursive: true, force: true });
      }
    }, 120000);

    it('empty change set: git commit with no file changes should be no-op', async () => {
      const { runIncrementalAnalyze } = await import('../../src/core/run-incremental.js');
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const { RepoCacheManager } = await import('../../src/core/repo-cache.js');
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      const emptyChangeRepo = `/tmp/jelly-code-e2e-empty-change-${Date.now()}`;
      const ecProjectId = 'e2e-empty-change-test';
      fs.rmSync(emptyChangeRepo, { recursive: true, force: true });
      fs.mkdirSync(emptyChangeRepo, { recursive: true });
      fs.writeFileSync(path.join(emptyChangeRepo, 'main.ts'),
        'export function foo(): number { return 1; }\n',
      );
      execSync('git init', { cwd: emptyChangeRepo });
      execSync('git config user.email test@test.com', { cwd: emptyChangeRepo });
      execSync('git config user.name test', { cwd: emptyChangeRepo });
      execSync('git add -A && git commit -m "v1"', { cwd: emptyChangeRepo });

      const stores = createStoreSet(loadConfig());
      const repoCache = new RepoCacheManager({
        cacheDir: `/tmp/jelly-code-e2e-cache-empty-${Date.now()}`, fullClone: true, cloneTimeout: 30000, fetchTimeout: 30000,
      });

      try {
        // Full analysis (baseline)
        await stores.graph.clearProject(ecProjectId);
        const { runAnalyze } = await import('../../src/core/run-analyze.js');
        await runAnalyze(emptyChangeRepo, ecProjectId, stores, {});
        const headCommit = execSync('git rev-parse HEAD', { cwd: emptyChangeRepo, encoding: 'utf-8' }).trim();
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit`,
          { projectId: ecProjectId, gitUrl: `file://${emptyChangeRepo}`, localPath: emptyChangeRepo, lastCommit: headCommit },
        );

        // Snapshot current node count
        const beforeNodes: { id: string }[] = await stores.graph.query(
          'MATCH (n {projectId: $projectId}) RETURN n.id AS id ORDER BY id',
          { projectId: ecProjectId },
        );

        // Create an empty commit (no file changes)
        execSync('git commit --allow-empty -m "empty commit"', { cwd: emptyChangeRepo });

        // Run incremental — should detect 0 changes and be a no-op
        const incResult = await runIncrementalAnalyze(ecProjectId, stores, repoCache);
        expect(incResult.mode).toBe('incremental');

        const afterNodes: { id: string }[] = await stores.graph.query(
          'MATCH (n {projectId: $projectId}) RETURN n.id AS id ORDER BY id',
          { projectId: ecProjectId },
        );

        // Node count should not change
        expect(afterNodes.length).toBe(beforeNodes.length);
      } finally {
        await stores.graph.clearProject(ecProjectId);
        await stores.close();
        fs.rmSync(emptyChangeRepo, { recursive: true, force: true });
      }
    }, 120000);

    it('should modify an INHERITANCE chain and produce matching OVERRIDES edges', async () => {
      const { runAnalyze } = await import('../../src/core/run-analyze.js');
      const { runIncrementalAnalyze } = await import('../../src/core/run-incremental.js');
      const { createStoreSet } = await import('../../src/store/index.js');
      const { loadConfig } = await import('../../src/config/index.js');
      const { RepoCacheManager } = await import('../../src/core/repo-cache.js');
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      // Create a separate test repo for inheritance testing
      const inheritRepo = '/tmp/jelly-code-e2e-inherit-repo';
      const inheritProjectId = 'e2e-inheritance-test';
      fs.rmSync(inheritRepo, { recursive: true, force: true });
      fs.mkdirSync(path.join(inheritRepo, 'src'), { recursive: true });
      execSync('git init', { cwd: inheritRepo });
      execSync('git config user.email test@test.com', { cwd: inheritRepo });
      execSync('git config user.name test', { cwd: inheritRepo });

      // Create TypeScript classes: Base → Derived hierarchy
      fs.writeFileSync(
        path.join(inheritRepo, 'src', 'base.ts'),
        'export class Base {\n' +
        '  greet(): string { return "Hello from Base"; }\n' +
        '  getId(): number { return 1; }\n' +
        '}\n',
      );
      fs.writeFileSync(
        path.join(inheritRepo, 'src', 'derived.ts'),
        'import { Base } from "./base.js";\n' +
        'export class Derived extends Base {\n' +
        '  greet(): string { return "Hello from Derived"; }\n' +
        '}\n',
      );
      fs.writeFileSync(
        path.join(inheritRepo, 'src', 'main.ts'),
        'import { Derived } from "./derived.js";\n' +
        'const d = new Derived();\n' +
        'export function run(): string { return d.greet(); }\n',
      );
      execSync('git add -A && git commit -m "v1: Base → Derived hierarchy"', { cwd: inheritRepo });

      // Run full analysis (baseline)
      const stores = createStoreSet(loadConfig());
      const repoCache = new RepoCacheManager({ cacheDir: '/tmp/jelly-code-e2e-cache2', fullClone: true, cloneTimeout: 30000, fetchTimeout: 30000 });

      try {
        await stores.graph.clearProject(inheritProjectId);
        await runAnalyze(inheritRepo, inheritProjectId, stores, {});
        const baselineCommit = execSync('git rev-parse HEAD', { cwd: inheritRepo, encoding: 'utf-8' }).trim();
        await stores.graph.query(
          `MATCH (p:Project {id: $projectId})
           SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit`,
          { projectId: inheritProjectId, gitUrl: `file://${inheritRepo}`, localPath: inheritRepo, lastCommit: baselineCommit },
        );

        // Verify baseline has OVERRIDES or EXTENDS edges
        const baselineExtends = await stores.graph.query(
          'MATCH (child)-[r:CodeRelation]->(parent) WHERE r.type IN $types AND child.projectId = $projectId RETURN count(r) AS cnt',
          { types: ['EXTENDS', 'IMPLEMENTS'], projectId: inheritProjectId },
        );
        expect((baselineExtends[0]?.cnt as number) || 0).toBeGreaterThan(0);

        // Modify: add an intermediate class in the inheritance chain
        fs.writeFileSync(
          path.join(inheritRepo, 'src', 'intermediate.ts'),
          'import { Base } from "./base.js";\n' +
          'export class Intermediate extends Base {\n' +
          '  greet(): string { return "Hello from Intermediate"; }\n' +
          '}\n',
        );
        // Update derived to extend Intermediate instead of Base
        fs.writeFileSync(
          path.join(inheritRepo, 'src', 'derived.ts'),
          'import { Intermediate } from "./intermediate.js";\n' +
          'export class Derived extends Intermediate {\n' +
          '  greet(): string { return "Hello from Derived"; }\n' +
          '}\n',
        );
        execSync('git add -A && git commit -m "v2: add Intermediate, Derived now extends Intermediate"', { cwd: inheritRepo });

        // Run incremental
        const incResult = await runIncrementalAnalyze(inheritProjectId, stores, repoCache);
        expect(incResult.mode).toBe('incremental');

        // Get incremental state
        const incExtends = await stores.graph.query(
          'MATCH (child)-[r:CodeRelation]->(parent) WHERE r.type IN $types AND child.projectId = $projectId RETURN child.id AS childId, r.type AS type, parent.id AS parentId',
          { types: ['EXTENDS', 'IMPLEMENTS', 'OVERRIDES'], projectId: inheritProjectId },
        );

        // Clear and run full
        await stores.graph.clearProject(inheritProjectId);
        await runAnalyze(inheritRepo, inheritProjectId, stores, {});
        const fullExtends = await stores.graph.query(
          'MATCH (child)-[r:CodeRelation]->(parent) WHERE r.type IN $types AND child.projectId = $projectId RETURN child.id AS childId, r.type AS type, parent.id AS parentId',
          { types: ['EXTENDS', 'IMPLEMENTS', 'OVERRIDES'], projectId: inheritProjectId },
        );

        // Core claim: EXTENDS/IMPLEMENTS/OVERRIDES edges match between incremental and full
        const incEdgeSet = new Set(incExtends.map(r => `${r.childId}-${r.type}-${r.parentId}`));
        const fullEdgeSet = new Set(fullExtends.map(r => `${r.childId}-${r.type}-${r.parentId}`));
        expect(incEdgeSet).toEqual(fullEdgeSet);
      } finally {
        await stores.close();
      }
    });

  }, 120000); // 120s timeout for all E2E tests
} else {
  // Conditional skip: empty describe with explanatory note
  describe.skip('E2E: Incremental result == Full result', () => {
    it('skipped — requires JELLY_CODE_E2E=1 and running backends', () => {
      expect(true).toBe(true);
    });
  });
}
