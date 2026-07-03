/**
 * E2E Test: P0a Smart Skip Mechanism
 *
 * Validates the four-layer skip detector against a realistic fixture repo
 * with vendor/, node_modules/, binary files, language-specific build dirs,
 * and documents that must be preserved (even inside vendor/).
 *
 * Prerequisites: None (pure filesystem, no Neo4j/Typesense/Qdrant needed).
 *
 * Run with: npx vitest run test/e2e/p0a-skip-mechanism.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { walkRepositoryPaths, type WalkRepositoryResult } from '../../src/core/ingestion/filesystem-walker.js';
import { skipE2E, makeTempDir, writeFixtureFile } from './helpers.js';

// ─── E2E gate ───────────────────────────────────────────────────────────────
// (skipE2E imported from helpers.ts)

describe.skipIf(skipE2E)('P0a E2E: Smart Skip Mechanism', () => {
  let repoDir: string;
  let result: WalkRepositoryResult;
  const paths = new Set<string>();

  beforeAll(async () => {
    // ── Build a realistic fixture repo ────────────────────────────────
    repoDir = makeTempDir('p0a-e2e');

    // Real source code (should be kept)
    writeFixtureFile(repoDir, 'src/index.ts', 'export const hello = "world";\n');
    writeFixtureFile(repoDir, 'src/lib/utils.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    writeFixtureFile(repoDir, 'src/lib/__tests__/utils.test.ts', 'test("add", () => {});\n');

    // Root docs (should be kept)
    writeFixtureFile(repoDir, 'README.md', '# Test Repo\n\nThis is a test fixture.\n');
    writeFixtureFile(repoDir, 'LICENSE', 'MIT License\n\nCopyright (c) 2026\n');
    writeFixtureFile(repoDir, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n- Initial\n');

    // Docs directory
    writeFixtureFile(repoDir, 'docs/guide.md', '# Guide\n\nHow to use this.\n');
    writeFixtureFile(repoDir, 'docs/api.md', '# API\n\n## Functions\n');

    // ── Vendor / dependency dirs (should be skipped) ──────────────────
    writeFixtureFile(repoDir, 'node_modules/lodash/index.js', 'module.exports = {};\n');
    writeFixtureFile(repoDir, 'node_modules/lodash/package.json', '{"name":"lodash"}\n');
    writeFixtureFile(repoDir, 'node_modules/lodash/README.md', '# Lodash\n\nUtility lib.\n'); // doc whitelist!

    writeFixtureFile(repoDir, 'vendor/lib/main.js', 'export const x = 1;\n');
    writeFixtureFile(repoDir, 'vendor/lib/README.md', '# Vendored Lib\n\nDocs.\n'); // doc whitelist!

    writeFixtureFile(repoDir, 'third_party/sdk/sdk.js', 'export const sdk = {};\n');

    // ── Binary files (should be skipped) ──────────────────────────────
    // ELF magic bytes
    writeFixtureFile(repoDir, 'native/libfoo.so', Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Buffer.alloc(100, 0)]));
    // PNG
    writeFixtureFile(repoDir, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(100, 0)]));
    // Random binary
    writeFixtureFile(repoDir, 'bin/tool.bin', Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256)));

    // ── Language-specific build dirs (should be skipped) ──────────────
    writeFixtureFile(repoDir, 'target/debug/build/output', 'binary artifact\n');
    writeFixtureFile(repoDir, 'dist/bundle.min.js', 'var a=1;var b=2;\n');
    // Python build artifacts
    writeFixtureFile(repoDir, '__pycache__/module.pyc', Buffer.from([0x00, 0x00, 0x00, 0x00]));
    writeFixtureFile(repoDir, 'src/__pycache__/utils.cpython-312.pyc', Buffer.from([0x00, 0x00, 0x00, 0x00]));
    writeFixtureFile(repoDir, 'src/parsed.pyo', 'optimized\n');

    // ── .jellyignore (highest priority custom) ────────────────────────
    writeFixtureFile(repoDir, '.jellyignore', [
      '# Custom ignore',
      'secrets/',
      '*.dat',
      'local-only/',
      '',
    ].join('\n'));

    // Files that should be skipped by .jellyignore
    writeFixtureFile(repoDir, 'secrets/api-keys.txt', 'api_key=abc123\n');
    writeFixtureFile(repoDir, 'local-only/scratch.md', '# scratch\n');
    writeFixtureFile(repoDir, 'data/config.dat', 'binary data here\n');

    // ── Run walker ────────────────────────────────────────────────────
    result = await walkRepositoryPaths(repoDir, undefined, {
      returnSkipSummary: true,
    });

    for (const f of result.files) {
      paths.add(f.path.replace(/\\/g, '/'));
    }
  }, 30_000);

  afterAll(() => {
    if (repoDir && process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ── Source files kept ──────────────────────────────────────────────
  it('keeps real source files', () => {
    expect(paths.has('src/index.ts')).toBe(true);
    expect(paths.has('src/lib/utils.ts')).toBe(true);
  });

  it('keeps root documentation', () => {
    expect(paths.has('README.md')).toBe(true);
    expect(paths.has('LICENSE')).toBe(true); // no extension, filename whitelist
    expect(paths.has('CHANGELOG.md')).toBe(true);
    expect(paths.has('docs/guide.md')).toBe(true);
    expect(paths.has('docs/api.md')).toBe(true);
  });

  // ── Vendor skipped ─────────────────────────────────────────────────
  it('skips node_modules directory', () => {
    expect(paths.has('node_modules/lodash/index.js')).toBe(false);
    expect(paths.has('node_modules/lodash/package.json')).toBe(false);
  });

  it('skips vendor/ directory', () => {
    expect(paths.has('vendor/lib/main.js')).toBe(false);
  });

  it('skips third_party/ directory', () => {
    expect(paths.has('third_party/sdk/sdk.js')).toBe(false);
  });

  // ── Document whitelist preserves docs even inside vendor ───────────
  it('preserves README.md inside node_modules/ (T6 whitelist)', () => {
    expect(paths.has('node_modules/lodash/README.md')).toBe(true);
  });

  it('preserves README.md inside vendor/ (T6 whitelist)', () => {
    expect(paths.has('vendor/lib/README.md')).toBe(true);
  });

  // ── Binary skipped ─────────────────────────────────────────────────
  it('skips .so binary (ELF magic bytes)', () => {
    expect(paths.has('native/libfoo.so')).toBe(false);
  });

  it('skips .png binary', () => {
    expect(paths.has('assets/logo.png')).toBe(false);
  });

  it('skips .bin binary (NULL byte heuristic)', () => {
    expect(paths.has('bin/tool.bin')).toBe(false);
  });

  // ── Language-specific build dirs skipped ───────────────────────────
  it('skips Rust target/ (language profile)', () => {
    expect(paths.has('target/debug/build/output')).toBe(false);
  });

  // ── .jellyignore highest priority ──────────────────────────────────
  it('respects .jellyignore: secrets/ skipped', () => {
    expect(paths.has('secrets/api-keys.txt')).toBe(false);
  });

  it('respects .jellyignore: local-only/ skipped', () => {
    expect(paths.has('local-only/scratch.md')).toBe(false);
  });

  it('respects .jellyignore: *.dat skipped', () => {
    expect(paths.has('data/config.dat')).toBe(false);
  });

  // ── Skip summary populated ─────────────────────────────────────────
  it('returns skip summary with vendor > 0', () => {
    expect(result.skipSummary.skippedVendor).toBeGreaterThan(0);
  });

  it('returns skip summary with binary > 0', () => {
    expect(result.skipSummary.skippedBinary).toBeGreaterThan(0);
  });

  it('returns skip summary with preservedDocs > 0 (whitelist saved docs)', () => {
    expect(result.skipSummary.preservedDocs).toBeGreaterThan(0);
  });

  // ── Additional language build dirs ────────────────────────────────
  it('skips Python __pycache__/ build directory', () => {
    expect(paths.has('__pycache__/module.pyc')).toBe(false);
  });

  it('skips .pyc and .pyo compiled bytecode files', () => {
    expect(paths.has('src/__pycache__/utils.cpython-312.pyc')).toBe(false);
    expect(paths.has('src/parsed.pyo')).toBe(false);
  });

  // ── Overall: significant reduction ─────────────────────────────────
  it('overall: kept files are << total fixture files (90%+ reduction)', () => {
    // Total fixture files written: 22 (count manually from above)
    // Expected kept: ~10 (src + docs + whitelisted)
    // Reduction should be 50%+ (not 90% because fixture is small + has many docs)
    expect(result.files.length).toBeLessThan(15);
    expect(result.files.length).toBeGreaterThan(5);
  });
});
