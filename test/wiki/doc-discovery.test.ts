/**
 * Unit Tests: Document discoverer (P0b-T2)
 *
 * Tests discoverDocs() which walks a repository using P0a's
 * walkRepositoryPaths() and filters the result through T1's
 * classifyFile() to return only documents.
 *
 * Integration chain: discoverDocs → walkRepositoryPaths → classifyFile
 *
 * Tests cover:
 * - Basic .md discovery (flat + nested)
 * - Source file exclusion (.ts, .js, .py)
 * - P0a-T6 whitelist preservation (docs inside vendor/)
 * - Multiple doc extensions (.rst, .adoc, .org, .markdown)
 * - Bare filenames (README, CHANGELOG, LICENSE — no extension)
 * - .txt with markdown content (Layer 3 content heuristics)
 * - .txt without markdown content (excluded)
 * - Relative path output (not absolute)
 * - Classification info in result
 * - Empty repo (no docs)
 * - Mixed repo (docs + source + config)
 * - Deeply nested docs
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverDocs, type DiscoveredDoc } from '../../src/wiki/doc-discovery.js';

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
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `docdisc-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

describe('doc-discovery', () => {
  // ── Basic discovery ──────────────────────────────────────────────────

  it('discovers all .md files in repo (flat + nested)', async () => {
    const dir = makeTempDir('basic');
    writeFileSync(join(dir, 'README.md'), '# Hello');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');

    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'README.md')).toBe(true);
    expect(docs.some((d) => d.path === 'docs/guide.md')).toBe(true);
  });

  it('excludes source files (.ts, .js)', async () => {
    const dir = makeTempDir('exclude-src');
    writeFileSync(join(dir, 'README.md'), '# Hello');
    writeFileSync(join(dir, 'app.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'main.js'), 'console.log(1);');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const y = 2;');
    writeFileSync(join(dir, 'src', 'utils.js'), 'export const z = 3;');

    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'README.md')).toBe(true);
    expect(docs.some((d) => d.path.endsWith('.ts'))).toBe(false);
    expect(docs.some((d) => d.path.endsWith('.js'))).toBe(false);
  });

  // ── P0a-T6 whitelist preservation ──────────────────────────────────

  it('discovers README inside vendor/ (P0a-T6 whitelist preserved)', async () => {
    const dir = makeTempDir('vendor-doc');
    mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'lib', 'README.md'), '# Lib Docs');
    writeFileSync(join(dir, 'vendor', 'lib', 'main.js'), 'export const x = 1;');

    const docs = await discoverDocs(dir);

    // README.md inside vendor/ should be preserved by P0a-T6 whitelist
    expect(docs.some((d) => d.path.endsWith('README.md'))).toBe(true);
    // main.js inside vendor/ should be skipped (vendor + not a doc)
    expect(docs.some((d) => d.path.endsWith('main.js'))).toBe(false);
  });

  // ── Multiple doc extensions ─────────────────────────────────────────

  it('discovers .rst, .adoc, .org, .markdown files', async () => {
    const dir = makeTempDir('multi-ext');
    writeFileSync(join(dir, 'guide.rst'), 'Title\n=====\n\nBody.');
    writeFileSync(join(dir, 'manual.adoc'), '= Manual\n\nContent.');
    writeFileSync(join(dir, 'notes.org'), '* Notes\n** Sub');
    writeFileSync(join(dir, 'design.markdown'), '# Design Doc');
    writeFileSync(join(dir, 'app.py'), 'print("hello")');

    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'guide.rst')).toBe(true);
    expect(docs.some((d) => d.path === 'manual.adoc')).toBe(true);
    expect(docs.some((d) => d.path === 'notes.org')).toBe(true);
    expect(docs.some((d) => d.path === 'design.markdown')).toBe(true);
    expect(docs.some((d) => d.path === 'app.py')).toBe(false);
  });

  // ── Bare filenames (no extension) ──────────────────────────────────

  it('discovers bare README, CHANGELOG, LICENSE (no extension)', async () => {
    const dir = makeTempDir('bare');
    writeFileSync(join(dir, 'README'), '# Project Readme');
    writeFileSync(join(dir, 'CHANGELOG'), 'v1.0.0 - initial');
    writeFileSync(join(dir, 'LICENSE'), 'MIT License');
    writeFileSync(join(dir, 'Makefile'), 'all: build');

    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'README')).toBe(true);
    expect(docs.some((d) => d.path === 'CHANGELOG')).toBe(true);
    expect(docs.some((d) => d.path === 'LICENSE')).toBe(true);
    // Makefile is not a recognized doc filename
    expect(docs.some((d) => d.path === 'Makefile')).toBe(false);
  });

  // ── Layer 3: .txt content heuristics ───────────────────────────────

  it('discovers .txt with markdown content (Layer 3)', async () => {
    const dir = makeTempDir('txt-md');
    writeFileSync(
      join(dir, 'notes.txt'),
      '# Project Notes\n\n## Section\n\nSome content with ```code```.\n',
    );

    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'notes.txt')).toBe(true);
  });

  it('excludes .txt without markdown content', async () => {
    const dir = makeTempDir('txt-plain');
    writeFileSync(join(dir, 'config.txt'), 'name=value\nfoo=bar\n');
    writeFileSync(join(dir, 'data.txt'), '123\n456\n789\n');

    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'config.txt')).toBe(false);
    expect(docs.some((d) => d.path === 'data.txt')).toBe(false);
  });

  // ── Relative path output ───────────────────────────────────────────

  it('returns relative paths (not absolute)', async () => {
    const dir = makeTempDir('relpath');
    writeFileSync(join(dir, 'README.md'), '# Hello');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide');

    const docs = await discoverDocs(dir);

    for (const doc of docs) {
      // Paths should be relative (not starting with /)
      expect(doc.path.startsWith('/')).toBe(false);
      // Paths should not contain the temp dir prefix
      expect(doc.path).not.toContain(tmpdir());
    }
  });

  // ── Classification info ─────────────────────────────────────────────

  it('returns classification info per doc', async () => {
    const dir = makeTempDir('classify');
    writeFileSync(join(dir, 'README.md'), '# Hello');
    writeFileSync(join(dir, 'guide.rst'), 'Title\n====\n');

    const docs = await discoverDocs(dir);

    // Each doc should have a classification object with required fields
    for (const doc of docs) {
      expect(doc.classification).toBeDefined();
      expect(doc.classification.isDoc).toBe(true);
      expect(typeof doc.classification.confidence).toBe('number');
      expect(doc.classification.confidence).toBeGreaterThan(0);
      expect(doc.classification.source).toBeDefined();
    }

    // .md should be classified by extension (confidence=1.0)
    const mdDoc = docs.find((d) => d.path === 'README.md');
    expect(mdDoc).toBeDefined();
    expect(mdDoc!.classification.source).toBe('extension');
    expect(mdDoc!.classification.confidence).toBe(1.0);

    // .rst should also be classified by extension
    const rstDoc = docs.find((d) => d.path === 'guide.rst');
    expect(rstDoc).toBeDefined();
    expect(rstDoc!.classification.source).toBe('extension');
    expect(rstDoc!.classification.confidence).toBe(1.0);
  });

  // ── Empty repo ──────────────────────────────────────────────────────

  it('handles empty repo (no docs)', async () => {
    const dir = makeTempDir('empty');
    // No files at all
    const docs = await discoverDocs(dir);
    expect(docs).toEqual([]);
  });

  it('handles repo with only source files (no docs)', async () => {
    const dir = makeTempDir('no-docs');
    writeFileSync(join(dir, 'main.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'config.json'), '{"key":"value"}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.py'), 'print("hello")');

    const docs = await discoverDocs(dir);
    expect(docs).toEqual([]);
  });

  // ── Mixed repo ──────────────────────────────────────────────────────

  it('discovers docs in mixed repo (docs + source + config)', async () => {
    const dir = makeTempDir('mixed');
    writeFileSync(join(dir, 'README.md'), '# Project');
    writeFileSync(join(dir, 'package.json'), '{"name":"test"}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {}');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'api.md'), '# API');
    writeFileSync(join(dir, 'docs', 'guide.rst'), 'Guide\n====');
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'test.ts'), 'it("works", () => {})');
    writeFileSync(join(dir, 'LICENSE'), 'MIT');

    const docs = await discoverDocs(dir);
    const paths = docs.map((d) => d.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('docs/api.md');
    expect(paths).toContain('docs/guide.rst');
    expect(paths).toContain('LICENSE');
    expect(paths).not.toContain('package.json');
    expect(paths).not.toContain('src/index.ts');
    expect(paths).not.toContain('tests/test.ts');
  });

  // ── Deeply nested docs ──────────────────────────────────────────────

  it('discovers deeply nested documentation files', async () => {
    const dir = makeTempDir('deep');
    mkdirSync(join(dir, 'packages', 'core', 'docs', 'api'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'core', 'docs', 'api', 'reference.md'),
      '# API Reference',
    );
    mkdirSync(join(dir, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'e', 'deep.md'), '# Deep');

    const docs = await discoverDocs(dir);

    expect(
      docs.some((d) => d.path === 'packages/core/docs/api/reference.md'),
    ).toBe(true);
    expect(docs.some((d) => d.path === 'a/b/c/d/e/deep.md')).toBe(true);
  });

  // ── CONTRIBUTING + AUTHORS ──────────────────────────────────────────

  it('discovers CONTRIBUTING and AUTHORS files (bare)', async () => {
    const dir = makeTempDir('contrib');
    writeFileSync(join(dir, 'CONTRIBUTING'), '# Contrib Guide');
    writeFileSync(join(dir, 'AUTHORS'), 'John Doe\nJane Smith');
    writeFileSync(join(dir, 'NEWS'), 'v2.0 released');
    writeFileSync(join(dir, 'TODO'), '- Fix bugs');

    const docs = await discoverDocs(dir);
    const paths = docs.map((d) => d.path);

    expect(paths).toContain('CONTRIBUTING');
    expect(paths).toContain('AUTHORS');
    expect(paths).toContain('NEWS');
    expect(paths).toContain('TODO');
  });

  // ── Incremental discovery (since filter) ────────────────────────────

  it('only returns new docs when since is set', async () => {
    const dir = makeTempDir('incr-since');

    // Create an "old" doc and set its mtime to the past (1 hour ago)
    writeFileSync(join(dir, 'README.md'), '# Hello');
    const oneHourAgo = Math.floor((Date.now() - 3600_000) / 1000);
    utimesSync(join(dir, 'README.md'), oneHourAgo, oneHourAgo);

    // Wait a moment to ensure "now" is strictly after the old file's mtime
    const sinceTimestamp = Date.now();

    // Give a small buffer so the new file's mtime is strictly > sinceTimestamp
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Create a "new" doc after the since cutoff
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'new.md'), '# New');

    const docs = await discoverDocs(dir, { since: sinceTimestamp });

    expect(docs.some((d) => d.path === 'docs/new.md')).toBe(true);
    expect(docs.some((d) => d.path === 'README.md')).toBe(false); // old, excluded
  });

  it('returns all docs when since is not provided (backward compat)', async () => {
    const dir = makeTempDir('incr-noparam');

    // Create two docs with old mtimes
    writeFileSync(join(dir, 'old.md'), '# Old');
    writeFileSync(join(dir, 'newer.md'), '# Newer');
    const oneHourAgo = Math.floor((Date.now() - 3600_000) / 1000);
    utimesSync(join(dir, 'old.md'), oneHourAgo, oneHourAgo);
    utimesSync(join(dir, 'newer.md'), oneHourAgo, oneHourAgo);

    // No options → should return all docs regardless of mtime
    const docs = await discoverDocs(dir);

    expect(docs.some((d) => d.path === 'old.md')).toBe(true);
    expect(docs.some((d) => d.path === 'newer.md')).toBe(true);
  });

  it('returns all docs when since is 0 (treats 0 as no filter)', async () => {
    const dir = makeTempDir('incr-zero');

    // Create docs with old mtime
    writeFileSync(join(dir, 'guide.md'), '# Guide');
    const oneHourAgo = Math.floor((Date.now() - 3600_000) / 1000);
    utimesSync(join(dir, 'guide.md'), oneHourAgo, oneHourAgo);

    // since=0 → should return all docs
    const docs = await discoverDocs(dir, { since: 0 });

    expect(docs.some((d) => d.path === 'guide.md')).toBe(true);
  });

  it('includes files modified exactly at the since boundary (>=)', async () => {
    const dir = makeTempDir('incr-boundary');

    // Create a doc and set its mtime to exactly a known value
    writeFileSync(join(dir, 'exact.md'), '# Exact');
    const fixedTime = Math.floor(Date.now() / 1000);
    utimesSync(join(dir, 'exact.md'), fixedTime, fixedTime);

    // The mtimeMs should be >= fixedTime * 1000 (exact match)
    const sinceMs = fixedTime * 1000;

    const docs = await discoverDocs(dir, { since: sinceMs });

    // File at exactly the boundary should be included (>= semantics)
    expect(docs.some((d) => d.path === 'exact.md')).toBe(true);
  });

  it('returns empty array when no docs are modified since the cutoff', async () => {
    const dir = makeTempDir('incr-empty');

    // Create docs with old mtimes (1 day ago)
    writeFileSync(join(dir, 'stale.md'), '# Stale');
    writeFileSync(join(dir, 'old.rst'), 'Old\n===\n');
    const oneDayAgo = Math.floor((Date.now() - 86400_000) / 1000);
    utimesSync(join(dir, 'stale.md'), oneDayAgo, oneDayAgo);
    utimesSync(join(dir, 'old.rst'), oneDayAgo, oneDayAgo);

    // since = now → nothing should match
    const docs = await discoverDocs(dir, { since: Date.now() });

    expect(docs).toEqual([]);
  });
});
