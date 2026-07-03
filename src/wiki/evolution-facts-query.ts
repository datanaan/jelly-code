/**
 * P2-T1: Evolution Facts Query — aggregates 5 graph queries for code evolution.
 *
 * This module provides gatherEvolutionFacts(), which collects all temporal
 * and evolution data about a code symbol into a single structured object.
 * The result is consumed by the narrator (T3) to produce human-readable
 * evolution stories.
 *
 * Five data sources:
 *   1. EVOLVED_FROM chain — symbol lineage (renames, moves, splits)
 *   2. CHANGED_IN edges — commits that touched the node
 *   3. AUTHORED_BY — contributors and their change counts
 *   4. CO_CHANGED_WITH — symbols frequently changed together
 *   5. Bi-temporal change timeline — valid_time intervals from P1
 *
 * Design:
 *   - Uses existing temporal query functions (temporal-queries.ts)
 *   - Uses existing bi-temporal queries (bitemporal-queries.ts)
 *   - Accepts any IGraphStore (no coupling to Neo4j adapter)
 *   - All queries are independent → parallel via Promise.all
 *   - Result mapping converts internal types to the EvolutionFacts shape
 */

import type { IGraphStore } from '../store/interfaces.js';
import {
  findCommitsByNode,
  findCoChangedWith,
  findAuthoredBy,
  findEvolvedFromChain,
} from '../store/neo4j/temporal-queries.js';
import { createBitemporalQueries } from '../store/neo4j/bitemporal-queries.js';

// ─── Types ────────────────────────────────────────────────────────

/** A single step in the EVOLVED_FROM lineage (rename / move). */
export interface EvolvedFromFact {
  /** The node that evolved (current at that point in history). */
  from: string;
  /** The previous node it evolved from. */
  to: string;
  /** The commit where the evolution occurred. */
  commit: string;
  /** When the evolution occurred (ISO 8601). */
  timestamp: string;
}

/** A commit that changed this node. */
export interface ChangedInFact {
  /** Commit hash. */
  commit: string;
  /** Commit timestamp (ISO 8601). */
  timestamp: string;
  /** Lines added in this commit. */
  additions: number;
  /** Lines deleted in this commit. */
  deletions: number;
  /** Commit author name. */
  author: string;
}

/** A contributor who authored changes to this node. */
export interface AuthoredByFact {
  /** Author name. */
  author: string;
  /** Number of commits by this author to this node. */
  commitCount: number;
  /** First time this author touched this node (ISO 8601). */
  firstSeen: string;
  /** Last time this author touched this node (ISO 8601). */
  lastSeen: string;
}

/** A sibling symbol frequently changed together with this node. */
export interface CoChangedWithFact {
  /** The sibling node ID. */
  nodeId: string;
  /** Number of times they co-changed. */
  coChangeCount: number;
  /** Jaccard similarity (support metric from co-change analysis). */
  jaccard: number;
}

/** A timeline entry from bi-temporal data showing when facts changed. */
export interface ChangeTimelineFact {
  /** Timestamp of the change (ISO 8601). */
  timestamp: string;
  /** When this fact became valid (valid_time start). */
  validFrom: string;
  /** When this fact was superseded (valid_time end, or null if current). */
  validTo: string | null;
}

/**
 * Aggregated evolution facts for a code symbol.
 *
 * This is the primary data structure consumed by the narrator (T3)
 * to generate human-readable evolution stories.
 */
