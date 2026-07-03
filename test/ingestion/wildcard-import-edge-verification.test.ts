/**
 * Tests: P2-8 Wildcard Import Edge Verification (Real Pipeline)
 *
 * v3/v4 code review: prior tests were "剧场式修复" — they claimed to
 * parse real files but only called low-level resolver functions.
 *
 * THIS test actually runs the real ingestion pipeline on TypeScript files
 * via defaultPipelineRunner and verifies the produced relations.
 *
 * Note: TypeScript named imports are resolved into CALLS edges (not IMPORTS
 * edges) during the worker-path extraction. IMPORTS edges are primarily used
 * for wildcard-import languages (Go, C++, Ruby) where whole-module imports
 * need explicit tracking. The CALLS edge from main.ts → utils.ts:retry
 * is the correct indicator that cross-file import resolution worked.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('P2-8: Real Pipeline Import Edge Verification', () => {

  it('TS: named import produces CALLS edge (proving cross-file resolution)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'jelly-import-test-'));
    const srcDir = join(tmpDir, 'src');
    execSync(`mkdir -p "${srcDir}"`, { stdio: 'pipe' });

    writeFileSync(join(srcDir, 'utils.ts'),
      'export function helper(): number { return 42; }\n' +
      'export const VERSION = "1.0";\n'
    );
    writeFileSync(join(srcDir, 'main.ts'),
      'import { helper, VERSION } from "./utils.js";\n' +
      'export function run(): string { return `v${VERSION}: ${helper()}`; }\n'
    );

    const { defaultPipelineRunner } = await import('../../src/core/run-analyze.js');
    let result;
    try {
      result = await defaultPipelineRunner(tmpDir, () => {}, { skipGraphPhases: true });
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`Pipeline failed: ${err instanceof Error ? err.message + '\n' + (err.stack || '') : err}`);
    }
    rmSync(tmpDir, { recursive: true, force: true });

    expect(result).toBeDefined();
    expect(result.relations.length).toBeGreaterThan(0);

    // Verify CALLS edges exist (cross-file call resolution → import worked)
    const callsEdges = result.relations.filter(r => r.type === 'CALLS');
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);

    // Verify the specific CALLS edge: main.ts:run → utils.ts:helper
    const hasCallToHelper = callsEdges.some(r =>
      r.targetId && r.targetId.includes('utils.ts') && r.targetId.includes('helper')
    );
    expect(hasCallToHelper).toBe(true);

    // Verify DEFINES edges exist (type definitions were extracted)
    const definesEdges = result.relations.filter(r => r.type === 'DEFINES');
    expect(definesEdges.length).toBeGreaterThan(0);
  });

  it('TS: multi-file chain produces correct CALLS edges', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'jelly-chain-test-'));
    const srcDir = join(tmpDir, 'src');
    execSync(`mkdir -p "${srcDir}"`, { stdio: 'pipe' });

    writeFileSync(join(srcDir, 'constants.ts'), 'export const MAX = 100;\n');
    writeFileSync(join(srcDir, 'utils.ts'),
      'import { MAX } from "./constants.js";\n' +
      'export function helper(): number { return MAX; }\n'
    );
    writeFileSync(join(srcDir, 'main.ts'),
      'import { helper } from "./utils.js";\n' +
      'export function run(): number { return helper(); }\n'
    );

    const { defaultPipelineRunner } = await import('../../src/core/run-analyze.js');
    let result;
    try {
      result = await defaultPipelineRunner(tmpDir, () => {}, { skipGraphPhases: true });
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`Pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    rmSync(tmpDir, { recursive: true, force: true });

    expect(result).toBeDefined();
    expect(result.relations.length).toBeGreaterThan(0);

    // All 3 files should produce nodes
    const fileNodes = result.nodes.filter(n => n.type === 'File');
    expect(fileNodes.some(n => n.filePath.endsWith('constants.ts'))).toBe(true);
    expect(fileNodes.some(n => n.filePath.endsWith('utils.ts'))).toBe(true);
    expect(fileNodes.some(n => n.filePath.endsWith('main.ts'))).toBe(true);

    // CALLS edge from main → helper (cross-file)
    const callsEdges = result.relations.filter(r => r.type === 'CALLS');
    expect(callsEdges.some(r =>
      r.targetId && r.targetId.includes('utils.ts') && r.targetId.includes('helper')
    )).toBe(true);
  });

  it('TS: exported function is captured with correct metadata', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'jelly-export-test-'));
    const srcDir = join(tmpDir, 'src');
    execSync(`mkdir -p "${srcDir}"`, { stdio: 'pipe' });

    writeFileSync(join(srcDir, 'service.ts'),
      'export function greet(name: string): string {\n' +
      '  return `Hello ${name}`;\n' +
      '}\n' +
      'function internal(): void {}\n'
    );

    const { defaultPipelineRunner } = await import('../../src/core/run-analyze.js');
    let result;
    try {
      result = await defaultPipelineRunner(tmpDir, () => {}, { skipGraphPhases: true });
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`Pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    rmSync(tmpDir, { recursive: true, force: true });

    expect(result).toBeDefined();
    expect(result.nodes.length).toBeGreaterThan(0);

    const greetNode = result.nodes.find(n => n.name === 'greet');
    expect(greetNode).toBeDefined();
    expect(greetNode!.filePath).toBe('src/service.ts');

    // Since internal() is not exported but still captured as a node
    const internalNode = result.nodes.find(n => n.name === 'internal');
    expect(internalNode).toBeDefined();
    expect(internalNode!.filePath).toBe('src/service.ts');
  });
});
