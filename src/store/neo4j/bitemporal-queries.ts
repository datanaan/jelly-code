/**
 * Bi-temporal Neo4j query functions.
 *
 * Implements point-in-time, range, and supersede queries using the
 * BiTemporalQuery fragments from T1 (bitemporal-model.ts).
 *
 * Design:
 *   - Functions accept any IGraphStore (same pattern as temporal-queries.ts)
 *   - All Cypher is parameterized (no string concatenation of user input)
 *   - Uses BiTemporalQuery fragments for the bi-temporal WHERE clauses
 *   - Backward compatible: legacy edges (no bi-temporal attrs) are
 *     treated as valid_from = EPOCH, valid_to = NULL via coalesce()
 *
 * Usage:
 *   const queries = createBitemporalQueries(graphStore);
 *   const { node, relations } = await queries.findNodeAsOf(
 *     'proj-1', 'node-1', '2026-06-01T00:00:00Z'
 *   );
 */

import type { IGraphStore } from '../interfaces.js';
import type { CodeNode } from '../interfaces.js';
import {
  EPOCH,
  FAR_FUTURE,
  type BiTemporalRelation,
} from '../bitemporal-model.js';

// ─── Types ────────────────────────────────────────────────────────

/** A relation with bi-temporal metadata, mapped from Neo4j results. */
export interface TemporalRelation extends BiTemporalRelation {
  sourceId: string;
  targetId: string;
  type: string;
  confidence?: number;
  reason?: string;
}

/** Result of findNodeAsOf: the node plus its valid relations at time T. */
export interface NodeAsOfResult {
  node: CodeNode | null;
  relations: TemporalRelation[];
}

/** Result of supersedeRelation: whether the supersede was performed. */
export interface SupersedeResult {
  superseded: boolean;
}

// ─── Query Interface ──────────────────────────────────────────────

/** Bi-temporal query operations on a graph store. */
export interface BitemporalQueries {
  /** Find a node and its valid relations at a point in time. */
  findNodeAsOf(projectId: string, nodeId: string, time: string): Promise<NodeAsOfResult>;

  /** Find relations of a node that were valid at a point in time. */
  findRelationsAsOf(
    projectId: string,
    nodeId: string,
    time: string,
    relType?: string,
  ): Promise<TemporalRelation[]>;

  /** Find changes (new or modified relations) in a valid_time range. */
  findChangesBetween(
    projectId: string,
    nodeId: string,
    fromTime: string,
    toTime: string,
  ): Promise<TemporalRelation[]>;

  /** Atomically close an old relation and create its successor. */
  supersedeRelation(
    projectId: string,
    oldRelKey: string,
    supersedeTime: string,
    newRelation: BiTemporalRelation & { sourceId: string; targetId: string; type: string },
    txnTime?: string,
  ): Promise<SupersedeResult>;

  /**
   * v1.3.0 Phase 1 T1-6: Close all active cross-domain edges
   * (DESCRIBES + DOCUMENTED_BY) incident to a CodeNode that is being
   * superseded during incremental analysis.
   *
   * Sets valid_to + txn_to on currently-active (valid_to IS NULL) edges,
   * preserving bi-temporal history of which WikiEntity documented which
   * CodeNode and when that documentation link ended.
   *
   * Call this BEFORE deleting/replacing a CodeNode so the edge history
   * is preserved (DETACH DELETE would hard-delete edges, losing history).
   *
   * @returns count of closed DESCRIBES + DOCUMENTED_BY edges
   */
  closeCrossDomainEdgesForNode(
    projectId: string,
    nodeId: string,
    supersedeTime?: string,
    txnTime?: string,
  ): Promise<number>;

  /**
   * v1.3.0 Phase 2 T2-1: Find all relation changes in a project within a
   * valid_time range — project-level (no specific nodeId required).
   *
   * v1.3.0 self-audit fix: Added optional nodeId parameter so node-scoped
   * queries also benefit from cross-domain edge support (DESCRIBES/
   * DOCUMENTED_BY). Previously, node-scoped queries used findChangesBetween
   * which only matched CODE_RELATION edges.
   *
   * Queries ALL relationships: CODE_RELATION, DESCRIBES,
   * DOCUMENTED_BY, etc. — anything with valid_from in the time window.
   *
   * Returns structured change records with source/target node details,
   * suitable for the `changes_between` MCP tool response.
   */
  projectChangesBetween(
    projectId: string,
    fromTime: string,
    toTime: string,
    options?: {
      nodeId?: string;
      relationTypes?: string[];
      activeOnly?: boolean;
      limit?: number;
    },
  ): Promise<ProjectChangeRecord[]>;
}

