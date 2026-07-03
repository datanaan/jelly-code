/**
 * Freshness utility for MCP tools.
 *
 * Queries the Project node's freshness fields (symbolsFreshness,
 * communitiesFreshness, temporalFreshness) and appends a `_warnings`
 * array to the response data when any dimension is stale.
 *
 * This is non-fatal — if the query fails, the original data is returned
 * unchanged.
 */
import type { IGraphStore } from '../../store/interfaces.js';

/**
 * Add freshness warnings to a response object.
 * Mutates `data` in-place by appending `data._warnings` when stale.
 */
export async function addFreshnessWarnings(
  projectId: string,
  graphStore: IGraphStore,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const freshness = await graphStore.query(
      `MATCH (p:Project {id: $projectId})
       RETURN p.symbolsFreshness AS sf,
              p.communitiesFreshness AS cf,
              p.temporalFreshness AS tf`,
      { projectId },
    );
    const f = freshness[0] as
      | { sf?: string; cf?: string; tf?: string }
      | undefined;
    const warnings: string[] = [];
    if (f?.cf && f.cf !== 'fresh')
      warnings.push(`communitiesFreshness=${f.cf}`);
    if (f?.tf && f.tf !== 'fresh')
      warnings.push(`temporalFreshness=${f.tf}`);
    if (warnings.length > 0) {
      data._warnings = warnings;
    }
  } catch {
    // Non-fatal: don't break the query for freshness info
  }
}
