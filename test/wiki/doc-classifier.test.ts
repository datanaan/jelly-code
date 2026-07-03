/**
 * Unit Tests: Document classifier (P0b-T1)
 *
 * Tests classifyFile() across three detection layers:
 * 1. Extension layer (strong, confidence=1.0): .md, .rst, .adoc, .org, .markdown
 * 2. Path/filename layer (medium, confidence=0.9): README, CHANGELOG, LICENSE,
 *    CONTRIBUTING, AUTHORS, NEWS, TODO (bare) + docs/, doc/, documentation/ dirs
 * 3. Content heuristics (weak, confidence=0.7): .txt files with markdown markers
 *
 * Extension-only and path-only tests run synchronously-style (no I/O).
 * Content heuristics tests use real temp files (mkdtempSync + writeFileSync).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyFile,
  DOC_EXTENSIONS,
  type ClassificationResult,
} from '../../src/wiki/doc-classifier.js';

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
  const dir = mkdtempSync(join(tmpdir(), `doccls-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Helper: write a temp file and return its absolute path */
function writeTempFile(prefix: string, filename: string, content: string): string {
  const dir = makeTempDir(prefix);
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('doc-classifier', () => {
  describe('Layer 1: Extension detection (confidence=1.0, source=extension)', () => {
    it('classifies README.md as doc by .md extension', async () => {
      const result = await classifyFile('README.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies guide.rst as doc by .rst extension', async () => {
      const result = await classifyFile('docs/guide.rst');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies manual.adoc as doc by .adoc extension', async () => {
      const result = await classifyFile('manual.adoc');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies notes.org as doc by .org extension', async () => {
      const result = await classifyFile('notes.org');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies design.markdown as doc by .markdown extension', async () => {
      const result = await classifyFile('design.markdown');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies nested path src/pkg/README.md by extension', async () => {
      const result = await classifyFile('src/pkg/README.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('Layer 1: Non-doc extensions rejected', () => {
    it('rejects src/index.ts', async () => {
      const result = await classifyFile('src/index.ts');
      expect(result.isDoc).toBe(false);
    });

    it('rejects app.js', async () => {
      const result = await classifyFile('app.js');
      expect(result.isDoc).toBe(false);
    });

    it('rejects main.py', async () => {
      const result = await classifyFile('main.py');
      expect(result.isDoc).toBe(false);
    });

    it('rejects config.json', async () => {
      const result = await classifyFile('config.json');
      expect(result.isDoc).toBe(false);
    });

    it('rejects styles.css', async () => {
      const result = await classifyFile('styles.css');
      expect(result.isDoc).toBe(false);
    });
  });

  describe('Layer 2: Path/filename detection (confidence=0.9, source=path)', () => {
    it('classifies LICENSE (no ext) as doc by filename', async () => {
      const result = await classifyFile('LICENSE');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies CHANGELOG (no ext) as doc by filename', async () => {
      const result = await classifyFile('CHANGELOG');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies CONTRIBUTING (no ext) as doc by filename', async () => {
      const result = await classifyFile('CONTRIBUTING');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies AUTHORS (no ext) as doc by filename', async () => {
      const result = await classifyFile('AUTHORS');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies NEWS (no ext) as doc by filename', async () => {
      const result = await classifyFile('NEWS');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies TODO (no ext) as doc by filename', async () => {
      const result = await classifyFile('TODO');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies nested CHANGES file (no ext) by filename', async () => {
      const result = await classifyFile('packages/lib/CHANGES');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies file in docs/ directory by path', async () => {
      const result = await classifyFile('docs/architecture.txt');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies file in doc/ directory by path', async () => {
      const result = await classifyFile('doc/manual.txt');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies file in documentation/ directory by path', async () => {
      const result = await classifyFile('documentation/api-guide.txt');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });
  });

  describe('Layer 2: Extension wins over path/filename', () => {
    it('classifies README.md as extension (not path)', async () => {
      // README matches filename whitelist, but .md extension is stronger
      const result = await classifyFile('README.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies docs/guide.md as extension (not path)', async () => {
      // docs/ matches path dir, but .md extension wins
      const result = await classifyFile('docs/guide.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('Layer 3: Content heuristics (.txt with markdown markers)', () => {
    it('classifies .txt with markdown headings as doc (confidence=0.7)', async () => {
      const filePath = writeTempFile(
        'headings',
        'notes.txt',
        '# Project Title\n\n## Introduction\n\nSome content here.\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('content');
      expect(result.confidence).toBe(0.7);
    });

    it('classifies .txt with code block as doc (confidence=0.7)', async () => {
      const filePath = writeTempFile(
        'codeblock',
        'snippet.txt',
        'Here is some code:\n\n```\nconsole.log("hello");\n```\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('content');
      expect(result.confidence).toBe(0.7);
    });

    it('classifies .txt with bullet lists and heading as doc (confidence=0.7)', async () => {
      const filePath = writeTempFile(
        'lists',
        'checklist.txt',
        '# Checklist\n\nTasks:\n\n- Item one\n- Item two\n- Item three\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('content');
      expect(result.confidence).toBe(0.7);
    });

    it('classifies .txt with two weak markers (lists + blockquote) as doc', async () => {
      const filePath = writeTempFile(
        'weak',
        'mixed.txt',
        'Notes:\n\n- First point\n- Second point\n\n> Important quote\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('content');
      expect(result.confidence).toBe(0.7);
    });

    it('rejects .txt without markdown markers', async () => {
      const filePath = writeTempFile(
        'plain',
        'data.txt',
        'name=value\nfoo=bar\nbaz=qux\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(false);
    });

    it('rejects .txt with minimal content (no markers)', async () => {
      const filePath = writeTempFile(
        'minimal',
        'empty-ish.txt',
        'just some plain text without any markdown\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(false);
    });

    it('rejects .txt with only one weak marker (lone bullet list)', async () => {
      // A single bullet list is not strong enough — could be a plain
      // text checklist, config file, etc. Need 2+ weak markers or
      // 1 strong marker.
      const filePath = writeTempFile(
        'single-weak',
        'tasks.txt',
        'Tasks for today:\n- Buy milk\n- Walk dog\n',
      );
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(false);
    });
  });

  describe('Layer 3: UTF-8 BOM handling (I-1 regression)', () => {
    /** Helper: write a temp .txt file with UTF-8 BOM prefix */
    function writeBomFile(prefix: string, filename: string, body: string): string {
      const dir = mkdtempSync(join(tmpdir(), `doccls-${prefix}-`));
      tempDirs.push(dir);
      const filePath = join(dir, filename);
      // UTF-8 BOM is 0xEF 0xBB 0xBF — write as raw buffer to guarantee BOM prefix
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from(body, 'utf8');
      writeFileSync(filePath, Buffer.concat([bom, content]));
      return filePath;
    }

    it('classifies BOM-prefixed .txt with heading as doc (would fail without BOM strip)', async () => {
      // Without BOM stripping, /^#{1,6}\s/m would not match because the
      // first line becomes \uFEFF# Hello — the BOM sits between line
      // start and '#'.
      const filePath = writeBomFile('bom-heading', 'bom-heading.txt', '# Hello\n\nSome content.\n');
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('content');
      expect(result.confidence).toBe(0.7);
    });

    it('rejects BOM-prefixed .txt without markdown markers', async () => {
      // BOM alone doesn't make a file a doc — still need markdown markers
      const filePath = writeBomFile('bom-plain', 'bom-plain.txt', 'name=value\nfoo=bar\n');
      const result = await classifyFile(filePath);
      expect(result.isDoc).toBe(false);
    });
  });

  describe('Case-insensitive matching', () => {
    it('classifies readme.md (lowercase) by extension', async () => {
      const result = await classifyFile('readme.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies Readme.md (mixed case) by extension', async () => {
      const result = await classifyFile('Readme.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies README.MD (all caps) by extension', async () => {
      const result = await classifyFile('README.MD');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies license (lowercase, no ext) by filename', async () => {
      const result = await classifyFile('license');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });

    it('classifies Changelog (mixed case, no ext) by filename', async () => {
      const result = await classifyFile('Changelog');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('path');
      expect(result.confidence).toBe(0.9);
    });
  });

  describe('Edge cases', () => {
    it('rejects empty path', async () => {
      const result = await classifyFile('');
      expect(result.isDoc).toBe(false);
    });

    it('rejects path with only whitespace', async () => {
      const result = await classifyFile('   ');
      expect(result.isDoc).toBe(false);
    });

    it('classifies .md dotfile as doc', async () => {
      // .md is still a .md extension — dotfiles like .github.md would match
      const result = await classifyFile('.github.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
    });

    it('rejects .gitignore (config dotfile)', async () => {
      const result = await classifyFile('.gitignore');
      expect(result.isDoc).toBe(false);
    });

    it('rejects Makefile (no ext, not in filename whitelist)', async () => {
      const result = await classifyFile('Makefile');
      expect(result.isDoc).toBe(false);
    });

    it('handles deeply nested path', async () => {
      const result = await classifyFile('a/b/c/d/e/f/g.md');
      expect(result.isDoc).toBe(true);
      expect(result.source).toBe('extension');
      expect(result.confidence).toBe(1.0);
    });

    it('rejects .bak extension for README.bak', async () => {
      // README matches filename whitelist but has .bak extension.
      // .bak is not a doc extension, and extensionless check fails,
      // so this should NOT be classified as doc.
      const result = await classifyFile('README.bak');
      expect(result.isDoc).toBe(false);
    });
  });

  describe('Exported constants', () => {
    it('DOC_EXTENSIONS contains .md, .rst, .adoc, .org, .markdown', () => {
      expect(DOC_EXTENSIONS.has('.md')).toBe(true);
      expect(DOC_EXTENSIONS.has('.rst')).toBe(true);
      expect(DOC_EXTENSIONS.has('.adoc')).toBe(true);
      expect(DOC_EXTENSIONS.has('.org')).toBe(true);
      expect(DOC_EXTENSIONS.has('.markdown')).toBe(true);
    });

    it('DOC_EXTENSIONS does NOT contain .txt (txt uses content heuristics)', () => {
      // .txt is handled by the content layer, not the extension layer.
      // This is a deliberate design choice: .txt is ambiguous (could be
      // config, data, or markdown), so we peek at content.
      expect(DOC_EXTENSIONS.has('.txt')).toBe(false);
    });
  });
});