/**
 * v1.3.0 Phase 2 T2-1: A single change record in projectChangesBetween.
 * Captures both node endpoints and the relation's bi-temporal metadata.
 */
export interface ProjectChangeRecord {
  sourceNode: { id: string; name: string; type: string };
  targetNode: { id: string; name: string; type: string };
  relationType: string;
  valid_from: string;
  valid_to: string | null;
  commitId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Build a Cypher WHERE fragment for point-in-time valid_time query,
 * adapted from T1's BiTemporalQuery.asOf() for the relation variable `r`.
 *
 * T1's fragment: `valid_from <= $queryTime AND coalesce(valid_to, FAR_FUTURE) > $queryTime`
 *
 * T2 adaptation adds:
 *   - `r.` prefix for the relation variable in Cypher
 *   - coalesce on valid_from for backward compat with legacy edges
 *     (legacy edges missing valid_from are treated as EPOCH = always valid)
 *
 * Result:
 *   coalesce(r.valid_from, EPOCH) <= $queryTime
 *   AND coalesce(r.valid_to, FAR_FUTURE) > $queryTime
 *
 * Note: T1's BiTemporalQuery.asOf() returns the same $queryTime param name,
 * ensuring param consistency between T1 fragments and T2 queries.
 */
function asOfFragment(): string {
  return [
    `coalesce(r.valid_from, '${EPOCH}') <= $queryTime`,
    `AND coalesce(r.valid_to, '${FAR_FUTURE}') > $queryTime`,
  ].join(' ');
}

/**
 * Convert Neo4j integer or unknown to JS number.
 */
function toNumber(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && 'toNumber' in (val as object)) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return Number(val);
}

/**
 * Unwrap a Neo4j Node object to its properties dict.
 */
function unwrapNode(obj: unknown): Record<string, unknown> {
  if (obj !== null && typeof obj === 'object' && 'properties' in (obj as object)) {
    const props = (obj as { properties: unknown }).properties;
    if (props !== null && typeof props === 'object') {
      return props as Record<string, unknown>;
    }
  }
  return (obj as Record<string, unknown>) ?? {};
}

/**
 * Map a Neo4j relation property row to a TemporalRelation.
 */
function mapTemporalRelation(row: Record<string, unknown>): TemporalRelation {
  return {
    sourceId: row.sourceId as string,
    targetId: row.targetId as string,
    type: row.type as string,
    confidence: row.confidence != null ? toNumber(row.confidence) : undefined,
    reason: (row.reason as string) || undefined,
    valid_from: (row.valid_from as string) ?? EPOCH,
    valid_to: (row.valid_to as string) ?? null,
    txn_from: (row.txn_from as string) ?? EPOCH,
    txn_to: (row.txn_to as string) ?? null,
  };
}

// ─── Factory ──────────────────────────────────────────────────────

/**
 * Create a BitemporalQueries instance bound to a graph store.
 *
 * All methods use `graphStore.query()` with parameterized Cypher.
 */
