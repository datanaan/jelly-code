/**
 * Archive & TTL for bi-temporal edges.
 *
 * Approach A (Soft archive): Adds `archived = true` flag to superseded
 * edges whose valid_to is older than retentionDays. Data is NOT deleted;
 * asOf queries still find archived edges via bi-temporal filters.
 *
 * Design:
 *   - Only edges with valid_to IS NOT NULL (superseded) are candidates
 *   - Only edges with valid_to < (now - retentionDays) are archived
 *   - Only edges without archived = true (idempotent)
 *   - Currently valid edges (valid_to IS NULL) are never archived
 *
 * Scheduler integration:
 *   - Registered as a weekly job in IncrementalScheduler
 *   - retentionDays is configurable via AppConfig.bitemporal.retentionDays
 *
 * Usage:
 *   import { archiveOldVersions } from './archive.js';
 *   const { archived } = await archiveOldVersions(graphStore, 90);
 */

import type { IGraphStore } from './interfaces.js';

/** Default retention period in days. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Result of an archive run. */
export interface ArchiveResult {
  /** Number of edges flagged as archived. */
  archived: number;
}

/**
 * Archive (soft-flag) superseded bi-temporal edges older than retentionDays.
 *
 * Criteria for archiving:
 *   1. valid_to IS NOT NULL (edge has been superseded)
 *   2. valid_to < cutoff (edge was superseded more than retentionDays ago)
 *   3. archived IS NULL OR archived <> true (not already archived — idempotent)
 *
 * Effect:
 *   Sets `archived = true` on matching edges. Does NOT delete or move them.
 *   asOf queries still find these edges because they filter on valid_from/valid_to,
 *   not on the archived flag.
 *
 * @param graphStore     — any IGraphStore (Neo4j in production)
 * @param retentionDays  — how long to keep superseded edges before archiving.
 *                         Defaults to 90 days if omitted.
 * @returns count of edges archived in this run
 */
export async function archiveOldVersions(
  graphStore: IGraphStore,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<ArchiveResult> {
  // Compute cutoff timestamp: now - retentionDays
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();

  const results = await graphStore.query(
    `MATCH ()-[r:CODE_RELATION]->()
     WHERE r.valid_to IS NOT NULL
       AND r.valid_to < $cutoff
       AND (r.archived IS NULL OR r.archived <> true)
     SET r.archived = true
     RETURN count(r) AS archived`,
    { cutoff },
  );

  const archived = results.length > 0
    ? toNumber(results[0].archived)
    : 0;

  return { archived };
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
