/**
 * Temporal analysis types for git history integration (Phase 2).
 *
 * These types model commits, file changes, renames, blame data,
 * and the relations (CHANGED_IN, AUTHORED_BY) that connect code
 * nodes to their temporal history.
 */

/** A single git commit */
export interface CommitData {
  hash: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: string;        // ISO 8601
  additions: number;
  deletions: number;
  isMerge: boolean;
  changedFiles: FileChange[];
}

/** A file changed in a commit */
export interface FileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions?: number;
  deletions?: number;
  newPath?: string;          // for renames
}

/** A rename/move event */
export interface RenameInfo {
  oldPath: string;
  newPath: string;
  commitHash: string;
  timestamp: string;
}

/** A single line from git blame */
export interface BlameLine {
  lineNumber: number;
  commitHash: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  content: string;
}

/** Ownership summary from blame data */
export interface BlameSummary {
  author: string;
  authorEmail: string;
  contributionLines: number;
  percentage: number;
}

/** Options for git data extraction */
export interface GitExtractOptions {
  since?: string;           // ISO date or commit hash
  until?: string;
  maxCommits?: number;      // default 10000
  includeMerges?: boolean;  // default false
}

/** Result of temporal analysis */
export interface TemporalAnalysisResult {
  commits: CommitData[];
  authors: AuthorInfo[];
  changedInRelations: ChangedInRelation[];
  authoredByRelations: AuthoredByRelation[];
  renames: RenameInfo[];
  unmappedChanges: FileChange[];  // changes where no graph node was found
  isGitRepo: boolean;
}

/** Author information extracted from commits */
export interface AuthorInfo {
  name: string;
  email: string;
  commitCount: number;
  activeDays: number;
}

/** CHANGED_IN relation data */
export interface ChangedInRelation {
  nodeId: string;          // File/CodeNode ID
  commitHash: string;
  changeType: string;
  additions: number;
  deletions: number;
  timestamp: string;
}

/** AUTHORED_BY relation data */
export interface AuthoredByRelation {
  nodeId: string;          // File/CodeNode ID
  authorEmail: string;
  projectId: string;       // projectId on the relation, not on Author node
  changeCount: number;
  lastChangeAt: string;
  ownership: number;       // 0-1, changeCount / totalChanges on node
}