export function createBitemporalQueries(graphStore: IGraphStore): BitemporalQueries {
  return {
    // ================================================================
    // findNodeAsOf
    // ================================================================
    async findNodeAsOf(
      projectId: string,
      nodeId: string,
      time: string,
    ): Promise<NodeAsOfResult> {
      const asOf = asOfFragment();
      const results = await graphStore.query(
        `MATCH (n {id: $nodeId, projectId: $projectId})
         OPTIONAL MATCH (n)-[r:CODE_RELATION]-(m)
         WHERE ${asOf}
         RETURN n,
                collect({
                  sourceId: coalesce(r.sourceId, n.id),
                  targetId: coalesce(r.targetId, m.id),
                  type: r.type,
                  confidence: r.confidence,
                  reason: r.reason,
                  valid_from: r.valid_from,
                  valid_to: r.valid_to,
                  txn_from: r.txn_from,
                  txn_to: r.txn_to
                }) AS rels`,
        { projectId, nodeId, queryTime: time },
      );

      if (results.length === 0) {
        return { node: null, relations: [] };
      }

      const row = results[0];
      const nodeProps = unwrapNode(row.n);
      const node: CodeNode = {
        id: nodeProps.id as string,
        type: nodeProps.type as string,
        projectId: nodeProps.projectId as string,
        name: nodeProps.name as string,
        filePath: nodeProps.filePath as string,
        startLine: nodeProps.startLine != null ? toNumber(nodeProps.startLine) : undefined,
        endLine: nodeProps.endLine != null ? toNumber(nodeProps.endLine) : undefined,
        isExported: nodeProps.isExported as boolean | undefined,
        content: nodeProps.content as string | undefined,
        description: nodeProps.description as string | undefined,
      };

      const relRows = (row.rels as Array<Record<string, unknown>>).filter(
        r => r.type !== null,
      );
      const relations = relRows.map(mapTemporalRelation);

      return { node, relations };
    },

    // ================================================================
    // findRelationsAsOf
    // ================================================================
    async findRelationsAsOf(
      projectId: string,
      nodeId: string,
      time: string,
      relType?: string,
    ): Promise<TemporalRelation[]> {
      const asOf = asOfFragment();
      const typeFilter = relType
        ? 'AND r.type = $relType'
        : '';

      const results = await graphStore.query(
        `MATCH (n {id: $nodeId, projectId: $projectId})
         MATCH (n)-[r:CODE_RELATION]-(m)
         WHERE m.projectId = $projectId
           ${typeFilter}
           AND ${asOf}
         RETURN coalesce(r.sourceId, n.id) AS sourceId,
                coalesce(r.targetId, m.id) AS targetId,
                r.type AS type,
                r.confidence AS confidence,
                r.reason AS reason,
                r.valid_from AS valid_from,
                r.valid_to AS valid_to,
                r.txn_from AS txn_from,
                r.txn_to AS txn_to`,
        { projectId, nodeId, queryTime: time, ...(relType ? { relType } : {}) },
      );

      return results.map(mapTemporalRelation);
    },

    // ================================================================
    // findChangesBetween
    // ================================================================
    async findChangesBetween(
      projectId: string,
      nodeId: string,
      fromTime: string,
      toTime: string,
    ): Promise<TemporalRelation[]> {
      // Changes are relations whose valid_from falls in (from, to]
      // Using coalesce for backward compat (legacy edges treated as epoch)
      const results = await graphStore.query(
        `MATCH (n {id: $nodeId, projectId: $projectId})
         MATCH (n)-[r:CODE_RELATION]-(m)
         WHERE m.projectId = $projectId
           AND coalesce(r.valid_from, '${EPOCH}') > $fromTime
           AND coalesce(r.valid_from, '${EPOCH}') <= $toTime
         RETURN coalesce(r.sourceId, n.id) AS sourceId,
                coalesce(r.targetId, m.id) AS targetId,
                r.type AS type,
                r.confidence AS confidence,
                r.reason AS reason,
                r.valid_from AS valid_from,
                r.valid_to AS valid_to,
                r.txn_from AS txn_from,
                r.txn_to AS txn_to`,
        { projectId, nodeId, fromTime, toTime },
      );

      return results.map(mapTemporalRelation);
    },

    // ================================================================
    // supersedeRelation
    // ================================================================
    async supersedeRelation(
      projectId: string,
      oldRelKey: string,
      supersedeTime: string,
      newRelation: BiTemporalRelation & { sourceId: string; targetId: string; type: string },
      txnTime: string = new Date().toISOString(),
    ): Promise<SupersedeResult> {
      // Atomic supersede: close old relation + create new in a single query.
      //
      // The oldRelKey is a composite "sourceId-type-targetId" identifier.
      // However, node IDs may contain dashes (e.g., "e2e-p1-123:Function:foo"),
      // making split('-') unreliable for parsing. Instead, we use the
      // newRelation's sourceId/targetId/type to identify the old relation,
      // since a supersede replaces a relation between the same pair with
      // the same type.
      //
      // Cypher strategy:
      //   1. MATCH the old currently-valid relation (valid_to IS NULL)
      //   2. SET valid_to = supersedeTime, txn_to = txnTime (close it)
      //   3. CREATE the new relation with bi-temporal attrs
      //   4. Return count of closed relations

      const newRelProps = {
        sourceId: newRelation.sourceId,
        targetId: newRelation.targetId,
        type: newRelation.type,
        valid_from: newRelation.valid_from,
        valid_to: newRelation.valid_to,
        txn_from: newRelation.txn_from,
        txn_to: newRelation.txn_to,
      };

      const results = await graphStore.query(
        `MATCH (a {projectId: $projectId})-[r:CODE_RELATION {sourceId: $sourceId, targetId: $targetId, type: $type}]->(b {projectId: $projectId})
         WHERE r.valid_to IS NULL
         SET r.valid_to = $supersedeTime, r.txn_to = $txnTime
         WITH a, b, count(r) AS closed
         CREATE (a)-[nr:CODE_RELATION $newRel]->(b)
         RETURN closed, count(nr) AS created`,
        {
          projectId,
          sourceId: newRelation.sourceId,
          targetId: newRelation.targetId,
          type: newRelation.type,
          supersedeTime,
          txnTime,
          newRel: newRelProps,
        },
      );

      const closed = results.length > 0 ? toNumber(results[0].closed) : 0;
      return { superseded: closed > 0 };
    },

    // ================================================================
    // closeCrossDomainEdgesForNode (v1.3.0 Phase 1 T1-6)
    // ================================================================
    async closeCrossDomainEdgesForNode(
      projectId: string,
      nodeId: string,
      supersedeTime: string = new Date().toISOString(),
      txnTime: string = new Date().toISOString(),
    ): Promise<number> {
      // Close active DESCRIBES edges: (WikiEntity)-[:DESCRIBES]->(node)
      // Close active DOCUMENTED_BY edges: (node)-[:DOCUMENTED_BY]->(WikiEntity)
      //
      // Both edge types are closed in a single query for atomicity.
      // valid_to/txn_to are only set on currently-active edges (valid_to IS NULL),
      // so re-calling this method is a no-op (idempotent).
      const results = await graphStore.query(
        `MATCH (e:WikiEntity)-[d:DESCRIBES {projectId: $projectId}]->(n {id: $nodeId, projectId: $projectId})
         WHERE d.valid_to IS NULL
         SET d.valid_to = $supersedeTime, d.txn_to = $txnTime
         WITH e, count(d) AS closedDescribes
         MATCH (n2 {id: $nodeId, projectId: $projectId})-[db:DOCUMENTED_BY {projectId: $projectId}]->(e)
         WHERE db.valid_to IS NULL
         SET db.valid_to = $supersedeTime, db.txn_to = $txnTime
         RETURN closedDescribes, count(db) AS closedDocumentedBy`,
        { projectId, nodeId, supersedeTime, txnTime },
      );

      if (results.length === 0) return 0;
      const r = results[0];
      const closedDescribes = toNumber(r.closedDescribes);
      const closedDocumentedBy = toNumber(r.closedDocumentedBy);
      return closedDescribes + closedDocumentedBy;
    },

    // ================================================================
    // projectChangesBetween (v1.3.0 Phase 2 T2-1)
    // ================================================================
    async projectChangesBetween(
      projectId: string,
      fromTime: string,
      toTime: string,
      options?: {
        nodeId?: string;
        relationTypes?: string[];
        activeOnly?: boolean;
        limit?: number;
      },
    ): Promise<ProjectChangeRecord[]> {
      // Query ALL relationship types in the project, not just CODE_RELATION.
      // This includes CODE_RELATION, DESCRIBES, DOCUMENTED_BY, and any other
      // typed edge that carries valid_from/valid_to bi-temporal metadata.
      //
      // v1.3.0 self-audit fix: When nodeId is provided, scope to that node
      // (both outgoing and incoming edges) while still querying all edge types.
      const nodeFilter = options?.nodeId
        ? `AND (n.id = $nodeId OR m.id = $nodeId)`
        : '';

      const relTypeFilter = options?.relationTypes && options.relationTypes.length > 0
        ? `AND type(r) IN $relationTypes`
        : `AND (type(r) = 'CODE_RELATION' OR type(r) = 'DESCRIBES' OR type(r) = 'DOCUMENTED_BY')`;

      const activeFilter = options?.activeOnly
        ? `AND r.valid_to IS NULL`
        : '';

      const limitClause = options?.limit
        ? `LIMIT ${options.limit}`
        : '';

      const results = await graphStore.query(
        `MATCH (n {projectId: $projectId})-[r]->(m {projectId: $projectId})
         WHERE coalesce(r.valid_from, '${EPOCH}') > $fromTime
           AND coalesce(r.valid_from, '${EPOCH}') <= $toTime
           ${nodeFilter}
           ${relTypeFilter}
           ${activeFilter}
         RETURN n.id AS sourceId, n.name AS sourceName, n.type AS sourceType,
                m.id AS targetId, m.name AS targetName, m.type AS targetType,
                type(r) AS relationType,
                coalesce(r.valid_from, '${EPOCH}') AS valid_from,
                r.valid_to AS valid_to,
                r.commitId AS commitId
         ORDER BY valid_from DESC
         ${limitClause}`,
        {
          projectId,
          fromTime,
          toTime,
          ...(options?.nodeId ? { nodeId: options.nodeId } : {}),
          ...(options?.relationTypes && options.relationTypes.length > 0
            ? { relationTypes: options.relationTypes }
            : {}),
        },
      );

      return results.map(r => ({
        sourceNode: {
          id: r.sourceId as string,
          name: (r.sourceName as string) ?? '',
          type: (r.sourceType as string) ?? '',
        },
        targetNode: {
          id: r.targetId as string,
          name: (r.targetName as string) ?? '',
          type: (r.targetType as string) ?? '',
        },
        relationType: r.relationType as string,
        valid_from: r.valid_from as string,
        valid_to: (r.valid_to as string | null) ?? null,
        commitId: (r.commitId as string | undefined) ?? undefined,
      }));
    },
  };
}
