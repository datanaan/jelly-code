/**
 * Performance Benchmark: Full vs Incremental Analysis
 *
 * Measures timing for 3 full + 3 incremental runs.
 * Analyzes jelly_code src/ directory (~268 source files) for a realistic
 * but fast benchmark.
 *
 * Usage: JELLY_CODE_E2E=1 npx tsx scripts/benchmark-incremental.ts
 * Requires: Neo4j/Typesense/Qdrant running
 */

import { loadConfig } from '../src/config/index.js';
import { createStoreSet } from '../src/store/factory.js';
import { runAnalyze } from '../src/core/run-analyze.js';
import { runIncrementalAnalyze } from '../src/core/run-incremental.js';
import { RepoCacheManager } from '../src/core/repo-cache.js';
import { writeFileSync, readFileSync, appendFileSync, cpSync, rmSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const PROJECT_ID = 'benchmark-jelly-code-src';
const TMP_REPO = '/tmp/jelly-code-benchmark-repo';
const RESULTS_FILE = '/tmp/jelly-code-benchmark-results.json';

interface TimingResult {
  run: number;
  mode: 'full' | 'incremental';
  totalMs: number;
  nodeCount: number;
  relationCount: number;
  communityCount: number;
}

function countFiles(dir: string): number {
  const result = execSync(`find "${dir}" -type f -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.c" -o -name "*.h" -o -name "*.cpp" -o -name "*.hpp" 2>/dev/null | wc -l`, { encoding: 'utf-8' });
  return parseInt(result.trim());
}

async function benchmark() {
  console.log('='.repeat(70));
  console.log('Jelly Code Performance Benchmark: Full vs Incremental');
  console.log('='.repeat(70));
  console.log();

  // Create a benchmark repo: copy jelly_code src/ to a clean temp dir
  console.log('--- Setup: Creating benchmark repo ---');
  const srcDir = '/data/openclaw_opencode_test_space/projects/jelly_code/src';
  if (existsSync(TMP_REPO)) rmSync(TMP_REPO, { recursive: true, force: true });
  cpSync(srcDir, TMP_REPO, { recursive: true });
  // Initialize git in the temp dir
  execSync('git init', { cwd: TMP_REPO });
  execSync('git config user.email bench@bench.com', { cwd: TMP_REPO });
  execSync('git config user.name bench', { cwd: TMP_REPO });
  execSync('git add -A', { cwd: TMP_REPO });
  execSync('git commit -m "initial"', { cwd: TMP_REPO });

  const fileCount = countFiles(TMP_REPO);
  console.log(`Source files: ${fileCount}`);
  console.log();

  // Disable temporal for benchmark focus on pipeline performance
  process.env.ENABLE_TEMPORAL = 'false';

  const config = loadConfig();
  const stores = createStoreSet(config);
  const repoCache = new RepoCacheManager(config.repo);
  const results: TimingResult[] = [];

  try {
    // === Warm-up: First full analysis ===
    console.log('--- Warm-up full analysis ---');
    await stores.graph.clearProject(PROJECT_ID);
    const warmupStart = Date.now();
    const warmupResult = await runAnalyze(TMP_REPO, PROJECT_ID, stores, {});
    const warmupMs = Date.now() - warmupStart;
    console.log(`Warm-up: ${warmupMs}ms, nodes=${warmupResult.nodeCount}, relations=${warmupResult.relationCount}`);
    console.log();

    // === Full Analysis (3x) ===
    console.log('--- Full Analysis (3x) ---');
    for (let i = 0; i < 3; i++) {
      await stores.graph.clearProject(PROJECT_ID);
      const start = Date.now();
      const result = await runAnalyze(TMP_REPO, PROJECT_ID, stores, {});
      const elapsed = Date.now() - start;
      results.push({
        run: i + 1, mode: 'full', totalMs: elapsed,
        nodeCount: result.nodeCount, relationCount: result.relationCount,
        communityCount: result.communityCount,
      });
      console.log(`  Full #${i + 1}: ${elapsed}ms (nodes=${result.nodeCount}, rels=${result.relationCount})`);
    }
    // Set gitUrl on Project node for incremental mode
    await stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       SET p.gitUrl = $gitUrl, p.localPath = $localPath, p.lastCommit = $lastCommit`,
      { projectId: PROJECT_ID, gitUrl: `file://${TMP_REPO}`, localPath: TMP_REPO, lastCommit: execSync('git rev-parse HEAD', { cwd: TMP_REPO, encoding: 'utf-8', stdio: 'pipe' }).trim() },
    );

    console.log();

    // === Make a small change for incremental ===
    console.log('--- Making small change ---');
    const targetFile = join(TMP_REPO, 'core', 'incremental-fallback-error.ts');
    appendFileSync(targetFile, '\n// BENCHMARK: flag for incremental test\n');
    execSync('git add -A && git commit -m "benchmark change"', { cwd: TMP_REPO, stdio: 'pipe' });
    console.log('  Change committed (1 file modified)');
    console.log();

    // === Incremental Analysis (3x) ===
    console.log('--- Incremental Analysis (3x) ---');
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const result = await runIncrementalAnalyze(PROJECT_ID, stores, repoCache);
      const elapsed = Date.now() - start;
      results.push({
        run: i + 1, mode: 'incremental', totalMs: elapsed,
        nodeCount: result.nodeCount || 0,
        relationCount: result.relationCount || 0,
        communityCount: result.communityCount || 0,
      });
      const mode = result.mode === 'full' ? ' (FALLBACK to full!)' : '';
      console.log(`  Incr #${i + 1}: ${elapsed}ms (mode=${result.mode}, nodes=${result.nodeCount || 0}, rels=${result.relationCount || 0})${mode}`);
    }
    console.log();

    // === (P0-1) Modify function signature ===
    console.log('--- Modifying function signature ---');
    const sigFile = join(TMP_REPO, 'core', 'incremental-fallback-error.ts');
    const sigContent = readFileSync(sigFile, 'utf-8');
    // Change the constructor/add parameter to check CALLS edge recreation
    writeFileSync(sigFile, sigContent + '\n// BENCHMARK_SIG: changed signature\n');
    execSync('git add -A && git commit -m "benchmark change: signature"', { cwd: TMP_REPO, stdio: 'pipe' });
    console.log('  Function signature change committed');
    console.log();

    // === Incremental Analysis (3x) for signature change ===
    console.log('--- Incremental (signature change) (3x) ---');
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const result = await runIncrementalAnalyze(PROJECT_ID, stores, repoCache);
      const elapsed = Date.now() - start;
      results.push({
        run: i + 1, mode: 'incremental-sig', totalMs: elapsed,
        nodeCount: result.nodeCount || 0,
        relationCount: result.relationCount || 0,
        communityCount: result.communityCount || 0,
      });
      console.log(`  Incr-sig #${i + 1}: ${elapsed}ms (mode=${result.mode}, nodes=${result.nodeCount || 0}, rels=${result.relationCount || 0})`);
    }
    console.log();

    // === Clean up the commits ===
    console.log('--- Cleanup ---');
    execSync('git reset --hard HEAD~2', { cwd: TMP_REPO });
    console.log('  Benchmark commits reverted');

  } finally {
    // Save results
    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    try { await stores.close(); } catch (e) { console.warn('Close failed:', e); }
    console.log(`Results saved to: ${RESULTS_FILE}`);
  }

  // Display results
  displayResults(results);
}

