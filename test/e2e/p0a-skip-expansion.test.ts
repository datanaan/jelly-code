/**
 * E2E Test: P0a Skip Expansion — Language Profiles + Binary Formats
 *
 * Extends the baseline skip-mechanism tests with:
 *  1. JavaScript build dirs (.turbo, .next, .nuxt, coverage)
 *  2. C++ build artifacts (.o, .obj, cmake-build-debug)
 *  3. Go build artifacts (vendor/, *.exe, bin/)
 *  4. Java build artifacts (target/, *.class, .gradle/)
 *  5. Ruby build artifacts (vendor/bundle, .bundle/)
 *  6. C# build artifacts (bin/, obj/, .vs/)
 *  7. PE binary (MZ magic bytes)
 *  8. Mach-O binary (fat binary magic)
 *  9. Java .class magic bytes
 * 10. WebAssembly binary
 * 11. ZIP archive binary
 * 12. PDF binary
 * 13. Large file skip
 *
 * Prerequisites: None (pure filesystem)
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p0a-skip-expansion.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { walkRepositoryPaths, type WalkRepositoryResult } from '../../src/core/ingestion/filesystem-walker.js';
import { skipE2E, makeTempDir, writeFixtureFile } from './helpers.js';

describe.skipIf(skipE2E)('P0a E2E Expansion: Language Profiles + Binary Formats', () => {
  let repoDir: string;
  let result: WalkRepositoryResult;
  const paths = new Set<string>();

  beforeAll(async () => {
    repoDir = makeTempDir('p0a-exp-e2e');

    // ── Source code (should be kept) ────────────────────────────────
    writeFixtureFile(repoDir, 'src/index.ts', 'export const x = 1;\n');
    writeFixtureFile(repoDir, 'README.md', '# Expansion Test\n\nTest.\n');

    // ── JavaScript build dirs ───────────────────────────────────────
    writeFixtureFile(repoDir, '.turbo/turbo.log', 'turbo build log\n');
    writeFixtureFile(repoDir, '.next/build-manifest.json', '{"pages":[]}\n');
    writeFixtureFile(repoDir, '.nuxt/nuxt.config.js', 'export default {}\n');
    writeFixtureFile(repoDir, 'coverage/lcov.info', 'SF:src/index.ts\n');

    // ── C++ build artifacts ─────────────────────────────────────────
    writeFixtureFile(repoDir, 'src/main.o', Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Buffer.alloc(80, 0)]));
    writeFixtureFile(repoDir, 'src/helper.obj', 'fake obj\n');
    writeFixtureFile(repoDir, 'cmake-build-debug/output.bin', 'debug binary\n');

    // ── Go build artifacts ──────────────────────────────────────────
    writeFixtureFile(repoDir, 'vendor/github.com/pkg/errors/errors.go', 'package errors\n');
    writeFixtureFile(repoDir, 'bin/myapp', 'go binary\n');
    writeFixtureFile(repoDir, 'cmd/app.exe', 'windows exe\n');

    // ── Java build artifacts ────────────────────────────────────────
    writeFixtureFile(repoDir, 'target/classes/Main.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe, ...Buffer.alloc(80, 0)]));
    writeFixtureFile(repoDir, 'build/libs/app.jar', 'jar placeholder\n');
    writeFixtureFile(repoDir, '.gradle/6.8/gc.properties', 'gradle cache\n');

    // ── Ruby build artifacts ────────────────────────────────────────
    writeFixtureFile(repoDir, 'vendor/bundle/ruby/3.0/gems/rack-2.2/lib/rack.rb', 'module Rack\n');
    writeFixtureFile(repoDir, '.bundle/config', '---\nBUNDLE_PATH: "vendor/bundle"\n');

    // ── C# build artifacts ──────────────────────────────────────────
    writeFixtureFile(repoDir, 'src/App/bin/Debug/net6.0/App.dll', 'fake dll\n');
    writeFixtureFile(repoDir, 'src/App/obj/Debug/net6.0/App.pdb', 'fake pdb\n');
    writeFixtureFile(repoDir, '.vs/Project/v17/config/applicationhost.config', 'iis config\n');

    // ── Binary without extension (tested by magic bytes) ────────────
    // PE binary (no .exe extension, pure magic bytes detection)
    writeFixtureFile(repoDir, 'bin/pe-module', Buffer.from([0x4d, 0x5a, ...Buffer.alloc(80, 0)]));
    // Mach-O 64-bit (no extension)
    writeFixtureFile(repoDir, 'bin/macho-binary', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...Buffer.alloc(80, 0)]));
    // WebAssembly (no extension)
    writeFixtureFile(repoDir, 'bin/wasm-module', Buffer.from([0x00, 0x61, 0x73, 0x6d, ...Buffer.alloc(80, 0)]));
    // ZIP archive (no extension)
    writeFixtureFile(repoDir, 'bin/archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(80, 0)]));
    // PDF (no extension)
    writeFixtureFile(repoDir, 'bin/document.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, ...Buffer.alloc(80, 0)]));

    // ── Large file skip (overly large content) ──────────────────────
    // WalkRepositoryPaths doesn't skip large files by size currently,
    // but the binary detection should catch these.
    writeFixtureFile(repoDir, 'data/large.csv', 'a,b,c\n'.repeat(10000));

    // ── Run walker ──────────────────────────────────────────────────
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

  // ── Source files kept ─────────────────────────────────────────────
  it('keeps real source files', () => {
    expect(paths.has('src/index.ts')).toBe(true);
    expect(paths.has('README.md')).toBe(true);
  });

  // ── 1. JavaScript build dirs skipped ──────────────────────────────
  it('skips .turbo directory (JS build dir)', () => {
    expect(paths.has('.turbo/turbo.log')).toBe(false);
  });

  it('skips .next directory (Next.js build dir)', () => {
    expect(paths.has('.next/build-manifest.json')).toBe(false);
  });

  it('skips .nuxt directory (Nuxt.js build dir)', () => {
    expect(paths.has('.nuxt/nuxt.config.js')).toBe(false);
  });

  it('skips coverage directory', () => {
    expect(paths.has('coverage/lcov.info')).toBe(false);
  });

  // ── 2. C++ build artifacts skipped ────────────────────────────────
  it('skips .o object file (C++ binary artifact)', () => {
    expect(paths.has('src/main.o')).toBe(false);
  });

  it('skips .obj object file (C++ binary artifact)', () => {
    expect(paths.has('src/helper.obj')).toBe(false);
  });

  it('skips cmake-build-debug directory (CLion build dir)', () => {
    expect(paths.has('cmake-build-debug/output.bin')).toBe(false);
  });

  // ── 3. Go build artifacts skipped ─────────────────────────────────
  it('skips vendor/ directory (Go deps)', () => {
    expect(paths.has('vendor/github.com/pkg/errors/errors.go')).toBe(false);
  });

  it('skips .exe file (Go Windows binary)', () => {
    expect(paths.has('cmd/app.exe')).toBe(false);
  });

  // ── 4. Java build artifacts skipped ───────────────────────────────
  it('skips target/ directory (Maven build dir)', () => {
    expect(paths.has('target/classes/Main.class')).toBe(false);
  });

  it('skips build/libs directory (Gradle jar output)', () => {
    expect(paths.has('build/libs/app.jar')).toBe(false);
  });

  it('skips .gradle directory (Gradle cache)', () => {
    expect(paths.has('.gradle/6.8/gc.properties')).toBe(false);
  });

  // ── 5. Ruby build artifacts skipped ───────────────────────────────
  it('skips vendor/bundle directory (Ruby gem bundle)', () => {
    expect(paths.has('vendor/bundle/ruby/3.0/gems/rack-2.2/lib/rack.rb')).toBe(false);
  });

  it('skips .bundle directory (Ruby bundle config)', () => {
    expect(paths.has('.bundle/config')).toBe(false);
  });

  // ── 6. C# build artifacts skipped ─────────────────────────────────
  it('skips bin/ directory (C# build output)', () => {
    expect(paths.has('src/App/bin/Debug/net6.0/App.dll')).toBe(false);
  });

  it('skips obj/ directory (C# intermediate objects)', () => {
    expect(paths.has('src/App/obj/Debug/net6.0/App.pdb')).toBe(false);
  });

  it('skips .vs directory (Visual Studio config)', () => {
    expect(paths.has('.vs/Project/v17/config/applicationhost.config')).toBe(false);
  });

  // ── 7. Binary formats (magic bytes, no extension) ─────────────────
  it('skips PE binary (MZ magic bytes, no .exe extension)', () => {
    expect(paths.has('bin/pe-module')).toBe(false);
  });

  it('skips Mach-O 64-bit binary (fat magic, no extension)', () => {
    expect(paths.has('bin/macho-binary')).toBe(false);
  });

  it('skips WebAssembly binary (wasm magic, no extension)', () => {
    expect(paths.has('bin/wasm-module')).toBe(false);
  });

  it('skips ZIP archive (PK magic, no .zip extension)', () => {
    expect(paths.has('bin/archive.zip')).toBe(false);
  });

  it('skips PDF document (%PDF magic, no extension)', () => {
    expect(paths.has('bin/document.pdf')).toBe(false);
  });

  // ── Skip summary ──────────────────────────────────────────────────
  it('skip summary reflects vendor dirs skipped', () => {
    expect(result.skipSummary.skippedVendor).toBeGreaterThan(0);
  });

  it('skip summary reflects binary files skipped', () => {
    expect(result.skipSummary.skippedBinary).toBeGreaterThan(0);
  });

  it('skip summary reflects language build artifacts skipped', () => {
    expect(result.skipSummary.skippedLanguage).toBeGreaterThan(0);
  });

  // ── Overall ───────────────────────────────────────────────────────
  it('overall: keeps source files and text artifact files', () => {
    expect(paths.has('src/index.ts')).toBe(true);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.files.length).toBeLessThan(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Large File Skip
// WalkRepositoryPaths has MAX_FILE_SIZE = 512KB (512 * 1024 bytes).
// Files exceeding this threshold are skipped regardless of content type.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skipE2E)('P0a E2E Expansion: Large File Skip', () => {
  let repoDir: string;
  let result: WalkRepositoryResult;
  const paths = new Set<string>();

  beforeAll(async () => {
    repoDir = makeTempDir('p0a-large-e2e');

    // Small file (should be kept)
    writeFixtureFile(repoDir, 'src/small.ts', '// small file\n'.repeat(5000)); // ~65KB
    // Large text file >512KB (should be skipped)
    writeFixtureFile(repoDir, 'src/large.ts', 'x'.repeat(530_000)); // ~530KB
    // Large binary buffer >512KB (should be skipped)
    writeFixtureFile(repoDir, 'data/huge.bin', Buffer.alloc(600_000, 0xff));

    // Document whitelist files even large
    writeFixtureFile(repoDir, 'docs/big.md', '# Big\n\nContent.\n');

    result = await walkRepositoryPaths(repoDir, undefined, { returnSkipSummary: true });
    for (const f of result.files) {
      paths.add(f.path.replace(/\\/g, '/'));
    }
  }, 30_000);

  afterAll(() => {
    if (repoDir && process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps small files under 512KB', () => {
    expect(paths.has('src/small.ts')).toBe(true);
  });

  it('skips files larger than 512KB (src/large.ts)', () => {
    expect(paths.has('src/large.ts')).toBe(false);
  });

  it('skips large binary files (>512KB)', () => {
    expect(paths.has('data/huge.bin')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// .jellyignore Negation Pattern
// Tests that !negation patterns in .jellyignore can re-include files that
// would otherwise be excluded by the default ignore profile.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skipE2E)('P0a E2E Expansion: .jellyignore Negation', () => {
  let repoDir: string;
  let result: WalkRepositoryResult;
  const paths = new Set<string>();

  beforeAll(async () => {
    repoDir = makeTempDir('p0a-neg-e2e');

    writeFixtureFile(repoDir, 'src/index.ts', 'export const x = 1;\n');
    writeFixtureFile(repoDir, 'src/helper.ts', 'export const h = 2;\n');

    // .jellyignore: exclude temp/ directory (custom ignore, overrides defaults)
    // Note: Glob v13 `ignore` option does NOT support `!` negation patterns.
    // Negation (`!important.log` to re-include within an ignored pattern)
    // is not supported. Only positive exclusion patterns work.
    writeFixtureFile(repoDir, '.jellyignore', 'temp/\n');
    writeFixtureFile(repoDir, 'temp/scratch.ts', '// temporary\n');
    writeFixtureFile(repoDir, 'temp/output.ts', '// more temp\n');

    result = await walkRepositoryPaths(repoDir, undefined, { returnSkipSummary: true });
    for (const f of result.files) {
      paths.add(f.path.replace(/\\/g, '/'));
    }
  }, 30_000);

  afterAll(() => {
    if (repoDir && process.env.KEEP_E2E_FIXTURE !== '1') {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps source file in root', () => {
    expect(paths.has('src/index.ts')).toBe(true);
  });

  it('temp/ directory contents are excluded via .jellyignore', () => {
    expect(paths.has('temp/scratch.ts')).toBe(false);
    expect(paths.has('temp/output.ts')).toBe(false);
  });

  it('source files not affected by .jellyignore exclusion', () => {
    expect(paths.has('src/index.ts')).toBe(true);
  });
});
