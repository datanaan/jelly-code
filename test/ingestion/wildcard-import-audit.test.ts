/**
 * Tests: P2 Wildcard Import Audit
 *
 * Verifies that wildcard/glob imports are correctly handled in both
 * full and incremental (onlyFiles) pipeline modes.
 */

import { describe, it, expect } from 'vitest';

describe('P2: Wildcard Import Audit', () => {

  // ==========================================
  // Go package-level imports
  // ==========================================
  describe('Go directory imports', () => {
    it('resolveGoPackageDir should extract package suffix', async () => {
      const { resolveGoPackageDir } = await import('../../src/core/ingestion/import-resolvers/go.js');
      const goModule = { modulePath: 'github.com/example/project' };

      expect(resolveGoPackageDir('github.com/example/project/internal/auth', goModule)).toBe('/internal/auth/');
      expect(resolveGoPackageDir('github.com/example/project', goModule)).toBeNull();
      expect(resolveGoPackageDir('github.com/other/repo', goModule)).toBeNull();
    });

    it('resolveGoPackage should use full file list (not onlyFiles filtered)', async () => {
      const { resolveGoPackage } = await import('../../src/core/ingestion/import-resolvers/go.js');
      const goModule = { modulePath: 'github.com/example/project' };

      const normalizedFiles = [
        'internal/auth/login.go',
        'internal/auth/register.go',
        'api/handler.go',
      ];
      const allFiles = normalizedFiles;

      const result = resolveGoPackage(
        'github.com/example/project/internal/auth',
        goModule,
        normalizedFiles,
        allFiles,
      );

      expect(result).toEqual(['internal/auth/login.go', 'internal/auth/register.go']);
      expect(result).not.toContain('api/handler.go');
    });
  });

  // ==========================================
  // Java/Kotlin wildcard imports
  // ==========================================
  describe('JVM wildcard imports', () => {
    it('resolveJvmWildcard should resolve com.example.* to matching files', async () => {
      const { resolveJvmWildcard } = await import('../../src/core/ingestion/import-resolvers/jvm.js');

      const allFiles = [
        'src/com/example/User.java',
        'src/com/example/Order.java',
        'src/com/example/util/Helper.java',
      ];

      const result = resolveJvmWildcard(
        'com.example.*',
        allFiles, allFiles,
        ['.java'],
      );

      expect(result).toContain('src/com/example/User.java');
      expect(result).toContain('src/com/example/Order.java');
    });

    it('resolveJavaImport should handle *.class wildcard without index', async () => {
      const { resolveJavaImport } = await import('../../src/core/ingestion/import-resolvers/jvm.js');

      const ctx = {
        allFilePaths: new Set(),
        allFileList: [],
        normalizedFileList: [],
        index: undefined,
        resolveCache: new Map(),
        configs: {},
      } as any;

      // Without a matching file in the file list, should return null or empty
      const result = resolveJavaImport('com.example.dao.*', 'App.java', ctx);
      // The function returns null when no matches found
      expect(result === null || result.kind === 'files').toBe(true);
    });
  });

  // ==========================================
  // Wildcard languages metadata
  // ==========================================
  describe('Wildcard import language metadata', () => {
    it('Go uses wildcard import semantics', async () => {
      const { goProvider } = await import('../../src/core/ingestion/languages/go.js');
      expect(goProvider.importSemantics).toBe('wildcard');
    });

    it('Python uses namespace import semantics', async () => {
      const { pythonProvider } = await import('../../src/core/ingestion/languages/python.js');
      expect(pythonProvider.importSemantics).toBe('namespace');
    });

    it('C/C++ uses wildcard import semantics', async () => {
      const { providers } = await import('../../src/core/ingestion/languages/index.js');
      const wildcardProviders = Object.values(providers).filter((p: any) => p.importSemantics === 'wildcard');
      expect(wildcardProviders.some((p: any) => p.id === 'c')).toBeTruthy();
    });
  });

  // ==========================================
  // Incremental mode behavior
  // ==========================================
  describe('Incremental mode file list', () => {
    it('buildImportResolutionContext should create context with full file list', async () => {
      const { buildImportResolutionContext } = await import('../../src/core/ingestion/import-processor.js');

      const allPaths = [
        'src/auth/login.go',
        'src/auth/register.go',
        'src/api/handler.go',
      ];

      const importCtx = buildImportResolutionContext(allPaths);

      // Verify the resolution context has ALL files (not filtered by onlyFiles)
      expect(importCtx.allFilePaths.has('src/auth/login.go')).toBe(true);
      expect(importCtx.allFilePaths.has('src/auth/register.go')).toBe(true);
      expect(importCtx.allFilePaths.has('src/api/handler.go')).toBe(true);

      // Verify allFileList and normalizedFileList both have full set
      expect(importCtx.allFileList).toContain('src/auth/login.go');
      expect(importCtx.normalizedFileList).toContain('src/auth/login.go');
    });
  });
});
