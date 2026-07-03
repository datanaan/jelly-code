/**
 * Level 0 analyzer — lightweight analysis for mega repos (git log only).
 *
 * No AST parsing, no CodeNode creation.
 * Only writes:
 * - Commit nodes + Author nodes
 * - CHANGED_IN relations (file-level pseudo-nodes → commits)
 * - CO_CHANGED_WITH relations (file-level co-occurrence coupling)
 *
 * Should complete in <5 seconds for 100K file repos.
 */

import type { StoreSet } from "../store/interfaces.js";
import type {
  CommitData,
  AuthorInfo,
  ChangedInRelation,
} from "../temporal/types.js";

/**
 * Level 0 analysis result — counts for verification and reporting.
 */
export interface Level0Result {
  commitCount: number;
  authorCount: number;
  fileCount: number;
  couplingPairs: number;
}

/**
 * Level 0 analysis — git log statistics only.
 *
 * Steps:
 * 1. Extract git log (dynamic import of temporal module)
 * 2. Aggregate authors
 * 3. Write Commit + Author nodes
 * 4. Write file-level CHANGED_IN relations (pseudo-File nodes)
 * 5. Build co-occurrence matrix at file level
 * 6. Calculate coupling metrics
 * 7. Write CO_CHANGED_WITH relations
 *
 * Does NOT write: CodeNode, Typesense docs, or Qdrant vectors.
 */
