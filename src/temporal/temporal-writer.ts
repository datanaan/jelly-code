/**
 * Temporal data writer — persists commits, authors, and temporal relations
 * to the graph store via IGraphStore.
 *
 * Design decisions:
 * - Commit nodes have `projectId` and can use `batchCreateNodes`.
 * - Author nodes do NOT have `projectId` (shared across projects) but
 *   `batchCreateNodes` MERGEs by `id` so it still works.
 * - CHANGED_IN and EVOLVED_FROM use `batchCreateRelations` which resolves
 *   node labels to avoid label-less MATCH (full table scan on 120K+ nodes).
 * - AUTHORED_BY needs custom Cypher because Author nodes lack projectId,
 *   so `batchCreateRelations` (which requires projectId on both endpoints) can't be used.
 *   Instead, we resolve source labels manually and use label-specific MATCH.
 */

import type { IGraphStore, Relation } from '../store/interfaces.js';
import type {
  CommitData,
  AuthorInfo,
  ChangedInRelation,
  AuthoredByRelation,
  RenameInfo,
} from './types.js';

const BATCH_SIZE = 500;

/** Write commits as CodeNode-like nodes. Commit nodes have projectId. */
export async function writeCommits(
  commits: CommitData[],
  projectId: string,
  graphStore: IGraphStore,
): Promise<void> {
  if (commits.length === 0) return;

  // Flatten CommitData to graph-compatible node shape.
  // FileChange[] is NOT stored as a nested array; individual changes
  // become CHANGED_IN relations pointing to the commit.
  const nodes = commits.map((c) => ({
    id: c.hash,
    type: 'Commit',
    projectId,
    name: c.hash.substring(0, 8),
    filePath: '',
    message: c.message,
    author: c.author,
    authorEmail: c.authorEmail,
    timestamp: c.timestamp,
    additions: c.additions,
    deletions: c.deletions,
    isMerge: c.isMerge,
  }));

  // Process in batches
  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    await graphStore.batchCreateNodes(batch as any);
  }
}

/** Write authors as nodes. Author nodes do NOT have projectId. */
export async function writeAuthors(
  authors: AuthorInfo[],
  graphStore: IGraphStore,
): Promise<void> {
  if (authors.length === 0) return;

  // Author nodes intentionally have NO projectId (shared across projects).
  // Use direct Cypher MERGE on id only to avoid batchCreateNodes which
  // requires projectId in the MERGE pattern.
  const BATCH_SIZE_LOCAL = 500;
  for (let i = 0; i < authors.length; i += BATCH_SIZE_LOCAL) {
    const batch = authors.slice(i, i + BATCH_SIZE_LOCAL);
    const rows = batch.map((a) => ({
      id: a.email,
      name: a.name,
      email: a.email,
      commitCount: a.commitCount,
      activeDays: a.activeDays,
    }));
    await graphStore.query(
      `UNWIND $rows AS row
       MERGE (n:Author {id: row.id})
       SET n += row`,
      { rows },
    );
  }
}

/**
 * Write CHANGED_IN relations: CodeNode -[CODE_RELATION {type: 'CHANGED_IN'}]-> Commit.
 * Both endpoints have projectId and labels, so we use batchCreateRelations
 * which resolves labels to avoid label-less MATCH (full table scan).
 */
export async function writeChangedInRelations(
  changes: ChangedInRelation[],
  projectId: string,
  graphStore: IGraphStore,
): Promise<void> {
  if (changes.length === 0) return;

  const relations: Relation[] = changes.map((c) => ({
    id: `${c.nodeId}-CHANGED_IN-${c.commitHash}`,
    sourceId: c.nodeId,
    targetId: c.commitHash,
    type: 'CHANGED_IN',
    confidence: 1.0,
    projectId,
    changeType: c.changeType,
    additions: c.additions,
    deletions: c.deletions,
    timestamp: c.timestamp,
  }));

  for (let i = 0; i < relations.length; i += BATCH_SIZE) {
    const batch = relations.slice(i, i + BATCH_SIZE);
    await graphStore.batchCreateRelations(batch);
  }
}

