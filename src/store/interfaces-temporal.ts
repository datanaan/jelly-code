/**
 * Temporal graph store interface — extends IGraphStore with temporal
 * query methods for commit history, co-change analysis, ownership
 * tracking, and rename tracing.
 *
 * Implemented by Neo4j adapter (src/store/neo4j/temporal-queries.ts).
 */

import type { IGraphStore } from './interfaces.js';
import type {
  CommitData,
  AuthorInfo,
  ChangedInRelation,
  AuthoredByRelation,
  RenameInfo,
} from '../temporal/types.js';

/** Co-changed relation from coupling analysis */
export interface CoChangedRelation {
  nodeA: string;
  nodeB: string;
  coChangeCount: number;
  support: number;
  confidence: number;
  lift: number;
}

/** Ownership info for a node */
export interface OwnershipInfo {
  authorId: string;
  authorName: string;
  authorEmail: string;
  changeCount: number;
  ownership: number;
  lastChangeAt: string;
}

/** Evolved-from relation for rename tracking */
export interface EvolvedFromRelation {
  currentNodeId: string;
  previousNodeId: string;
  originalName: string;
  originalFile: string;
  commitId: string;
  timestamp: string;
}

/** Author node in the graph */
export interface AuthorNode {
  id: string;
  name: string;
  email: string;
  commitCount: number;
  activeDays: number;
}

/**
 * Temporal graph store — extends IGraphStore with temporal query methods.
 * Implemented by Neo4j adapter (src/store/neo4j/temporal-queries.ts).
 */
export interface ITemporalGraphStore extends IGraphStore {
  /** Find commits that changed a specific node */
  findCommitsByNode(projectId: string, nodeId: string): Promise<CommitData[]>;

  /** Find co-changed-with relations for a node */
  findCoChangedWith(projectId: string, nodeId: string, minSupport?: number): Promise<CoChangedRelation[]>;

  /** Find author ownership info for a node */
  findAuthoredBy(projectId: string, nodeId: string): Promise<OwnershipInfo[]>;

  /** Trace the EVOLVED_FROM chain for a node (rename history) */
  findEvolvedFromChain(projectId: string, nodeId: string, maxDepth?: number): Promise<EvolvedFromRelation[]>;

  /** List all authors for a project (via AUTHORED_BY relations) */
  findAuthors(projectId: string): Promise<AuthorNode[]>;

  /** Aggregate CHANGED_IN counts per node (for hotspot detection) */
  countChangedInByNode(projectId: string): Promise<Array<{ nodeId: string; changeCount: number }>>;
}
