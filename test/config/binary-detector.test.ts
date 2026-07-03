/**
 * Unit Tests: Binary file detector
 *
 * Tests isBinaryFile() across four detection layers:
 * 1. Extension check (fastest, no filesystem access)
 * 2. Magic bytes check (read first 8 bytes)
 * 3. NULL byte heuristic (>30% NULLs in first 8KB)
 * 4. UTF-8 decode check (if decode fails, likely binary)
 *
 * Extension-only tests are synchronous-style (await resolved immediately).
 * Magic bytes / UTF-8 / NULL heuristic tests use real temp files (mkdtempSync).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isBinaryFile, BINARY_EXTENSIONS } from '../../src/config/binary-detector.js';

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
  const dir = mkdtempSync(join(tmpdir(), `binary-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Helper: write a file in a temp dir and return its full path */
function writeTempFile(prefix: string, filename: string, content: string | Buffer): string {
  const dir = makeTempDir(prefix);
  const filePath = join(dir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

describe('binary-detector', () => {
  describe('Layer 1: Extension detection (no I/O)', () => {
    it('detects .so files by extension', async () => {
      expect(await isBinaryFile('libfoo.so')).toBe(true);
    });

    it('detects .dll files by extension', async () => {
      expect(await isBinaryFile('mylib.dll')).toBe(true);
    });

    it('detects .exe files by extension', async () => {
      expect(await isBinaryFile('program.exe')).toBe(true);
    });

    it('detects .o object files by extension', async () => {
      expect(await isBinaryFile('main.o')).toBe(true);
    });

    it('detects .class files by extension', async () => {
      expect(await isBinaryFile('HelloWorld.class')).toBe(true);
    });

    it('detects .pyc files by extension', async () => {
      expect(await isBinaryFile('module.pyc')).toBe(true);
    });

    it('detects .dat files by extension', async () => {
      expect(await isBinaryFile('data.dat')).toBe(true);
    });

    it('detects .bin files by extension', async () => {
      expect(await isBinaryFile('firmware.bin')).toBe(true);
    });

    it('detects .jar files by extension', async () => {
      expect(await isBinaryFile('app.jar')).toBe(true);
    });

    it('detects .woff2 font files by extension', async () => {
      expect(await isBinaryFile('icons.woff2')).toBe(true);
    });
  });

  describe('Layer 1: Non-binary extensions', () => {
    it('does not flag .ts files', async () => {
      expect(await isBinaryFile('index.ts')).toBe(false);
    });

    it('does not flag .js files', async () => {
      expect(await isBinaryFile('app.js')).toBe(false);
    });

    it('does not flag .md files', async () => {
      expect(await isBinaryFile('README.md')).toBe(false);
    });

    it('does not flag .json files', async () => {
      expect(await isBinaryFile('package.json')).toBe(false);
    });

    it('does not flag .txt files', async () => {
      expect(await isBinaryFile('notes.txt')).toBe(false);
    });

    it('does not flag .py files', async () => {
      expect(await isBinaryFile('main.py')).toBe(false);
    });

    it('does not flag extensionless files with text content', async () => {
      const filePath = writeTempFile('extless', 'Makefile', 'all: build\n\tgo build ./...\n');
      expect(await isBinaryFile(filePath)).toBe(false);
    });
  });

  describe('Layer 2: Magic bytes detection', () => {
    it('detects ELF by magic bytes (7f 45 4c 46)', async () => {
      const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('elf', 'test.elf', elfHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects PE/Windows exe by magic bytes (4d 5a / MZ)', async () => {
      const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('pe', 'test.mz', peHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects Mach-O 32-bit little-endian by magic bytes (ce fa ed fe)', async () => {
      const machoHeader = Buffer.from([0xce, 0xfa, 0xed, 0xfe, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('macho32le', 'test.macho32le', machoHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects Mach-O 64-bit little-endian by magic bytes (cf fa ed fe)', async () => {
      const machoHeader = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('macho64le', 'test.macho64le', machoHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects Mach-O 32-bit big-endian by magic bytes (fe ed fa ce)', async () => {
      const machoHeader = Buffer.from([0xfe, 0xed, 0xfa, 0xce, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('macho32be', 'test.macho32be', machoHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects Mach-O 64-bit big-endian by magic bytes (fe ed fa cf)', async () => {
      const machoHeader = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('macho64be', 'test.macho64be', machoHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects Java class by magic bytes (ca fe ba be)', async () => {
      const classHeader = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('javaclass', 'test.javaclass', classHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('detects ZIP/JAR by magic bytes (50 4b 03 04)', async () => {
      const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, ...Buffer.alloc(100, 0x00)]);
      const filePath = writeTempFile('zip', 'test.ziplike', zipHeader);
      expect(await isBinaryFile(filePath)).toBe(true);
    });
  });

  describe('Layer 3: NULL byte heuristic', () => {
    it('detects file with >30% NULL bytes as binary', async () => {
      // Create content that is 50% NULL bytes — clearly binary
      const content = Buffer.alloc(1024, 0x00);
      for (let i = 0; i < 1024; i += 2) {
        content[i] = 0x41; // 'A' on even bytes
      }
      // 50% are NULL (odd bytes), 50% are 'A' (even bytes)
      const filePath = writeTempFile('nullheavy', 'data.unknown', content);
      expect(await isBinaryFile(filePath)).toBe(true);
    });

    it('does not flag file with no NULL bytes as binary', async () => {
      const content = 'Hello World! '.repeat(80);
      const filePath = writeTempFile('nopnulls', 'text.unknown', content);
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('boundary: 29% NULL bytes is NOT binary (below threshold)', async () => {
      // 1000-byte buffer: 290 NULLs (29%) — below the 30% threshold
      const size = 1000;
      const content = Buffer.alloc(size, 0x41); // fill with 'A'
      for (let i = 0; i < 290; i++) {
        content[i] = 0x00; // first 290 bytes are NULL = 29%
      }
      const filePath = writeTempFile('null29', 'data29.unknown', content);
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('boundary: exactly 30% NULL bytes is NOT binary (strict >)', async () => {
      // 1000-byte buffer: 300 NULLs (exactly 30%) — strict > means this is NOT binary
      const size = 1000;
      const content = Buffer.alloc(size, 0x41); // fill with 'A'
      for (let i = 0; i < 300; i++) {
        content[i] = 0x00; // first 300 bytes are NULL = exactly 30%
      }
      const filePath = writeTempFile('null30', 'data30.unknown', content);
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('boundary: 31% NULL bytes IS binary (above threshold)', async () => {
      // 1000-byte buffer: 310 NULLs (31%) — above the 30% threshold
      const size = 1000;
      const content = Buffer.alloc(size, 0x41); // fill with 'A'
      for (let i = 0; i < 310; i++) {
        content[i] = 0x00; // first 310 bytes are NULL = 31%
      }
      const filePath = writeTempFile('null31', 'data31.unknown', content);
      expect(await isBinaryFile(filePath)).toBe(true);
    });
  });

  describe('Layer 4: UTF-8 content check', () => {
    it('does not misclassify UTF-8 with emoji', async () => {
      const filePath = writeTempFile('emoji', 'emoji.md', '# Hello World\n\nEmoji: \uD83D\uDE0A \uD83C\uDF89\n');
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('does not misclassify UTF-8 with Chinese characters', async () => {
      const filePath = writeTempFile('chinese', 'chinese.md', '# \u4F60\u597D\u4E16\u754C\n\n\u8FD9\u662F\u4E2D\u6587\u6D4B\u8BD5\u3002\n');
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('does not misclassify UTF-8 with mixed scripts', async () => {
      const content = 'Mixed: Hello \u3053\u3093\u306B\u3061\u306F \u4F60\u597D \u0928\u092E\u0938\u094D\u0924\u0947 \uD83C\uDF0D\n';
      const filePath = writeTempFile('mixed', 'mixed.unknown', content);
      expect(await isBinaryFile(filePath)).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('handles empty file as non-binary', async () => {
      const filePath = writeTempFile('empty', 'empty.unknown', '');
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('handles non-existent file gracefully (returns false)', async () => {
      // Non-existent file should return false, not throw.
      // This allows the walker to skip without crashing.
      expect(await isBinaryFile('/nonexistent/path/file.unknown')).toBe(false);
    });

    it('handles file with only a few bytes', async () => {
      const filePath = writeTempFile('tiny', 'tiny.unknown', 'AB');
      expect(await isBinaryFile(filePath)).toBe(false);
    });

    it('extension check is case-insensitive', async () => {
      expect(await isBinaryFile('LIBFOO.SO')).toBe(true);
      expect(await isBinaryFile('MyApp.DLL')).toBe(true);
      expect(await isBinaryFile('Test.EXE')).toBe(true);
    });
  });

  describe('BINARY_EXTENSIONS export', () => {
    it('exports a readonly array of known binary extensions', () => {
      expect(BINARY_EXTENSIONS).toBeDefined();
      expect(Array.isArray(BINARY_EXTENSIONS)).toBe(true);
      expect(BINARY_EXTENSIONS.length).toBeGreaterThan(10);
    });

    it('includes common binary extensions', () => {
      expect(BINARY_EXTENSIONS).toContain('.so');
      expect(BINARY_EXTENSIONS).toContain('.dll');
      expect(BINARY_EXTENSIONS).toContain('.exe');
      expect(BINARY_EXTENSIONS).toContain('.class');
      expect(BINARY_EXTENSIONS).toContain('.pyc');
    });
  });
});
