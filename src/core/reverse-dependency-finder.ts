/**
 * Reverse Dependency Finder
 *
 * Finds files that depend on the changed files, ensuring that when a file's
 * exports change, all its consumers are also re-parsed in incremental mode.
 *
 * CRITICAL: This query MUST run BEFORE the stale data deletion, otherwise
 * the old relationships (IMPORTS, CALLS, EXTENDS, IMPLEMENTS) will be gone
 * and reverse dependencies won't be found.
 */

import type { IGraphStore } from '../store/interfaces.js';

export interface ReverseDependencyResult {
  /** Set of files that need re-parsing (changed files + reverse dependencies) */
  filesToReparse: Set<string>;
  /** Reverse dependency files only (excluding the original changed files) */
  reverseDeps: string[];
}

/**
 * Process the result of a multi-hop query to eliminate intermediate hops
 * and return only leaf dependencies.
 */
function processMultiHopResult(
  rows: Array<{ filePath: string; hop: number }>,
  changedFiles: string[],
): string[] {
  const resultSet = new Set<string>();
  for (const r of rows) {
    if (!changedFiles.includes(r.filePath)) {
      resultSet.add(r.filePath);
    }
  }
  return [...resultSet];
}

/**
 * Find all files that depend on the given changed files.
 *
 * Uses two queries:
 * 1. File-level: who IMPORTS the changed files (multi-hop via depth parameter)
 * 2. Node-level: who CALLS/EXTENDS/IMPLEMENTS symbols in the changed files (1-hop only)
 *
 * @param depth - Number of hops for file-level dependency traversal (default 2).
 *                depth=1 = direct imports only, same as the original behavior.
 *                depth=2 = also find files that import the importers.
 *                Higher depths are increasingly expensive in Cypher.
 */
export async function findReverseDependencies(
  changedFiles: string[],
  stores: { graph: IGraphStore },
  projectId: string,
  depth: number = 2,
): Promise<ReverseDependencyResult> {
  if (changedFiles.length === 0) {
    return { filesToReparse: new Set(), reverseDeps: [] };
  }

  // Phase 1: File-level dependencies — multi-hop import chain
  // Use variable-length path matching so a change to a deeply imported module
  // triggers re-analysis of all transitive consumers.
  // LIMIT 500 prevents Cypher result explosion in repos with dense import graphs.
  const pathPattern = depth > 1 ? `[:IMPORTS*1..${depth}]` : '[:IMPORTS]';
  const fileLevelResult = await stores.graph.query(
    `MATCH (f1:File)-${pathPattern}->(f2:File)
     WHERE f2.filePath IN $changedFiles AND f1.projectId = $projectId
     RETURN DISTINCT f1.filePath AS filePath
     LIMIT 500`,
    { changedFiles, projectId },
  );

  // Phase 2: Node-level dependencies — who calls symbols in the changed files?
  // Kept at 1-hop because function call chains across projects are typically direct,
  // and multi-hop CALLS paths quickly explode the result set.
  const nodeLevelResult = await stores.graph.query(
    `MATCH (caller)-[:CALLS|EXTENDS|IMPLEMENTS]->(callee)
     WHERE callee.filePath IN $changedFiles AND caller.projectId = $projectId
     RETURN DISTINCT caller.filePath AS filePath`,
    { changedFiles, projectId },
  );

  const reverseDeps = new Set<string>([
    ...fileLevelResult.map(r => r.filePath as string),
    ...nodeLevelResult.map(r => r.filePath as string),
  ]);

  // Exclude the changed files themselves (they will be re-parsed anyway)
  for (const f of changedFiles) {
    reverseDeps.delete(f);
  }

  return {
    filesToReparse: new Set([...changedFiles, ...reverseDeps]),
    reverseDeps: [...reverseDeps],
  };
}