export interface EvolutionFacts {
  /** The node ID these facts describe. */
  nodeId: string;
  /** Symbol lineage chain (EVOLVED_FROM), ordered most-recent-first. */
  evolvedFrom: EvolvedFromFact[];
  /** Commits that changed this node (CHANGED_IN), newest-first. */
  changedIn: ChangedInFact[];
  /** Contributors and their change counts (AUTHORED_BY). */
  authoredBy: AuthoredByFact[];
  /** Co-changed siblings (CO_CHANGED_WITH), sorted by coChangeCount desc. */
  coChangedWith: CoChangedWithFact[];
  /** Bi-temporal change timeline showing when facts became valid/superseded. */
  changeTimeline: ChangeTimelineFact[];
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Map CommitData to ChangedInFact.
 * CommitData changedFiles is not needed for evolution narrative.
 */
function mapCommitToFact(c: {
  hash: string;
  timestamp: string;
  additions: number;
  deletions: number;
  author: string;
}): ChangedInFact {
  return {
    commit: c.hash,
    timestamp: c.timestamp,
    additions: c.additions,
    deletions: c.deletions,
    author: c.author,
  };
}

/**
 * Map OwnershipInfo to AuthoredByFact.
 * firstSeen is not tracked in OwnershipInfo, so we use lastChangeAt as a
 * best-effort proxy. The field is preserved for future enrichment.
 */
function mapOwnershipToFact(o: {
  authorName: string;
  changeCount: number;
  lastChangeAt: string;
}): AuthoredByFact {
  return {
    author: o.authorName,
    commitCount: o.changeCount,
    // OwnershipInfo does not track firstSeen — use lastChangeAt as proxy
    firstSeen: o.lastChangeAt,
    lastSeen: o.lastChangeAt,
  };
}

/**
 * Map CoChangedRelation to CoChangedWithFact.
 * Jaccard similarity is the support metric.
 */
function mapCoChangedToFact(r: {
  nodeB: string;
  coChangeCount: number;
  support: number;
}): CoChangedWithFact {
  return {
    nodeId: r.nodeB,
    coChangeCount: r.coChangeCount,
    jaccard: r.support,
  };
}

/**
 * Map EvolvedFromRelation to EvolvedFromFact.
 */
function mapEvolvedFromToFact(r: {
  currentNodeId: string;
  previousNodeId: string;
  commitId: string;
  timestamp: string;
}): EvolvedFromFact {
  return {
    from: r.currentNodeId,
    to: r.previousNodeId,
    commit: r.commitId,
    timestamp: r.timestamp,
  };
}

/**
 * Map bi-temporal TemporalRelation to ChangeTimelineFact.
 */
function mapTemporalToTimeline(r: {
  valid_from: string;
  valid_to: string | null;
}): ChangeTimelineFact {
  return {
    timestamp: r.valid_from,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  };
}

// ─── Main Function ────────────────────────────────────────────────

/**
 * Gather all evolution facts for a code symbol.
 *
 * Executes 5 graph queries in parallel and maps the results into a
 * single EvolutionFacts object.
 *
 * @param projectId  — the project scope (for isolation)
 * @param nodeId     — the code symbol to analyze
 * @param graphStore — any IGraphStore implementation
 * @returns aggregated evolution facts (empty arrays if node has no data)
 */
export async function gatherEvolutionFacts(
  projectId: string,
  nodeId: string,
  graphStore: IGraphStore,
): Promise<EvolutionFacts> {
  // Create bi-temporal query helper (for change timeline)
  const bitemporal = createBitemporalQueries(graphStore);

  // Fetch all time — use far-future range to get all changes
  const FAR_FUTURE = '9999-12-31T23:59:59Z';
  const EPOCH = '1970-01-01T00:00:00Z';

  // Execute all queries in parallel (they are independent)
  const [
    evolvedFromChain,
    commits,
    ownershipInfo,
    coChangedRelations,
    temporalRelations,
  ] = await Promise.all([
    // 1. EVOLVED_FROM chain (symbol lineage)
    findEvolvedFromChain(graphStore, projectId, nodeId),

    // 2. CHANGED_IN edges (commits that touched the node)
    findCommitsByNode(graphStore, projectId, nodeId),

    // 3. AUTHORED_BY (contributors)
    findAuthoredBy(graphStore, projectId, nodeId),

    // 4. CO_CHANGED_WITH (frequently changed together)
    findCoChangedWith(graphStore, projectId, nodeId),

    // 5. Bi-temporal change timeline (from P1)
    bitemporal.findChangesBetween(projectId, nodeId, EPOCH, FAR_FUTURE),
  ]);

  // Map results to EvolutionFacts shape
  return {
    nodeId,
    evolvedFrom: evolvedFromChain.map(mapEvolvedFromToFact),
    changedIn: commits.map(mapCommitToFact),
    authoredBy: ownershipInfo.map(mapOwnershipToFact),
    coChangedWith: coChangedRelations.map(mapCoChangedToFact),
    changeTimeline: temporalRelations.map(mapTemporalToTimeline),
  };
}