/**
 * Write AUTHORED_BY relations: CodeNode -[CODE_RELATION {type: 'AUTHORED_BY', projectId}]-> Author.
 * Source (CodeNode) has projectId; target (Author) does NOT.
 * Cannot use batchCreateRelations because it requires projectId on both endpoints.
 * Instead, resolve source labels and use label-specific MATCH for source,
 * with Author label (no projectId) for target.
 */
export async function writeAuthoredByRelations(
  ownerships: AuthoredByRelation[],
  graphStore: IGraphStore,
): Promise<void> {
  if (ownerships.length === 0) return;

  const projectId = ownerships[0].projectId;

  // Resolve labels for source node IDs to avoid label-less MATCH
  const sourceIds = [...new Set(ownerships.map(o => o.nodeId))];
  const sourceLabelMap = await resolveNodeLabels(graphStore, projectId, sourceIds);

  // Group by source label for label-specific MATCH
  const byLabel = new Map<string, AuthoredByRelation[]>();
  for (const o of ownerships) {
    const label = sourceLabelMap.get(o.nodeId) || 'CodeElement';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(o);
  }

  for (const [label, group] of byLabel) {
    const rows = group.map((o) => ({
      sourceId: o.nodeId,
      targetId: o.authorEmail,
      projectId: o.projectId,
      changeCount: o.changeCount,
      lastChangeAt: o.lastChangeAt,
      ownership: o.ownership,
    }));

    // Use backtick-quoting for labels that might be reserved words
    const qLabel = /^[A-Za-z_][A-Za-z0-9_]*$/.test(label) ? label : '`' + label + '`';

    const cypher = `
      UNWIND $rows AS row
      MATCH (a:${qLabel} {id: row.sourceId, projectId: $projectId})
      MATCH (b:Author {id: row.targetId})
      MERGE (a)-[r:CODE_RELATION {sourceId: row.sourceId, targetId: row.targetId, type: 'AUTHORED_BY'}]->(b)
      SET r += row
    `;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await graphStore.query(cypher, { rows: batch, projectId });
    }
  }
}

/**
 * Write EVOLVED_FROM relations: CodeNode -[CODE_RELATION {type: 'EVOLVED_FROM'}]-> CodeNode.
 * Both endpoints are CodeNodes with projectId and labels.
 * Uses batchCreateRelations for label-aware MATCH.
 */
export async function writeEvolvedFromRelations(
  renames: RenameInfo[],
  projectId: string,
  graphStore: IGraphStore,
): Promise<void> {
  if (renames.length === 0) return;

  const relations: Relation[] = renames.map((r) => ({
    id: `${r.newPath}-EVOLVED_FROM-${r.oldPath}`,
    sourceId: r.newPath,   // CodeNode id is typically filePath-based
    targetId: r.oldPath,
    type: 'EVOLVED_FROM',
    confidence: 1.0,
    projectId,
    originalName: r.oldPath,
    originalFile: r.oldPath,
    newPath: r.newPath,
    commitHash: r.commitHash,
    timestamp: r.timestamp,
  }));

  for (let i = 0; i < relations.length; i += BATCH_SIZE) {
    const batch = relations.slice(i, i + BATCH_SIZE);
    await graphStore.batchCreateRelations(batch);
  }
}

/**
 * Resolve the primary label for a set of node IDs.
 * Uses a single batch query with multi-label filter to avoid full table scan.
 */
async function resolveNodeLabels(
  graphStore: IGraphStore,
  projectId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;

  const uniqueIds = [...new Set(ids)];
  const batchSize = 500;
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const rows = await graphStore.query(
      `MATCH (n) WHERE n.projectId = $projectId AND n.id IN $ids
       AND (n:Function OR n:Class OR n:Method OR n:File OR n:Interface OR n:Section OR n:CodeElement)
       RETURN n.id AS id, labels(n)[0] AS label`,
      { projectId, ids: batch },
    );
    for (const row of rows) {
      result.set(row.id as string, (row.label as string) || 'CodeElement');
    }
  }
  return result;
}