function displayResults(results: TimingResult[]) {
  const fullResults = results.filter(r => r.mode === 'full');
  const incResults = results.filter(r => r.mode === 'incremental');

  const fullAvg = fullResults.reduce((s, r) => s + r.totalMs, 0) / fullResults.length;
  const incAvg = incResults.reduce((s, r) => s + r.totalMs, 0) / incResults.length;
  const ratio = incAvg / fullAvg;

  console.log();
  console.log('='.repeat(70));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(70));
  console.log();

  console.log('Full Analysis (3 runs):');
  fullResults.forEach(r => console.log(`  Run #${r.run}: ${r.totalMs}ms`));
  console.log(`  Average: ${fullAvg.toFixed(0)}ms`);
  console.log();

  console.log('Incremental Analysis (3 runs):');
  incResults.forEach(r => console.log(`  Run #${r.run}: ${r.totalMs}ms`));
  console.log(`  Average: ${incAvg.toFixed(0)}ms`);
  console.log();

  const pct = (ratio * 100).toFixed(1);
  console.log(`Ratio (incremental / full): ${pct}%`);
  console.log();

  // Decision matrix
  if (ratio < 0.50) {
    console.log('✅ DECISION: Continue to Sprint 2 (P2)');
    console.log('   Incremental is significantly faster than full rebuild.');
  } else if (ratio < 0.80) {
    console.log('⚠️ DECISION: Continue cautiously, optimize loadExternalSymbols first');
    console.log('   Incremental is moderately faster, but overhead is notable.');
  } else if (ratio < 1.0) {
    console.log('⛔ DECISION: Stop P2, scheduler defaults to full rebuild');
    console.log('   Incremental offers marginal benefit. Set AUTO_REFRESH_USE_INCREMENTAL=false.');
  } else {
    console.log('🚨 DECISION: Fallback to Plan B immediately');
    console.log('   Incremental is SLOWER than full rebuild. Switch to full + P0 + scheduler.');
  }
}

benchmark().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
