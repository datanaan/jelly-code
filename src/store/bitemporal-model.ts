/**
 * Bi-temporal data model and query builder.
 *
 * Bi-temporal modeling tracks two independent time axes:
 *
 *   valid_time (valid_from / valid_to):
 *     When a code fact was true in the real world.
 *     Example: function `foo()` existed from commit A (2026-01-01) until
 *     it was renamed in commit B (2026-06-15).  valid_to = NULL means
 *     the fact is currently true.
 *
 *   transaction_time (txn_from / txn_to):
 *     When we recorded or overwrote this fact in the graph.
 *     This lets us reconstruct what the graph looked like at any past
 *     indexing point — useful for auditing and time-travel debugging.
 *
 * Backward compatibility (spec principle 5):
 *   Old edges that predate bi-temporal attrs are treated as
 *   valid_from = EPOCH, valid_to = NULL (always valid).
 *   No forced migration needed.
 *
 * Cypher convention:
 *   - valid_from is compared directly (legacy edges without this attr
 *     are handled via coalesce at the Neo4j layer in T2)
 *   - valid_to uses coalesce(valid_to, '9999-12-31T23:59:59Z') inline
 *     so that NULL (currently valid) edges compare correctly
 *   - current() uses the simpler `valid_to IS NULL` which naturally
 *     matches both new bi-temporal edges and legacy edges (both have
 *     NULL valid_to)
 */

// ─── Constants ────────────────────────────────────────────────────

/** Earliest representable time — fallback for edges without valid_from. */
export const EPOCH = '1970-01-01T00:00:00Z';

/** Sentinel "far future" timestamp — fallback for edges with NULL valid_to. */
export const FAR_FUTURE = '9999-12-31T23:59:59Z';

// ─── Types ────────────────────────────────────────────────────────

/**
 * Bi-temporal relation attributes attached to graph edges.
 *
 * Both axes use the "[from, to)" half-open interval convention:
 *   - `from` is inclusive (the fact became true at or after this time)
 *   - `to` is exclusive and nullable (NULL = still current)
 */
export interface BiTemporalRelation {
  /** When the code fact became true (commit time). */
  valid_from: string;
  /** When the fact was superseded. NULL = currently valid. */
  valid_to: string | null;
  /** When we indexed this fact into the graph. */
  txn_from: string;
  /** When we overwrote/corrected this record. NULL = current view. */
  txn_to: string | null;
}

/** A Cypher fragment with its bind parameters. */
export interface CypherFragment {
  cypher: string;
  params: Record<string, unknown>;
}

// ─── Query Builder ────────────────────────────────────────────────

/**
 * Static query builder for bi-temporal Cypher fragments.
 *
 * Each method returns a WHERE-clause fragment + params that can be
 * dropped into a larger Cypher query.  Fragments use inline
 * coalesce() for valid_to so that NULL (currently valid) edges
 * are handled correctly without requiring a parameter.
 *
 * Usage:
 *   const frag = BiTemporalQuery.asOf('2026-06-01T00:00:00Z');
 *   const results = await graph.query(
 *     `MATCH (n)-[r]->(m) WHERE ${frag.cypher} RETURN n, r, m`,
 *     frag.params,
 *   );
 */
export class BiTemporalQuery {
  /**
   * Point-in-time query on the valid_time axis.
   *
   * Returns facts that were valid at the given moment:
   *   valid_from <= time AND coalesce(valid_to, '9999-12-31T23:59:59Z') > time
   *
   * The coalesce on valid_to handles edges with NULL valid_to
   * (currently valid) by treating them as extending to far future.
   */
  static asOf(time: string): CypherFragment {
    return {
      cypher: `valid_from <= $queryTime AND coalesce(valid_to, '${FAR_FUTURE}') > $queryTime`,
      params: {
        queryTime: time,
      },
    };
  }

  /**
   * Query for currently valid facts (valid_to IS NULL).
   *
   * This naturally matches both:
   *   - Bi-temporal edges explicitly set to valid_to = NULL
   *   - Legacy edges that never had valid_to set (also NULL)
   */
  static current(): CypherFragment {
    return {
      cypher: 'valid_to IS NULL',
      params: {},
    };
  }

  /**
   * Range query on the valid_time axis.
   *
   * Returns facts whose valid period falls within [fromTime, toTime]:
   *   valid_from >= fromTime AND coalesce(valid_to, '9999-12-31T23:59:59Z') <= toTime
   */
  static range(fromTime: string, toTime: string): CypherFragment {
    return {
      cypher: `valid_from >= $fromTime AND coalesce(valid_to, '${FAR_FUTURE}') <= $toTime`,
      params: {
        fromTime,
        toTime,
      },
    };
  }

  /**
   * Point-in-time query on the transaction_time axis.
   *
   * Returns facts as the graph recorded them at the given moment:
   *   txn_from <= time AND coalesce(txn_to, '9999-12-31T23:59:59Z') > time
   */
  static asOfTxn(time: string): CypherFragment {
    return {
      cypher: `txn_from <= $txnTime AND coalesce(txn_to, '${FAR_FUTURE}') > $txnTime`,
      params: {
        txnTime: time,
      },
    };
  }

  /**
   * Combined valid_time + transaction_time point query.
   *
   * Useful for "what did we know at txnTime about the state of the
   * code at validTime?"
   */
  static combined(validTime: string, txnTime: string): CypherFragment {
    return {
      cypher: [
        `valid_from <= $queryTime AND coalesce(valid_to, '${FAR_FUTURE}') > $queryTime`,
        `AND txn_from <= $txnTime AND coalesce(txn_to, '${FAR_FUTURE}') > $txnTime`,
      ].join(' '),
      params: {
        queryTime: validTime,
        txnTime,
      },
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Check whether a relation is (or was) valid at the given query time.
 *
 * @param rel  — the bi-temporal relation
 * @param asOf — optional query time; if omitted, checks current validity
 * @returns true if the relation is valid at the given time (or now)
 */
export function isCurrentlyValid(
  rel: BiTemporalRelation,
  asOf?: string,
): boolean {
  if (asOf === undefined) {
    return rel.valid_to === null;
  }
  // valid_from <= asOf AND coalesce(valid_to, FAR_FUTURE) > asOf
  const validFrom = rel.valid_from ?? EPOCH;
  const validTo = rel.valid_to ?? FAR_FUTURE;
  return validFrom <= asOf && validTo > asOf;
}

/**
 * Supersede a relation: close the old one and create its successor.
 *
 * This is the core operation for incremental updates — when a code fact
 * changes, the old relation is closed (valid_to set to supersedeTime)
 * and a new relation is created starting at supersedeTime.
 *
 * @param oldRel         — the relation being superseded
 * @param supersedeTime  — valid_time when the new fact took effect (commit time)
 * @param txnTime        — transaction_time of this update (default: now)
 * @returns `{ old, next }` — the closed old relation and the new relation
 */
export function supersedeRelation(
  oldRel: BiTemporalRelation,
  supersedeTime: string,
  txnTime: string = new Date().toISOString(),
): { old: BiTemporalRelation; next: BiTemporalRelation } {
  return {
    // Close the old relation: set valid_to and txn_to
    old: {
      ...oldRel,
      valid_to: supersedeTime,
      txn_to: txnTime,
    },
    // Create the new relation starting at supersedeTime
    next: {
      valid_from: supersedeTime,
      valid_to: null,
      txn_from: txnTime,
      txn_to: null,
    },
  };
}
