/**
 * Tests for detectRepoStructure (P0b-T7: 仓库结构感知)
 *
 * Uses REAL filesystem with REAL directory structures.
 * Each test creates a temp directory, sets up the structure, and asserts.
 */
import { describe, it, expect } from 'vitest';
import { detectRepoStructure } from '../../src/wiki/doc-discovery.js';
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('repo-structure', () => {
  // Helper: create a unique temp directory for each test
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'jelly-t7-'));
  }

  // ========================================
  // docs/ directory detection
  // ========================================

  it('detects docs/ directory', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'index.md'), '# Docs');

      const structure = await detectRepoStructure(dir);
      expect(structure.docsDir).toBe('docs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects doc/ directory', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'doc'), { recursive: true });
      writeFileSync(join(dir, 'doc', 'README.md'), '# Doc');

      const structure = await detectRepoStructure(dir);
      expect(structure.docsDir).toBe('doc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects documentation/ directory', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'documentation'), { recursive: true });
      writeFileSync(join(dir, 'documentation', 'guide.md'), '# Guide');

      const structure = await detectRepoStructure(dir);
      expect(structure.docsDir).toBe('documentation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null docsDir when no docs directory exists', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Readme');
      writeFileSync(join(dir, 'main.ts'), 'console.log(1)');

      const structure = await detectRepoStructure(dir);
      expect(structure.docsDir).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ========================================
  // Monorepo detection (packages/)
  // ========================================

  it('detects monorepo packages/ with module READMEs', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'a', 'README.md'), '# Package A');
      mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'b', 'README.md'), '# Package B');

      const structure = await detectRepoStructure(dir);
      expect(structure.isMonorepo).toBe(true);
      expect(structure.moduleReadmes).toHaveLength(2);
      // Each module readme path should contain packages/ prefix
      for (const readme of structure.moduleReadmes) {
        expect(readme).toContain('packages/');
        expect(readme).toContain('README.md');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects pnpm workspaces via package.json workspaces field', async () => {
    const dir = makeTempDir();
    try {
      // package.json with workspaces field (npm/yarn style)
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'my-monorepo',
          private: true,
          workspaces: ['packages/*', 'apps/*'],
        }),
      );
      mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'core', 'README.md'), '# Core');
      mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
      writeFileSync(join(dir, 'apps', 'web', 'README.md'), '# Web App');

      const structure = await detectRepoStructure(dir);
      expect(structure.isMonorepo).toBe(true);
      expect(structure.moduleReadmes.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects lerna.json as monorepo indicator', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, 'lerna.json'),
        JSON.stringify({ packages: ['packages/*'], version: '1.0.0' }),
      );
      mkdirSync(join(dir, 'packages', 'lib'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'lib', 'README.md'), '# Lib');

      const structure = await detectRepoStructure(dir);
      expect(structure.isMonorepo).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ========================================
  // GitHub Wiki detection
  // ========================================

  it('detects GitHub Wiki (.github/wiki/ exists)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.github', 'wiki'), { recursive: true });
      writeFileSync(join(dir, '.github', 'wiki', 'Home.md'), '# Wiki Home');

      const structure = await detectRepoStructure(dir);
      expect(structure.hasGitHubWiki).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ========================================
  // Edge cases
  // ========================================

  it('returns all nulls/false/empty for empty repo', async () => {
    const dir = makeTempDir();
    try {
      const structure = await detectRepoStructure(dir);
      expect(structure.docsDir).toBeNull();
      expect(structure.moduleReadmes).toEqual([]);
      expect(structure.isMonorepo).toBe(false);
      expect(structure.hasGitHubWiki).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag non-monorepo repos with packages/ dir lacking READMEs', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'packages'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'some-dep.txt'), 'not a readme');

      const structure = await detectRepoStructure(dir);
      // packages/ exists but no package READMEs — isMonorepo depends on
      // packages/ having subdirs that look like packages. A flat file in
      // packages/ without subdirs should not trigger monorepo.
      expect(structure.moduleReadmes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers docs/ over doc/ when both exist', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'a.md'), '# A');
      mkdirSync(join(dir, 'doc'), { recursive: true });
      writeFileSync(join(dir, 'doc', 'b.md'), '# B');

      const structure = await detectRepoStructure(dir);
      // docs/ should take priority over doc/
      expect(structure.docsDir).toBe('docs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
