/**
 * Unit Tests: .jellyignore file parser
 *
 * Tests readJellyignore() — reads .jellyignore from repo root, parses
 * line-by-line, returns array of glob patterns.
 *
 * Edge cases covered:
 * - Comments (# prefix, ##, inline)
 * - Empty lines and whitespace-only lines
 * - Trailing whitespace stripped
 * - BOM (byte order mark) handling
 * - CRLF (Windows) line endings
 * - Patterns with spaces (e.g. "My Folder/")
 * - Missing .jellyignore returns []
 * - Trailing newline at EOF
 *
 * All tests use real filesystem I/O (mkdtempSync + writeFileSync).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJellyignore } from '../../src/config/ignore-service.js';

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Helper: create a temp directory and register for cleanup */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jellyignore-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('readJellyignore', () => {
  it('parses basic patterns from .jellyignore', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), 'vendor/\n*.dat\nbuild/');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.dat');
    expect(patterns).toContain('build/');
    expect(patterns).toHaveLength(3);
  });

  it('skips full-line comments (# prefix)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), '# comment\nvendor/\n## double-hash\n*.log');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.log');
    expect(patterns).not.toContain('# comment');
    expect(patterns).not.toContain('## double-hash');
    expect(patterns).toHaveLength(2);
  });

  it('skips empty lines and whitespace-only lines', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), '\nvendor/\n   \n\t\n*.tmp\n\n');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.tmp');
    expect(patterns).not.toContain('');
    expect(patterns).not.toContain('   ');
    expect(patterns).toHaveLength(2);
  });

  it('strips trailing whitespace from patterns', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), 'vendor/   \n*.dat\t\nbuild/  \t  ');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.dat');
    expect(patterns).toContain('build/');
    // Ensure no trailing whitespace in any pattern
    for (const p of patterns) {
      expect(p).toBe(p.trimEnd());
    }
  });

  it('strips leading whitespace (space-indented patterns)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), '  vendor/\n  *.log');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.log');
    expect(patterns).toHaveLength(2);
    // Ensure no leading whitespace in any pattern
    for (const p of patterns) {
      expect(p).toBe(p.trimStart());
    }
  });

  it('strips leading whitespace (tab-indented patterns)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), '\tvendor/\n\t*.log');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.log');
    expect(patterns).toHaveLength(2);
    // Ensure no leading whitespace in any pattern
    for (const p of patterns) {
      expect(p).toBe(p.trimStart());
    }
  });

  it('returns empty array when no .jellyignore exists', async () => {
    const dir = makeTempDir();

    const patterns = await readJellyignore(dir);

    expect(patterns).toEqual([]);
  });

  it('handles trailing newline at end of file', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), 'vendor/\n*.dat\n\n');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.dat');
    expect(patterns).toHaveLength(2);
    expect(patterns).not.toContain('');
  });

  it('handles CRLF (Windows) line endings', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), 'vendor/\r\n*.dat\r\nbuild/\r\n');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.dat');
    expect(patterns).toContain('build/');
    expect(patterns).toHaveLength(3);
    // Ensure no \r in any pattern
    for (const p of patterns) {
      expect(p).not.toContain('\r');
    }
  });

  it('handles UTF-8 BOM at start of file', async () => {
    const dir = makeTempDir();
    const bom = '\uFEFF';
    writeFileSync(join(dir, '.jellyignore'), bom + 'vendor/\n*.dat');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.dat');
    expect(patterns).toHaveLength(2);
    // First pattern must not start with BOM
    expect(patterns[0]).not.toMatch(/^\uFEFF/);
  });

  it('handles patterns with spaces (e.g. "My Folder/")', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), 'My Folder/\ndist cache/');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('My Folder/');
    expect(patterns).toContain('dist cache/');
    expect(patterns).toHaveLength(2);
  });

  it('handles inline comments (e.g. "vendor/ # deps")', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), 'vendor/ # deps\n*.dat # binary');

    const patterns = await readJellyignore(dir);

    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.dat');
    expect(patterns).toHaveLength(2);
    // No pattern should contain the comment part
    for (const p of patterns) {
      expect(p).not.toContain('#');
    }
  });

  it('handles empty .jellyignore file', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), '');

    const patterns = await readJellyignore(dir);

    expect(patterns).toEqual([]);
  });

  it('handles .jellyignore with only comments and whitespace', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.jellyignore'), '# only comments\n\n   \n# more\n');

    const patterns = await readJellyignore(dir);

    expect(patterns).toEqual([]);
  });
});
