/**
 * Tests: P1 Reverse Dependency Finder
 *
 * Verifies the reverse-dependency-finder module correctly identifies
 * files that depend on changed files through IMPORTS, CALLS, EXTENDS,
 * and IMPLEMENTS relationships.
 */

import { describe, it, expect, vi } from 'vitest';

describe('P1: Reverse Dependency Finder', () => {
  it('findReverseDependencies should return empty result for empty input', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn(),
    };

    const result = await findReverseDependencies([], { graph: mockGraph as any }, 'test-project');

    expect(result.filesToReparse.size).toBe(0);
    expect(result.reverseDeps).toEqual([]);
    expect(mockGraph.query).not.toHaveBeenCalled();
  });

  it('should find file-level IMPORTS dependencies', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        // Phase 1: File-level
        .mockResolvedValueOnce([{ filePath: 'src/consumer.ts' }])
        // Phase 2: Node-level
        .mockResolvedValueOnce([]),
    };

    const result = await findReverseDependencies(
      ['src/utils.ts'],
      { graph: mockGraph as any },
      'test-project',
    );

    expect(result.reverseDeps).toContain('src/consumer.ts');
    expect(result.filesToReparse.has('src/utils.ts')).toBe(true);
    expect(result.filesToReparse.has('src/consumer.ts')).toBe(true);
  });

  it('should find node-level CALLS/EXTENDS/IMPLEMENTS dependencies', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        // Phase 1: File-level — no file-level deps
        .mockResolvedValueOnce([])
        // Phase 2: Node-level
        .mockResolvedValueOnce([
          { filePath: 'src/extender.ts' },
          { filePath: 'src/caller.ts' },
        ]),
    };

    const result = await findReverseDependencies(
      ['src/base.ts'],
      { graph: mockGraph as any },
      'test-project',
    );

    expect(result.reverseDeps).toContain('src/extender.ts');
    expect(result.reverseDeps).toContain('src/caller.ts');
    expect(result.reverseDeps).not.toContain('src/base.ts');
  });

  it('should not include changed files in reverseDeps', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        .mockResolvedValueOnce([{ filePath: 'src/changed.ts' }])
        .mockResolvedValueOnce([]),
    };

    const result = await findReverseDependencies(
      ['src/changed.ts'],
      { graph: mockGraph as any },
      'test-project',
    );

    expect(result.reverseDeps).not.toContain('src/changed.ts');
    expect(result.filesToReparse.size).toBe(1);
  });

  it('should deduplicate reverse dependencies', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        // Phase 1: File-level (consumer1 imports changed.ts)
        .mockResolvedValueOnce([{ filePath: 'src/consumer1.ts' }])
        // Phase 2: Node-level (consumer2 calls changed.ts symbol)
        .mockResolvedValueOnce([{ filePath: 'src/consumer1.ts' }, { filePath: 'src/consumer2.ts' }]),
    };

    const result = await findReverseDependencies(
      ['src/changed.ts'],
      { graph: mockGraph as any },
      'test-project',
    );

    // consumer1 appears in both phases, should be deduplicated
    expect(result.reverseDeps.length).toBe(2);
    expect(result.reverseDeps.filter(d => d === 'src/consumer1.ts').length).toBe(1);
  });

  it('should include deleted files in the query set', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        .mockResolvedValueOnce([{ filePath: 'src/consumer.ts' }])
        .mockResolvedValueOnce([]),
    };

    // deleted files should still be in the query
    const result = await findReverseDependencies(
      ['src/deleted.ts', 'src/modified.ts'],
      { graph: mockGraph as any },
      'test-project',
    );

    // Both deleted and modified should be in filesToReparse
    expect(result.filesToReparse.has('src/deleted.ts')).toBe(true);
    expect(result.filesToReparse.has('src/modified.ts')).toBe(true);
    expect(result.reverseDeps).toContain('src/consumer.ts');
  });

  // ==========================================
  // Multi-hop reverse dependency tests
  // ==========================================

  it('[multi-hop] depth=2 should find transitive importers (A imports B imports C)', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        // Phase 1 (depth=2): finds transitive importer
        .mockResolvedValueOnce([
          { filePath: 'src/consumer.ts' },  // A imports B
          { filePath: 'src/transitive.ts' }, // A imports B imports C (C is changed)
        ])
        // Phase 2: no node-level deps
        .mockResolvedValueOnce([]),
    };

    const result = await findReverseDependencies(
      ['src/changed.ts'], { graph: mockGraph as any }, 'test-project',
    );

    expect(result.reverseDeps).toContain('src/consumer.ts');
    expect(result.reverseDeps).toContain('src/transitive.ts');
    // changed file should be in filesToReparse but NOT in reverseDeps
    expect(result.filesToReparse.has('src/changed.ts')).toBe(true);
    expect(result.reverseDeps).not.toContain('src/changed.ts');
  });

  it('[multi-hop] depth=1 should find only direct importers', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        // Phase 1 (depth=1): only direct importers
        .mockResolvedValueOnce([
          { filePath: 'src/direct.ts' },  // direct.ts imports changed.ts
          // transitive.ts also imports changed.ts indirectly, but at depth=1 it won't appear
        ])
        // Phase 2: no node-level deps
        .mockResolvedValueOnce([]),
    };

    const result = await findReverseDependencies(
      ['src/changed.ts'], { graph: mockGraph as any }, 'test-project', 1,
    );

    expect(result.reverseDeps).toContain('src/direct.ts');
    expect(result.reverseDeps.length).toBe(1);
    expect(result.filesToReparse.has('src/changed.ts')).toBe(true);
  });

  // ==========================================
  // Cypher query string validation (regression guard)
  // ==========================================

  it('should generate valid Cypher query (no double brackets) for depth=2', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const queries: string[] = [];
    const mockGraph = {
      query: vi.fn().mockImplementation((query: string) => {
        queries.push(query);
        return [];
      }),
    };

    await findReverseDependencies(
      ['src/changed.ts'], { graph: mockGraph as any }, 'test-project', 2,
    );

    // query[0] = Phase 1 file-level (IMPORTS), query[1] = Phase 2 node-level (CALLS|EXTENDS|IMPLEMENTS)
    const phase1Query = queries[0];
    expect(phase1Query).toBeDefined();
    // Should NOT have double brackets: [[:IMPORTS...
    expect(phase1Query).not.toContain('[[:IMPORTS');
    // Should have single brackets: -[:IMPORTS*1..2]->
    expect(phase1Query).toMatch(/-\[:IMPORTS\*1\.\.2\]->/);
  });

  it('should generate valid Cypher query (no double brackets) for depth=1', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const queries: string[] = [];
    const mockGraph = {
      query: vi.fn().mockImplementation((query: string) => {
        queries.push(query);
        return [];
      }),
    };

    await findReverseDependencies(
      ['src/changed.ts'], { graph: mockGraph as any }, 'test-project', 1,
    );

    const phase1Query = queries[0];
    expect(phase1Query).toBeDefined();
    // depth=1 should have [:IMPORTS]
    expect(phase1Query).not.toContain('[[:IMPORTS');
    expect(phase1Query).toMatch(/-\[:IMPORTS\]->/);
  });

  it('[multi-hop] depth=3 with empty intermediate results', async () => {
    const { findReverseDependencies } = await import('../../src/core/reverse-dependency-finder.js');

    const mockGraph = {
      query: vi.fn()
        // Phase 1 (depth=3): no one imports the changed files at all
        .mockResolvedValueOnce([])
        // Phase 2: no node-level deps
        .mockResolvedValueOnce([]),
    };

    const result = await findReverseDependencies(
      ['src/orphan.ts'], { graph: mockGraph as any }, 'test-project', 3,
    );

    expect(result.reverseDeps).toEqual([]);
    expect(result.filesToReparse.size).toBe(1);
    expect(result.filesToReparse.has('src/orphan.ts')).toBe(true);
  });
});
