/**
 * Pure functions extracted from pipeline.ts for unit testability.
 *
 * These functions have no side effects and no dependencies on tree-sitter runtime,
 * making them fully unit-testable. They are imported by pipeline.ts (the entry
 * orchestrator, which remains excluded from tsc compilation).
 */

import { SupportedLanguages } from '@shared';
import { providers } from './languages/index.js';

// ========================================
// Types
// ========================================

/** A group of files with no mutual dependencies, safe to process in parallel. */
export type IndependentFileGroup = readonly string[];

// ========================================
// Constants
// ========================================

/** Max bytes of source content to load per parse chunk. */
export const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
export const AST_CACHE_CAP = 50;

/** Minimum percentage of files that must benefit from cross-file seeding. */
export const CROSS_FILE_SKIP_THRESHOLD = 0.03;

/** Hard cap on files re-processed during cross-file propagation. */
export const MAX_CROSS_FILE_REPROCESS = 2000;

/** Node labels that represent top-level importable symbols. */
export const IMPORTABLE_SYMBOL_LABELS = new Set([
  'Function', 'Class', 'Interface', 'Struct', 'Enum',
  'Trait', 'TypeAlias', 'Const', 'Static', 'Record',
  'Union', 'Typedef', 'Macro',
]);

/** Max synthetic bindings per importing file. */
export const MAX_SYNTHETIC_BINDINGS_PER_FILE = parseInt(process.env.MAX_SYNTHETIC_BINDINGS || '1000', 10);

/** Pre-computed language sets derived from providers at module load. */
export const WILDCARD_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => p.importSemantics === 'wildcard')
    .map((p) => p.id),
);

export const SYNTHESIS_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => p.importSemantics !== 'named')
    .map((p) => p.id),
);

// ========================================
// Pure predicates
// ========================================

/** Check if a language uses wildcard (whole-module) import semantics. */
export function isWildcardImportLanguage(lang: SupportedLanguages): boolean {
  return WILDCARD_LANGUAGES.has(lang);
}

/** Check if a language needs synthesis before call resolution. */
export function needsSynthesis(lang: SupportedLanguages): boolean {
  return SYNTHESIS_LANGUAGES.has(lang);
}

/**
 * Split an array into fixed-size batches.
 * Used by Neo4j adapter for batched node/relation writes.
 */
export function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// ========================================
// Kahn's topological level sort
// ========================================

/** Kahn's algorithm: returns files grouped by topological level.
 *  Files in the same level have no mutual dependencies — safe to process in parallel.
 *  Files in cycles are returned as a final group (no cross-cycle propagation). */
export function topologicalLevelSort(importMap: ReadonlyMap<string, ReadonlySet<string>>): {
  levels: readonly IndependentFileGroup[];
  cycleCount: number;
} {
  // Build in-degree map and reverse dependency map
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const [file, deps] of importMap) {
    if (!inDegree.has(file)) inDegree.set(file, 0);
    for (const dep of deps) {
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
      inDegree.set(file, (inDegree.get(file) ?? 0) + 1);
      let rev = reverseDeps.get(dep);
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(file);
    }
  }

  // BFS from zero-in-degree nodes, grouping by level
  const levels: string[][] = [];
  let currentLevel = [...inDegree.entries()].filter(([, d]) => d === 0).map(([f]) => f);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      for (const dependent of reverseDeps.get(file) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) nextLevel.push(dependent);
      }
    }
    currentLevel = nextLevel;
  }

  // Files still with positive in-degree are in cycles — add as final group
  const cycleFiles = [...inDegree.entries()].filter(([, d]) => d > 0).map(([f]) => f);
  if (cycleFiles.length > 0) {
    levels.push(cycleFiles);
  }

  return { levels, cycleCount: cycleFiles.length };
}

// ========================================
// Import resolvability check
// ========================================

/** Check whether all imports in a file can be resolved against the current graph. */
export function checkImportsResolvable(
  fileImports: ReadonlyMap<string, ReadonlyArray<{ name: string; source: string }>>,
  resolvedSymbols: ReadonlyMap<string, Set<string>>,
): boolean {
  const fileImportsList = fileImports.get('') || [];
  for (const imp of fileImportsList) {
    const resolved = resolvedSymbols.get(imp.source);
    if (!resolved || !resolved.has(imp.name)) {
      return false;
    }
  }
  return true;
}

// ========================================
// Import resolution context
// ========================================

export { buildImportResolutionContext } from './import-processor.js';
