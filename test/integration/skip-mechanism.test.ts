/**
 * Integration tests for the skip mechanism in filesystem-walker.
 *
 * These tests create REAL temporary directories and files on disk,
 * then walk them through `walkRepositoryPaths` to verify that all
 * four detectors (vendor, binary, large file, language profile)
 * and .jellyignore patterns are correctly integrated.
 *
 * No mocks — every test exercises the actual filesystem walker.
 */

import { describe, it, expect } from 'vitest';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('skip-mechanism', () => {
  // Helper: create a temp directory and clean up after each test
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'jelly-skip-test-'));
  }

  // ── T2: Vendor directory skipping ────────────────────────────

  it('skips node_modules directory', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'lodash.js'), 'export default {};');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.includes('node_modules'))).toBe(false);
      expect(results.some((r) => r.path.includes('src/index.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips vendor/ directory', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'vendor'), { recursive: true });
      writeFileSync(join(dir, 'vendor', 'deps.go'), 'package vendor');
      mkdirSync(join(dir, 'main'), { recursive: true });
      writeFileSync(join(dir, 'main', 'main.go'), 'package main');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.includes('vendor/'))).toBe(false);
      expect(results.some((r) => r.path.includes('main/main.go'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips third_party/ directory', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'third_party'), { recursive: true });
      writeFileSync(join(dir, 'third_party', 'lib.cpp'), '#include <iostream>');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.cpp'), 'int main() {}');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.includes('third_party/'))).toBe(false);
      expect(results.some((r) => r.path.includes('src/app.cpp'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T3: Binary file skipping ────────────────────────────────

  it('skips .so file (binary by extension)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'lib'), { recursive: true });
      // Write a file with .so extension — should be detected as binary by extension
      writeFileSync(join(dir, 'lib', 'libnative.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'main.ts'), 'console.log("hello");');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('.so'))).toBe(false);
      expect(results.some((r) => r.path.includes('src/main.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips .png file (binary by extension)', async () => {
    const dir = makeTempDir();
    try {
      // Write a minimal PNG file (8-byte signature + IHDR chunk)
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, // IHDR length
        0x49, 0x48, 0x44, 0x52, // "IHDR"
      ]);
      writeFileSync(join(dir, 'logo.png'), pngBytes);
      writeFileSync(join(dir, 'readme.md'), '# Hello');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('.png'))).toBe(false);
      expect(results.some((r) => r.path.includes('readme.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T4: .jellyignore pattern skipping ───────────────────────

  it('skips by .jellyignore pattern (highest priority)', async () => {
    const dir = makeTempDir();
    try {
      // .jellyignore with a custom pattern
      writeFileSync(join(dir, '.jellyignore'), 'secrets/\n*.env\n');
      mkdirSync(join(dir, 'secrets'), { recursive: true });
      writeFileSync(join(dir, 'secrets', 'api-key.txt'), 'SUPER_SECRET');
      writeFileSync(join(dir, 'app.ts'), 'export const app = "test";');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.includes('secrets/'))).toBe(false);
      expect(results.some((r) => r.path.includes('app.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T1: Language profile skipping ───────────────────────────

  it('skips by language profile (Rust target/ directory)', async () => {
    const dir = makeTempDir();
    try {
      // Create a Rust project structure
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'main.rs'), 'fn main() {}');
      mkdirSync(join(dir, 'target'), { recursive: true });
      mkdirSync(join(dir, 'target', 'debug'), { recursive: true });
      writeFileSync(join(dir, 'target', 'debug', 'test_bin'), 'binary artifact');
      writeFileSync(join(dir, 'target', 'debug', 'deps.bin'), 'dep info');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.includes('target/'))).toBe(false);
      expect(results.some((r) => r.path.includes('src/main.rs'))).toBe(true);
      expect(results.some((r) => r.path.includes('Cargo.toml'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Large file skipping (existing functionality) ────────────

  it('skips files larger than MAX_FILE_SIZE', async () => {
    const dir = makeTempDir();
    try {
      // Create a file larger than 512KB (the current MAX_FILE_SIZE)
      const largeContent = 'x'.repeat(600 * 1024);
      writeFileSync(join(dir, 'large.txt'), largeContent);
      writeFileSync(join(dir, 'small.ts'), 'export const x = 1;');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.includes('large.txt'))).toBe(false);
      expect(results.some((r) => r.path.includes('small.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Regular source files are preserved ──────────────────────

  it('preserves regular source files of various types', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'app.ts'), 'export const app = "test";');
      writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
      writeFileSync(join(dir, 'main.py'), 'print("hello")');
      writeFileSync(join(dir, 'README.md'), '# Project');
      writeFileSync(join(dir, 'style.css'), 'body { margin: 0; }');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'utils.ts'), 'export function foo() {}');

      const results = await walkRepositoryPaths(dir);
      const paths = results.map((r) => r.path);
      expect(paths).toContain('app.ts');
      expect(paths).toContain('index.js');
      expect(paths).toContain('main.py');
      expect(paths).toContain('README.md');
      expect(paths).toContain('style.css');
      expect(paths).toContain('src/utils.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Skip summary is returned when requested ─────────────────

  it('returns skip summary when returnSkipSummary option is set', async () => {
    const dir = makeTempDir();
    try {
      // Vendor directory
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'lib.js'), 'module.exports = {};');
      // Binary file
      writeFileSync(
        join(dir, 'image.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      // Large file
      writeFileSync(join(dir, 'big.txt'), 'x'.repeat(600 * 1024));
      // Regular source
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1;');

      const result = await walkRepositoryPaths(dir, undefined, {
        returnSkipSummary: true,
      });

      // When returnSkipSummary is true, result is an object with files + skipSummary
      expect(result).toHaveProperty('files');
      expect(result).toHaveProperty('skipSummary');
      const summary = (result as any).skipSummary;
      expect(summary.skippedVendor).toBeGreaterThan(0);
      expect(summary.skippedBinary).toBeGreaterThan(0);
      expect(summary.skippedLarge).toBeGreaterThan(0);
      expect(summary.skippedLanguage).toBeDefined();

      const files = (result as any).files as Array<{ path: string }>;
      expect(files.some((r) => r.path.includes('node_modules'))).toBe(false);
      expect(files.some((r) => r.path.endsWith('.png'))).toBe(false);
      expect(files.some((r) => r.path.includes('big.txt'))).toBe(false);
      expect(files.some((r) => r.path.includes('index.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Backward compatibility: default return is ScannedFile[] ─

  it('maintains backward compatibility without options parameter', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1;');

      const results = await walkRepositoryPaths(dir);
      // Without options, returns plain array (backward compatible)
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('index.ts');
      expect(results[0].size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T6: Document whitelist (preserve docs in vendor/build dirs) ──

  it('preserves README.md inside vendor/', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
      writeFileSync(join(dir, 'vendor', 'lib', 'README.md'), '# Lib Docs');
      writeFileSync(join(dir, 'vendor', 'lib', 'main.js'), 'export const x = 1;');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('README.md'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('main.js'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves CHANGELOG.md inside node_modules/', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'node_modules', 'express'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'express', 'CHANGELOG.md'), '# v2.0.0');
      writeFileSync(join(dir, 'node_modules', 'express', 'index.js'), 'module.exports = {};');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('CHANGELOG.md'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('index.js'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves LICENSE (no extension) inside build/', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'build', 'deps'), { recursive: true });
      writeFileSync(join(dir, 'build', 'deps', 'LICENSE'), 'MIT License\nCopyright 2024');
      writeFileSync(join(dir, 'build', 'deps', 'output.js'), 'var x = 1;');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('LICENSE'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('output.js'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves docs/api.md inside vendor/', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'vendor', 'pkg', 'docs'), { recursive: true });
      writeFileSync(join(dir, 'vendor', 'pkg', 'docs', 'api.md'), '# API Reference');
      writeFileSync(join(dir, 'vendor', 'pkg', 'lib.rs'), 'pub fn hello() {}');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('api.md'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('lib.rs'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves README.md at repo root (sanity)', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Project Title');
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1;');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path === 'README.md')).toBe(true);
      expect(results.some((r) => r.path === 'index.ts')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves .rst and .adoc docs in third_party/', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'third_party', 'lib'), { recursive: true });
      writeFileSync(join(dir, 'third_party', 'lib', 'guide.rst'), 'Guide\n====');
      writeFileSync(join(dir, 'third_party', 'lib', 'manual.adoc'), '= Manual');
      writeFileSync(join(dir, 'third_party', 'lib', 'binary.so'), '\x7fELF');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('guide.rst'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('manual.adoc'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('binary.so'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── I-1 regression: filename whitelist must NOT match wrong extensions ──

  it('does NOT preserve README.bak inside vendor/ (wrong extension)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
      // README.bak — basename matches DOCUMENT_FILENAMES but .bak is not a doc extension
      writeFileSync(join(dir, 'vendor', 'lib', 'README.bak'), 'old readme backup');
      // README.md — should still be preserved via extension whitelist
      writeFileSync(join(dir, 'vendor', 'lib', 'README.md'), '# Current Docs');

      const results = await walkRepositoryPaths(dir);
      // README.bak falls through to vendor detection → skipped
      expect(results.some((r) => r.path.endsWith('README.bak'))).toBe(false);
      // README.md preserved via extension whitelist
      expect(results.some((r) => r.path.endsWith('README.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT preserve LICENSE.exe inside vendor/ (binary extension)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
      // LICENSE.exe — basename matches but .exe is a binary, not a document
      writeFileSync(
        join(dir, 'vendor', 'lib', 'LICENSE.exe'),
        Buffer.from([0x4d, 0x5a, 0x90, 0x00]), // MZ header (Windows executable)
      );
      // LICENSE (bare, no extension) — should be preserved
      writeFileSync(join(dir, 'vendor', 'lib', 'LICENSE'), 'MIT License');

      const results = await walkRepositoryPaths(dir);
      // LICENSE.exe falls through to vendor/binary detection → skipped
      expect(results.some((r) => r.path.endsWith('LICENSE.exe'))).toBe(false);
      // LICENSE (bare) preserved via filename whitelist
      expect(results.some((r) => r.path.endsWith('LICENSE'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves README (no extension) inside vendor/ (filename whitelist)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
      // README with no extension — filename whitelist applies (ext === '')
      writeFileSync(join(dir, 'vendor', 'lib', 'README'), '# Bare README');
      writeFileSync(join(dir, 'vendor', 'lib', 'lib.js'), 'export const x = 1;');

      const results = await walkRepositoryPaths(dir);
      expect(results.some((r) => r.path.endsWith('README'))).toBe(true);
      expect(results.some((r) => r.path.endsWith('lib.js'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
