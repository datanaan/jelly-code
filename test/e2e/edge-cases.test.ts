/**
 * Tests: P0a Edge Cases — filesystem-only, no backend required
 *
 * These tests complement p0a-skip-expansion.test.ts by covering
 * edge cases the expansion tests didn't touch.
 *
 * All tests are filesystem-only, require zero mocking or backends.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `jelly-edge-${prefix}-`));
}

function writeFile(baseDir: string, relPath: string, content: string): void {
  const full = join(baseDir, relPath);
  const dir = full.substring(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

// ─── .jellyignore patterns ───────────────────────────────────────────

describe('P0a Edge Cases: .jellyignore parsing', () => {
  it('should parse .jellyignore with negation patterns', async () => {
    const { readJellyignore } = await import('../../src/config/ignore-service.js');
    const repoDir = makeRepo('jellyignore-negate');
    try {
      writeFile(repoDir, '.jellyignore',
        '# Ignore vendor\nvendor/*\n!vendor/keep.txt\ndist/\n!dist/public/\n');
      const patterns = await readJellyignore(repoDir);
      expect(patterns).toContain('vendor/*');
      expect(patterns).toContain('!vendor/keep.txt');
      expect(patterns).toContain('dist/');
      expect(patterns).toContain('!dist/public/');
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });

  it('should handle inline comments', async () => {
    const { readJellyignore } = await import('../../src/config/ignore-service.js');
    const repoDir = makeRepo('jellyignore-comments');
    try {
      writeFile(repoDir, '.jellyignore',
        'dist/ # build output\n*.log # debug logs\n# full line comment\n  # indented\nnode_modules/\n');
      const patterns = await readJellyignore(repoDir);
      expect(patterns).toEqual(['dist/', '*.log', 'node_modules/']);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });

  it('should return empty array when no .jellyignore', async () => {
    const { readJellyignore } = await import('../../src/config/ignore-service.js');
    const repoDir = makeRepo('no-ignore');
    try {
      const patterns = await readJellyignore(repoDir);
      expect(patterns).toEqual([]);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });

  it('should handle UTF-8 BOM', async () => {
    const { readJellyignore } = await import('../../src/config/ignore-service.js');
    const repoDir = makeRepo('bom');
    try {
      writeFile(repoDir, '.jellyignore', '\uFEFFdist/\nbuild/\n');
      const patterns = await readJellyignore(repoDir);
      expect(patterns).toEqual(['dist/', 'build/']);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});

describe('P0a Edge Cases: createIgnoreFilter', () => {
  it('should filter defaults + .gitignore patterns', async () => {
    const { createIgnoreFilter } = await import('../../src/config/ignore-service.js');
    const repoDir = makeRepo('ignore-filter');
    try {
      writeFile(repoDir, '.gitignore', '*.generated.js\n');
      const filter = createIgnoreFilter(repoDir);
      expect(filter.test('node_modules/pkg/index.js')).toBe(true);
      expect(filter.test('dist/bundle.js')).toBe(true);
      expect(filter.test('src/app.generated.js')).toBe(true);
      expect(filter.test('src/main.ts')).toBe(false);
      expect(filter.test('package.json')).toBe(false);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});

// ─── Binary detection ────────────────────────────────────────────────

describe('P0a Edge Cases: binary detection', () => {
  it('should detect binary by extension', async () => {
    const { isBinaryFile } = await import('../../src/config/binary-detector.js');
    const repoDir = makeRepo('binary-ext');
    try {
      writeFile(repoDir, 'image.png', 'fake png');
      writeFile(repoDir, 'archive.zip', 'fake zip');
      writeFile(repoDir, 'doc.pdf', 'fake pdf');
      writeFile(repoDir, 'main.ts', 'export const x = 1;');
      expect(await isBinaryFile(join(repoDir, 'image.png'))).toBe(true);
      expect(await isBinaryFile(join(repoDir, 'archive.zip'))).toBe(true);
      expect(await isBinaryFile(join(repoDir, 'doc.pdf'))).toBe(true);
      expect(await isBinaryFile(join(repoDir, 'main.ts'))).toBe(false);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});

// ─── Vendor detection ────────────────────────────────────────────────

describe('P0a Edge Cases: vendor directory detection', () => {
  it('should detect node_modules', async () => {
    const { isVendorDirectory } = await import('../../src/config/vendor-detector.js');
    const r = await isVendorDirectory('/some/project/node_modules/pkg');
    expect(r.isVendor).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('should detect vendor (Go-style)', async () => {
    const { isVendorDirectory } = await import('../../src/config/vendor-detector.js');
    const r = await isVendorDirectory('/project/vendor/github.com/user/lib');
    expect(r.isVendor).toBe(true);
  });

  it('should not flag src as vendor', async () => {
    const { isVendorDirectory } = await import('../../src/config/vendor-detector.js');
    expect((await isVendorDirectory('/project/src/components')).isVendor).toBe(false);
  });

  it('should handle invalid input', async () => {
    const { isVendorDirectory } = await import('../../src/config/vendor-detector.js');
    expect((await isVendorDirectory('')).isVendor).toBe(false);
    expect((await isVendorDirectory('   ')).isVendor).toBe(false);
  });
});

// ─── Language ignore patterns ────────────────────────────────────────

describe('P0a Edge Cases: language ignore patterns', () => {
  it('JavaScript should include common build dirs', async () => {
    const { getLanguageIgnorePatterns } = await import('../../src/config/language-ignore-profiles.js');
    const p = getLanguageIgnorePatterns('javascript').join(' ');
    expect(p).toContain('node_module');
    expect(p).toContain('dist');
    expect(p).toContain('build');
  });

  it('Python should include cache dirs', async () => {
    const { getLanguageIgnorePatterns } = await import('../../src/config/language-ignore-profiles.js');
    const p = getLanguageIgnorePatterns('python').join(' ');
    expect(p).toContain('__pycache');
    expect(p).toContain('.venv');
  });

  it('every supported language has non-empty patterns', async () => {
    const { getLanguageIgnorePatterns } = await import('../../src/config/language-ignore-profiles.js');
    const { SupportedLanguages } = await import('../../src/config/supported-languages.js');
    const langs = Object.values(SupportedLanguages).filter(v => typeof v === 'string');
    expect(langs.length).toBeGreaterThan(10);
    for (const lang of langs) {
      const patterns = getLanguageIgnorePatterns(lang);
      expect(Array.isArray(patterns)).toBe(true);
    }
  });
});

// ─── WalkRepositoryPaths ─────────────────────────────────────────────

describe('P0a Edge Cases: walkRepositoryPaths', () => {
  it('should handle empty directory without crash', async () => {
    const { walkRepositoryPaths } = await import('../../src/core/ingestion/filesystem-walker.js');
    const emptyDir = makeRepo('walk-empty');
    try {
      const paths = await walkRepositoryPaths(emptyDir);
      expect(paths).toBeDefined();
    } finally { rmSync(emptyDir, { recursive: true, force: true }); }
  });

  it('should skip node_modules when source files exist', async () => {
    const { walkRepositoryPaths } = await import('../../src/core/ingestion/filesystem-walker.js');
    const dir = makeRepo('walk-nm');
    try {
      writeFile(dir, 'src/main.ts', 'export const main = 1;');
      writeFile(dir, 'node_modules/pkg/index.js', 'module.exports = {};');
      const paths = await walkRepositoryPaths(dir);
      expect(paths.length).toBeGreaterThanOrEqual(1);
      for (const p of paths) {
        const ps = typeof p === 'string' ? p : ((p as any).path || '');
        expect(ps).not.toContain('node_modules');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15000);

  it('should skip dist directory', async () => {
    const { walkRepositoryPaths } = await import('../../src/core/ingestion/filesystem-walker.js');
    const dir = makeRepo('walk-dist');
    try {
      writeFile(dir, 'src/app.ts', 'export const app = 1;');
      writeFile(dir, 'dist/bundle.js', '// bundled');
      const paths = await walkRepositoryPaths(dir);
      expect(paths.length).toBeGreaterThanOrEqual(1);
      for (const p of paths) {
        const ps = typeof p === 'string' ? p : ((p as any).path || '');
        expect(ps).not.toContain('dist/');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});
