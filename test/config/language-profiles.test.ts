/**
 * Unit Tests: Language-aware ignore profiles
 *
 * Tests getLanguageIgnorePatterns() for all supported languages
 * and detectLanguageFromFiles() for automatic language detection.
 */

import { describe, it, expect } from 'vitest';
import {
  getLanguageIgnorePatterns,
  detectLanguageFromFiles,
} from '../../src/config/language-ignore-profiles.js';

describe('language-ignore-profiles', () => {
  describe('getLanguageIgnorePatterns', () => {
    it('JavaScript excludes node_modules', () => {
      const patterns = getLanguageIgnorePatterns('javascript');
      expect(patterns).toContain('node_modules');
    });

    it('JavaScript excludes build artifacts and lock files', () => {
      const patterns = getLanguageIgnorePatterns('javascript');
      expect(patterns).toContain('dist');
      expect(patterns).toContain('build');
      expect(patterns).toContain('*.min.js');
      expect(patterns).toContain('*.map');
    });

    it('C/C++ excludes .o .obj .lib .pdb', () => {
      const patterns = getLanguageIgnorePatterns('cpp');
      expect(patterns).toContain('*.o');
      expect(patterns).toContain('*.obj');
      expect(patterns).toContain('*.lib');
      expect(patterns).toContain('*.pdb');
    });

    it('C/C++ excludes CMake build dirs', () => {
      const patterns = getLanguageIgnorePatterns('cpp');
      expect(patterns).toContain('cmake-build-debug');
      expect(patterns).toContain('CMakeFiles');
    });

    it('Rust excludes target/ and Cargo.lock', () => {
      const patterns = getLanguageIgnorePatterns('rust');
      expect(patterns).toContain('target/');
      expect(patterns).toContain('Cargo.lock');
    });

    it('Python excludes __pycache__ and egg-info', () => {
      const patterns = getLanguageIgnorePatterns('python');
      expect(patterns).toContain('__pycache__');
      expect(patterns).toContain('*.pyc');
      expect(patterns).toContain('*.egg-info');
      expect(patterns).toContain('.mypy_cache');
      expect(patterns).toContain('.pytest_cache');
    });

    it('Go excludes vendor/ and binary artifacts', () => {
      const patterns = getLanguageIgnorePatterns('go');
      expect(patterns).toContain('vendor');
      expect(patterns).toContain('*.exe');
      expect(patterns).toContain('*.test');
    });

    it('Java excludes target/ and .class files', () => {
      const patterns = getLanguageIgnorePatterns('java');
      expect(patterns).toContain('target');
      expect(patterns).toContain('*.class');
      expect(patterns).toContain('*.jar');
    });

    it('returns empty array for unknown language', () => {
      const patterns = getLanguageIgnorePatterns('unknown-lang');
      expect(patterns).toEqual([]);
    });

    it('is case-insensitive for language names', () => {
      const lower = getLanguageIgnorePatterns('javascript');
      const upper = getLanguageIgnorePatterns('JAVASCRIPT');
      const mixed = getLanguageIgnorePatterns('JavaScript');
      expect(lower).toEqual(upper);
      expect(lower).toEqual(mixed);
    });

    it('returns a copy, not the internal array', () => {
      const first = getLanguageIgnorePatterns('javascript');
      expect(first).toContain('node_modules');
      // Mutate the returned array
      first.push('INJECTED_BY_TEST');
      // Re-call — should NOT contain the injected item
      const second = getLanguageIgnorePatterns('javascript');
      expect(second).not.toContain('INJECTED_BY_TEST');
      expect(second.length).toBe(first.length - 1);
    });
  });

  describe('detectLanguageFromFiles', () => {
    it('detects JavaScript from .js and .ts files', () => {
      const files = ['src/index.ts', 'package.json', 'src/app.js'];
      expect(detectLanguageFromFiles(files)).toBe('javascript');
    });

    it('detects Python from .py files', () => {
      const files = ['main.py', 'requirements.txt', 'utils/__init__.py'];
      expect(detectLanguageFromFiles(files)).toBe('python');
    });

    it('detects Rust from .rs files', () => {
      const files = ['src/main.rs', 'Cargo.toml', 'src/lib.rs'];
      expect(detectLanguageFromFiles(files)).toBe('rust');
    });

    it('detects Go from .go files', () => {
      const files = ['main.go', 'go.mod', 'pkg/handler.go'];
      expect(detectLanguageFromFiles(files)).toBe('go');
    });

    it('detects Java from .java files', () => {
      const files = ['src/Main.java', 'pom.xml', 'src/Utils.java'];
      expect(detectLanguageFromFiles(files)).toBe('java');
    });

    it('detects C/C++ from .c and .cpp files', () => {
      const files = ['src/main.c', 'CMakeLists.txt', 'src/engine.cpp'];
      expect(detectLanguageFromFiles(files)).toBe('cpp');
    });

    it('returns null for empty file list', () => {
      expect(detectLanguageFromFiles([])).toBeNull();
    });

    it('returns null when no recognized file extensions', () => {
      const files = ['README.md', 'LICENSE'];
      expect(detectLanguageFromFiles(files)).toBeNull();
    });

    it('detects C/C++ from CMakeLists.txt alone (case-insensitive)', () => {
      // Critical #1: CMakeLists.txt must match despite lowercased lookup
      const files = ['CMakeLists.txt'];
      expect(detectLanguageFromFiles(files)).toBe('cpp');
    });

    it('detects C/C++ from Makefile alone', () => {
      // Critical #1: Makefile must match despite lowercased lookup
      const files = ['Makefile'];
      expect(detectLanguageFromFiles(files)).toBe('cpp');
    });

    it('detects C/C++ from lowercase cmake file', () => {
      const files = ['cmakelists.txt'];
      expect(detectLanguageFromFiles(files)).toBe('cpp');
    });
  });

  describe('Ruby', () => {
    it('excludes vendor/bundle and Gemfile.lock', () => {
      const patterns = getLanguageIgnorePatterns('ruby');
      expect(patterns).toContain('vendor/bundle');
      expect(patterns).toContain('Gemfile.lock');
    });
    it('detects Ruby from .rb extension', () => {
      const files = ['app/models/user.rb'];
      expect(detectLanguageFromFiles(files)).toBe('ruby');
    });
    it('detects Ruby from Gemfile', () => {
      const files = ['Gemfile'];
      expect(detectLanguageFromFiles(files)).toBe('ruby');
    });
  });

  describe('C#', () => {
    it('excludes bin, obj, packages', () => {
      const patterns = getLanguageIgnorePatterns('csharp');
      expect(patterns).toContain('bin');
      expect(patterns).toContain('obj');
      expect(patterns).toContain('packages');
    });
    it('detects C# from .cs extension', () => {
      const files = ['src/Program.cs'];
      expect(detectLanguageFromFiles(files)).toBe('csharp');
    });
    it('detects C# from nuget.config', () => {
      const files = ['nuget.config'];
      expect(detectLanguageFromFiles(files)).toBe('csharp');
    });
    it('detects C# from .cs extension', () => {
      const files = ['src/Program.cs'];
      expect(detectLanguageFromFiles(files)).toBe('csharp');
    });
  });
});
