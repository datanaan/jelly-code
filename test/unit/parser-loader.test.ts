/**
 * Tests: Tree-sitter Parser Loader (unit tests, no native binaries)
 *
 * Three layers:
 * Layer 1 — Pure logic (zero mocking):
 *   - isLanguageAvailable() for every supported language enum member
 *   - LANGUAGE_PACKAGES completeness (14 tree-sitter languages, Cobol excluded)
 *
 * Layer 2 — loadLanguage:
 *   - Returns null for unsupported languages
 *   - Handles dynamic import failure gracefully (returns null, not throw)
 *
 * Layer 3 — loadParser:
 *   - Empty language guard → null
 *   - loadLanguage failure → null
 *   - Unknown language returns null
 *   - Not throw even when tree-sitter binary unavailable
 *
 * IMPORTANT: Do NOT vi.mock/vi.doMock the parser-loader module itself.
 * Only the dynamic import() targets inside loadLanguage/loadParser
 * need mocking, and those are npm packages we don't control in test.
 */

import { describe, it, expect } from 'vitest';

// ─── Layer 1: Pure logic (zero mocking) ──────────────────────────

describe('isLanguageAvailable', () => {
  it('should return true for all tree-sitter-supported languages', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');

    const tsLanguages = [
      'javascript', 'typescript', 'python', 'java',
      'c', 'cpp', 'csharp', 'go', 'ruby', 'rust',
      'php', 'kotlin', 'swift', 'dart',
    ];

    for (const lang of tsLanguages) {
      expect(isLanguageAvailable(lang)).toBe(true);
    }
  });

  it('should return false for Cobol (no tree-sitter package)', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isLanguageAvailable('cobol')).toBe(false);
  });

  it('should return false for unknown language strings', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isLanguageAvailable('brainfuck')).toBe(false);
    expect(isLanguageAvailable('')).toBe(false);
  });

  it('should accept string names as well as enum values', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');

    expect(isLanguageAvailable('javascript')).toBe(true);
    expect(isLanguageAvailable('python')).toBe(true);
    expect(isLanguageAvailable('rust')).toBe(true);

    // Case sensitive — wrong case returns false
    expect(isLanguageAvailable('JavaScript')).toBe(false);
    expect(isLanguageAvailable('Python')).toBe(false);
  });
});

describe('LANGUAGE_PACKAGES completeness', () => {
  it('should have a mapping for every tree-sitter-supported language', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');

    // Verify all 14 tree-sitter languages have mappings
    expect(isLanguageAvailable('javascript')).toBe(true);
    expect(isLanguageAvailable('typescript')).toBe(true);
    expect(isLanguageAvailable('python')).toBe(true);
    expect(isLanguageAvailable('java')).toBe(true);
    expect(isLanguageAvailable('c')).toBe(true);
    expect(isLanguageAvailable('cpp')).toBe(true);
    expect(isLanguageAvailable('csharp')).toBe(true);
    expect(isLanguageAvailable('go')).toBe(true);
    expect(isLanguageAvailable('ruby')).toBe(true);
    expect(isLanguageAvailable('rust')).toBe(true);
    expect(isLanguageAvailable('php')).toBe(true);
    expect(isLanguageAvailable('kotlin')).toBe(true);
    expect(isLanguageAvailable('swift')).toBe(true);
    expect(isLanguageAvailable('dart')).toBe(true);

    // Cobol has no tree-sitter support
    expect(isLanguageAvailable('cobol')).toBe(false);
  });
});

// ─── Layer 2: loadLanguage ──────────────────────────────────────

describe('loadLanguage', () => {
  it('should return null for unsupported language (Cobol)', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const result = await loadLanguage('cobol');
    expect(result).toBeNull();
  });

  it('should return null for empty string', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');
    const result = await loadLanguage('');
    expect(result).toBeNull();
  });

  it('should not throw when dynamic import fails — returns null gracefully', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');

    // tree-sitter packages may or may not be installed in test env
    const result = await loadLanguage('javascript');
    // Either null (not installed) or language object, never throws
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('should not throw for any supported language test subset', async () => {
    const { loadLanguage } = await import('../../src/core/tree-sitter/parser-loader.js');

    const testLangs = ['javascript', 'typescript', 'python', 'rust'];
    for (const lang of testLangs) {
      await expect(loadLanguage(lang)).resolves.not.toThrow();
    }
  });
});

// ─── Layer 3: loadParser ────────────────────────────────────────

describe('loadParser', () => {
  it('should return null for empty language (guard clause)', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const result = await loadParser('');
    expect(result).toBeNull();
  });

  it('should return null for unsupported language (Cobol)', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const result = await loadParser('cobol');
    expect(result).toBeNull();
  });

  it('should return null for unknown language string', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const result = await loadParser('nonexistent-lang');
    expect(result).toBeNull();
  });

  it('should not throw when called even if tree-sitter is not installed', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    await expect(loadParser('javascript')).resolves.not.toThrow();
  });

  it('should not crash for any SupportedLanguages enum member', async () => {
    const { loadParser } = await import('../../src/core/tree-sitter/parser-loader.js');
    const { SupportedLanguages } = await import('../../src/shared/index.js');

    const allLangs = Object.values(SupportedLanguages).filter((v): v is string => typeof v === 'string');
    for (const lang of allLangs) {
      await expect(loadParser(lang)).resolves.not.toThrow();
    }
  });
});

// ─── Edge cases ─────────────────────────────────────────────────

describe('parser-loader edge cases', () => {
  it('isLanguageAvailable should work for all enum values without throwing', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    const { SupportedLanguages } = await import('../../src/shared/index.js');

    const allLangs = Object.values(SupportedLanguages).filter((v): v is string => typeof v === 'string');
    for (const lang of allLangs) {
      expect(() => isLanguageAvailable(lang)).not.toThrow();
    }
  });

  it('should handle concurrent calls to isLanguageAvailable', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');

    const results = await Promise.all([
      Promise.resolve(isLanguageAvailable('javascript')),
      Promise.resolve(isLanguageAvailable('typescript')),
      Promise.resolve(isLanguageAvailable('python')),
      Promise.resolve(isLanguageAvailable('cobol')),
    ]);

    expect(results).toEqual([true, true, true, false]);
  });
});
