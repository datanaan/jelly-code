/**
 * Symbol lineage tracker — trace rename/move history via EVOLVED_FROM chain.
 *
 * Follows EVOLVED_FROM relations backward through time to reconstruct
 * the full lineage of a symbol (renames, moves, splits, merges).
 *
 * Design decisions:
 * - Max depth 10 by default to prevent infinite loops from data issues.
 * - Cycle detection: if a nodeId is revisited, traversal stops immediately.
 * - No EVOLVED_FROM data: returns single-element lineage with just the current node.
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { SymbolLineage, LineageEntry } from "./types.js";

const DEFAULT_MAX_DEPTH = 10;

/**
 * Trace the full lineage of a symbol (rename/move history).
 * Follows EVOLVED_FROM relations backward through time.
 * Max depth 10 to prevent infinite loops.
 */
export async function traceLineage(
  projectId: string,
  nodeId: string,
  graphStore: IGraphStore,
  maxDepth?: number,
): Promise<SymbolLineage> {
  const depth = maxDepth ?? DEFAULT_MAX_DEPTH;
  const history: LineageEntry[] = [];
  const visited = new Set<string>();
  let currentId = nodeId;

  for (let i = 0; i < depth; i++) {
    // Cycle detection: stop if we have already visited this node
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    const results = await graphStore.query(
      `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'EVOLVED_FROM'}]->(prev)
       RETURN prev.id AS nodeId, r.commitId AS commitId, r.timestamp AS timestamp,
              r.originalName AS originalName, r.originalFile AS originalFile`,
      { nodeId: currentId, projectId },
    );

    if (results.length === 0) {
      break;
    }

    const row = results[0];
    const nextNodeId = row.nodeId as string;

    // Cycle detection: don't follow a path back to an already-visited node
    if (visited.has(nextNodeId)) {
      break;
    }

    const entry: LineageEntry = {
      nodeId: nextNodeId,
      commitId: row.commitId as string,
      timestamp: row.timestamp as string,
      changeType: "renamed",  // default; actual type could be stored on relation
      originalName: (row.originalName as string) ?? "",
      originalFile: (row.originalFile as string) ?? "",
    };
    history.push(entry);
    currentId = entry.nodeId;
  }

  const originId = history.length > 0 ? history[history.length - 1].nodeId : nodeId;

  return {
    currentId: nodeId,
    history,
    originId,
  };
}

/**
 * Find the origin (original name/file) of a symbol.
 * Walks EVOLVED_FROM chain to the root.
 */
export async function findOrigin(
  projectId: string,
  nodeId: string,
  graphStore: IGraphStore,
): Promise<LineageEntry | null> {
  const lineage = await traceLineage(projectId, nodeId, graphStore);

  if (lineage.history.length === 0) {
    return null;
  }

  // The origin is the last entry in the history chain
  return lineage.history[lineage.history.length - 1];
}

/**
 * Get lineage timeline — sorted by timestamp ascending.
 */
export async function getLineageTimeline(
  projectId: string,
  nodeId: string,
  graphStore: IGraphStore,
): Promise<LineageEntry[]> {
  const lineage = await traceLineage(projectId, nodeId, graphStore);

  return [...lineage.history].sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
}