export async function analyzeLevel0(
  repoPath: string,
  projectId: string,
  stores: StoreSet,
): Promise<Level0Result> {
  // Step 1: Extract git log via dynamic import
  const { extractGitLog } = await import("../temporal/git-extractor.js");
  const { commits, isGitRepo } = extractGitLog(repoPath);

  if (!isGitRepo || commits.length === 0) {
    return { commitCount: 0, authorCount: 0, fileCount: 0, couplingPairs: 0 };
  }

  // Step 2: Aggregate authors from commits
  // Use AuthorInfoInternal internally for mutable _activeDays tracking
  const authorMap = new Map<string, AuthorInfoInternal>();
  for (const commit of commits) {
    const key = commit.authorEmail;
    const existing = authorMap.get(key);
    if (existing) {
      existing.commitCount += 1;
      const dateStr = commit.timestamp.substring(0, 10);
      existing.activeDaySet.add(dateStr);
      existing.activeDays = existing.activeDaySet.size;
    } else {
      const info = new AuthorInfoInternal(commit.author, commit.authorEmail);
      info.commitCount = 1;
      const dateStr = commit.timestamp.substring(0, 10);
      info.activeDaySet.add(dateStr);
      info.activeDays = 1;
      authorMap.set(key, info);
    }
  }

  // Convert to AuthorInfo (strip internal activeDaySet)
  const authors: AuthorInfo[] = Array.from(authorMap.values()).map((a) => ({
    name: a.name,
    email: a.email,
    commitCount: a.commitCount,
    activeDays: a.activeDays,
  }));

  // Step 3: Write Commit + Author nodes
  const { writeCommits, writeAuthors } = await import(
    "../temporal/temporal-writer.js"
  );
  await writeCommits(commits, projectId, stores.graph);
  await writeAuthors(authors, stores.graph);

  // Step 4: Collect all unique file paths and create pseudo-File nodes
  const allFilePaths = new Set<string>();
  for (const commit of commits) {
    for (const fc of commit.changedFiles) {
      allFilePaths.add(fc.filePath);
    }
  }

  // Create pseudo-File nodes (no AST-derived properties)
  const pseudoFileNodes = Array.from(allFilePaths).map((filePath) => ({
    id: filePath,
    type: "File",
    projectId,
    name: filePath.split("/").pop() ?? filePath,
    filePath,
  }));
  await stores.graph.batchCreateNodes(pseudoFileNodes as any);

  // Step 5: Write file-level CHANGED_IN relations
  const changedInRelations: ChangedInRelation[] = [];
  for (const commit of commits) {
    for (const fc of commit.changedFiles) {
      changedInRelations.push({
        nodeId: fc.filePath, // pseudo-File node ID = filePath
        commitHash: commit.hash,
        changeType: fc.changeType,
        additions: fc.additions ?? 0,
        deletions: fc.deletions ?? 0,
        timestamp: commit.timestamp,
      });
    }
  }
  await writeChangedInForLevel0(changedInRelations, projectId, stores.graph);

  // Step 6: Build co-occurrence matrix at file level
  const pairCounts = new Map<string, number>();
  for (const commit of commits) {
    const filesInCommit = new Set<string>();
    for (const fc of commit.changedFiles) {
      filesInCommit.add(fc.filePath);
    }

    // Need at least 2 files to form a pair
    if (filesInCommit.size < 2) continue;

    const sorted = Array.from(filesInCommit).sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}:${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Step 7: Write CO_CHANGED_WITH relations with coupling metrics
  const totalCommits = commits.length;
  const fileCommitCounts = new Map<string, number>();
  for (const commit of commits) {
    for (const fc of commit.changedFiles) {
      fileCommitCounts.set(
        fc.filePath,
        (fileCommitCounts.get(fc.filePath) ?? 0) + 1,
      );
    }
  }

  const couplingRelations: Array<{
    sourceId: string;
    targetId: string;
    coChangeCount: number;
    support: number;
    confidence: number;
  }> = [];

  for (const [key, coChangeCount] of pairCounts) {
    const [nodeA, nodeB] = key.split(":");
    const support = totalCommits > 0 ? coChangeCount / totalCommits : 0;
    const countA = fileCommitCounts.get(nodeA) ?? 1;
    const confidence = coChangeCount / countA;

    couplingRelations.push({
      sourceId: nodeA,
      targetId: nodeB,
      coChangeCount,
      support,
      confidence,
    });
  }

  // Write CO_CHANGED_WITH relations in batches
  if (couplingRelations.length > 0) {
    const cypher = `
      UNWIND $rows AS row
      MATCH (a {id: row.sourceId, projectId: $projectId})
      MATCH (b {id: row.targetId, projectId: $projectId})
      MERGE (a)-[r:CODE_RELATION {sourceId: row.sourceId, targetId: row.targetId, type: 'CO_CHANGED_WITH'}]->(b)
      SET r.coChangeCount = row.coChangeCount, r.support = row.support, r.confidence = row.confidence
    `;
    const BATCH_SIZE = 500;
    for (let i = 0; i < couplingRelations.length; i += BATCH_SIZE) {
      const batch = couplingRelations.slice(i, i + BATCH_SIZE);
      await stores.graph.query(cypher, { rows: batch, projectId });
    }
  }

  return {
    commitCount: commits.length,
    authorCount: authors.length,
    fileCount: allFilePaths.size,
    couplingPairs: couplingRelations.length,
  };
}

/**
 * Write CHANGED_IN relations for Level 0 (pseudo-File nodes → Commit nodes).
 *
 * Similar to writeChangedInRelations from temporal-writer but uses pseudo-File
 * nodes (id = filePath) that were created in this analyzer.
 */
async function writeChangedInForLevel0(
  changes: ChangedInRelation[],
  projectId: string,
  graphStore: import("../store/interfaces.js").IGraphStore,
): Promise<void> {
  if (changes.length === 0) return;

  const rows = changes.map((c) => ({
    sourceId: c.nodeId,
    targetId: c.commitHash,
    changeType: c.changeType,
    additions: c.additions,
    deletions: c.deletions,
    timestamp: c.timestamp,
  }));

  const cypher = `
    UNWIND $rows AS row
    MATCH (a {id: row.sourceId, projectId: $projectId})
    MATCH (b:Commit {id: row.targetId, projectId: $projectId})
    MERGE (a)-[r:CODE_RELATION {sourceId: row.sourceId, targetId: row.targetId, type: 'CHANGED_IN'}]->(b)
    SET r += row
  `;

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await graphStore.query(cypher, { rows: batch, projectId });
  }
}

/**
 * Internal mutable author accumulator for building AuthorInfo.
 * activeDaySet tracks unique dates; activeDays is derived from its size.
 */
class AuthorInfoInternal {
  name: string;
  email: string;
  commitCount: number;
  activeDays: number;
  activeDaySet: Set<string> = new Set();

  constructor(name: string, email: string) {
    this.name = name;
    this.email = email;
    this.commitCount = 0;
    this.activeDays = 0;
  }
}
