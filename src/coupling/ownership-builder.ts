/**
 * Ownership builder — constructs code ownership data from AUTHORED_BY relations.
 *
 * Provides:
 * - buildOwnership: aggregate ownership info per node
 * - findExpert: find the top owner for a specific node
 * - calculateBusFactor: compute minimum authors whose departure leaves
 *   the project with >threshold% orphaned modules
 *
 * Design decisions:
 * - AUTHORED_BY relations carry `projectId` (since Author nodes are project-shared).
 * - Author nodes have no projectId — MATCH uses label only for the target.
 * - Bus factor uses primary author (>0.5 ownership) per module.
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { OwnershipInfo } from "./types.js";

/**
 * Build ownership info for all nodes in a project.
 * Queries AUTHORED_BY relations and aggregates per-node.
 */
export async function buildOwnership(
  projectId: string,
  graphStore: IGraphStore,
): Promise<Map<string, OwnershipInfo[]>> {
  const results = await graphStore.query(
    `MATCH (n)-[r:CODE_RELATION {type: 'AUTHORED_BY', projectId: $projectId}]->(a:Author)
     WHERE n.projectId = $projectId
     RETURN n.id AS nodeId, a.id AS authorId, a.name AS authorName, a.email AS authorEmail,
            r.changeCount AS changeCount, r.ownership AS ownership, r.lastChangeAt AS lastChangeAt`,
    { projectId },
  );

  const ownershipMap = new Map<string, OwnershipInfo[]>();

  for (const row of results) {
    const nodeId = row.nodeId as string;
    const info: OwnershipInfo = {
      authorId: row.authorId as string,
      authorName: row.authorName as string,
      authorEmail: row.authorEmail as string,
      changeCount:
        typeof row.changeCount === "number"
          ? row.changeCount
          : Number(row.changeCount),
      ownership:
        typeof row.ownership === "number"
          ? row.ownership
          : Number(row.ownership),
      lastChangeAt: row.lastChangeAt as string,
    };

    const existing = ownershipMap.get(nodeId);
    if (existing) {
      existing.push(info);
    } else {
      ownershipMap.set(nodeId, [info]);
    }
  }

  return ownershipMap;
}

/**
 * Find the expert (top owner) for a specific node.
 */
export async function findExpert(
  projectId: string,
  nodeId: string,
  graphStore: IGraphStore,
): Promise<OwnershipInfo | null> {
  const results = await graphStore.query(
    `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'AUTHORED_BY', projectId: $projectId}]->(a:Author)
     RETURN a.id AS authorId, a.name AS authorName, a.email AS authorEmail,
            r.changeCount AS changeCount, r.ownership AS ownership, r.lastChangeAt AS lastChangeAt
     ORDER BY r.ownership DESC
     LIMIT 1`,
    { projectId, nodeId },
  );

  if (results.length === 0) return null;

  const row = results[0];
  return {
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    authorEmail: row.authorEmail as string,
    changeCount:
      typeof row.changeCount === "number"
        ? row.changeCount
        : Number(row.changeCount),
    ownership:
      typeof row.ownership === "number"
        ? row.ownership
        : Number(row.ownership),
    lastChangeAt: row.lastChangeAt as string,
  };
}

/**
 * Calculate bus factor (preliminary version).
 * Bus factor = minimum number of authors whose departure leaves >threshold% modules unmaintained.
 *
 * A module is "owned" by its primary author (the one with highest ownership).
 * A module becomes "orphaned" when its primary author is removed.
 */
export async function calculateBusFactor(
  projectId: string,
  graphStore: IGraphStore,
  threshold: number = 0.5,
): Promise<{
  busFactor: number;
  criticalAuthors: Array<{
    authorId: string;
    authorName: string;
    ownedModules: number;
  }>;
}> {
  const ownershipMap = await buildOwnership(projectId, graphStore);

  if (ownershipMap.size === 0) {
    return { busFactor: 0, criticalAuthors: [] };
  }

  // For each node, identify the primary author (highest ownership)
  const primaryAuthorByNode = new Map<string, string>();
  const authorNameMap = new Map<string, string>();
  const authorModuleCount = new Map<string, number>();

  for (const [nodeId, owners] of ownershipMap) {
    // Sort by ownership descending
    const sorted = [...owners].sort((a, b) => b.ownership - a.ownership);
    const primary = sorted[0];

    primaryAuthorByNode.set(nodeId, primary.authorId);
    authorNameMap.set(primary.authorId, primary.authorName);

    const current = authorModuleCount.get(primary.authorId) ?? 0;
    authorModuleCount.set(primary.authorId, current + 1);
  }

  const totalModules = ownershipMap.size;
  const orphanThreshold = Math.floor(totalModules * threshold);

  // Sort authors by module count ascending (remove least impactful first)
  const sortedAuthors = [...authorModuleCount.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([authorId, ownedModules]) => ({
      authorId,
      authorName: authorNameMap.get(authorId) ?? authorId,
      ownedModules,
    }));

  // Remove authors one by one, counting orphaned modules
  const removedAuthors = new Set<string>();
  let busFactor = 0;

  for (const author of sortedAuthors) {
    removedAuthors.add(author.authorId);
    busFactor++;

    // Count orphaned modules: modules whose primary author has been removed
    let orphanedCount = 0;
    for (const [nodeId, primaryAuthor] of primaryAuthorByNode) {
      if (removedAuthors.has(primaryAuthor)) {
        orphanedCount++;
      }
    }

    if (orphanedCount > orphanThreshold) {
      break;
    }
  }

  return { busFactor, criticalAuthors: sortedAuthors };
}
