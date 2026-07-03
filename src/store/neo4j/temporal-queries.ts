/**
 * Temporal query functions — implements ITemporalGraphStore query methods
 * as standalone functions that accept any IGraphStore.
 *
 * These functions use `graphStore.query()` to execute Cypher directly,
 * avoiding coupling to the Neo4jAdapter class internals.
 */

import type { IGraphStore } from '../interfaces.js';
import type {
  CoChangedRelation,
  OwnershipInfo,
  EvolvedFromRelation,
  AuthorNode,
} from '../interfaces-temporal.js';
import type { CommitData } from '../../temporal/types.js';

/**
 * Helper: convert Neo4j integer or unknown to a JS number.
 * Handles both native numbers and Neo4j Integer objects.
 */
function toNumber(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && 'toNumber' in (val as object)) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return Number(val);
}

/** Find commits that changed a specific node */
export async function findCommitsByNode(
  graphStore: IGraphStore,
  projectId: string,
  nodeId: string,
): Promise<CommitData[]> {
  const results = await graphStore.query(
    `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'CHANGED_IN'}]->(c:Commit)
     RETURN c
     ORDER BY c.timestamp DESC`,
    { projectId, nodeId },
  );

  return results.map((row) => {
    const c = row.c as Record<string, unknown>;
    // Unwrap Neo4j Node objects
    const props = (c.properties != null && typeof c.properties === 'object'
      ? c.properties as Record<string, unknown>
      : c);
    return {
      hash: props.id as string,
      message: (props.message as string) || '',
      author: (props.author as string) || '',
      authorEmail: (props.authorEmail as string) || '',
      timestamp: (props.timestamp as string) || '',
      additions: toNumber(props.additions),
      deletions: toNumber(props.deletions),
      isMerge: (props.isMerge as boolean) || false,
      changedFiles: [],  // FileChange details are in CHANGED_IN relations, not the node
    };
  });
}

/** Find CO_CHANGED_WITH relations for a node */
export async function findCoChangedWith(
  graphStore: IGraphStore,
  projectId: string,
  nodeId: string,
  minSupport: number = 0.1,
): Promise<CoChangedRelation[]> {
  const results = await graphStore.query(
    `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]-(m)
     WHERE m.projectId = $projectId AND r.support >= $minSupport
     RETURN m.id AS nodeB, r.coChangeCount AS coChangeCount, r.support AS support,
            r.confidence AS confidence, r.lift AS lift`,
    { projectId, nodeId, minSupport },
  );

  return results.map((row) => ({
    nodeA: nodeId,
    nodeB: row.nodeB as string,
    coChangeCount: toNumber(row.coChangeCount),
    support: toNumber(row.support),
    confidence: toNumber(row.confidence),
    lift: toNumber(row.lift),
  }));
}

/** Find ownership info for a node (who authored it) */
export async function findAuthoredBy(
  graphStore: IGraphStore,
  projectId: string,
  nodeId: string,
): Promise<OwnershipInfo[]> {
  const results = await graphStore.query(
    `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'AUTHORED_BY'}]->(a:Author)
     RETURN a.id AS authorId, a.name AS authorName, a.email AS authorEmail,
            r.changeCount AS changeCount, r.ownership AS ownership, r.lastChangeAt AS lastChangeAt`,
    { projectId, nodeId },
  );

  return results.map((row) => ({
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    authorEmail: row.authorEmail as string,
    changeCount: toNumber(row.changeCount),
    ownership: toNumber(row.ownership),
    lastChangeAt: row.lastChangeAt as string,
  }));
}

/** Trace EVOLVED_FROM rename chain (iterative traversal up to maxDepth) */
export async function findEvolvedFromChain(
  graphStore: IGraphStore,
  projectId: string,
  nodeId: string,
  maxDepth: number = 10,
): Promise<EvolvedFromRelation[]> {
  const chain: EvolvedFromRelation[] = [];
  let currentId = nodeId;

  for (let depth = 0; depth < maxDepth; depth++) {
    const results = await graphStore.query(
      `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'EVOLVED_FROM'}]->(prev)
       RETURN prev.id AS previousNodeId, r.originalName AS originalName,
              r.originalFile AS originalFile, r.commitHash AS commitId, r.timestamp AS timestamp`,
      { projectId, nodeId: currentId },
    );

    if (results.length === 0) break;

    const row = results[0];
    const previousNodeId = row.previousNodeId as string;

    chain.push({
      currentNodeId: currentId,
      previousNodeId,
      originalName: (row.originalName as string) || '',
      originalFile: (row.originalFile as string) || '',
      commitId: (row.commitId as string) || '',
      timestamp: (row.timestamp as string) || '',
    });

    currentId = previousNodeId;
  }

  return chain;
}

/** List all authors for a project (via AUTHORED_BY relations filtered by projectId) */
export async function findAuthors(
  graphStore: IGraphStore,
  projectId: string,
): Promise<AuthorNode[]> {
  const results = await graphStore.query(
    `MATCH (n)-[r:CODE_RELATION {type: 'AUTHORED_BY', projectId: $projectId}]->(a:Author)
     RETURN DISTINCT a.id AS id, a.name AS name, a.email AS email,
                     a.commitCount AS commitCount, a.activeDays AS activeDays`,
    { projectId },
  );

  return results.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    commitCount: toNumber(row.commitCount),
    activeDays: toNumber(row.activeDays),
  }));
}

/** Count CHANGED_IN relations per node (for hotspot detection) */
export async function countChangedInByNode(
  graphStore: IGraphStore,
  projectId: string,
): Promise<Array<{ nodeId: string; changeCount: number }>> {
  const results = await graphStore.query(
    `MATCH (n)-[r:CODE_RELATION {type: 'CHANGED_IN'}]->(c:Commit {projectId: $projectId})
     WHERE n.projectId = $projectId
     RETURN n.id AS nodeId, count(r) AS changeCount
     ORDER BY changeCount DESC`,
    { projectId },
  );

  return results.map((row) => ({
    nodeId: row.nodeId as string,
    changeCount: toNumber(row.changeCount),
  }));
}
