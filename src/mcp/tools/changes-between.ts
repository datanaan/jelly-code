/**
 * MCP Tool: changes_between
 *
 * v1.3.0 Phase 2 T2-1 — expose bi-temporal change data to agents.
 *
 * Two query modes:
 *   1. nodeId provided  → findChangesBetween (scoped to one node)
 *   2. nodeId omitted   → projectChangesBetween (project-wide)
 *
 * Returns structured change records with full node details
 * (sourceNode/targetNode), not bare IDs — so agents can reason about
 * what changed without a second lookup.
 *
 * Time params accept ISO 8601 or natural language ("last week", "3 days ago").
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitemporalQueries } from "../../store/neo4j/bitemporal-queries.js";
import { parseNaturalLanguageTime } from "../../store/nl-time-parser.js";

// ─── Response Types ──────────────────────────────────────────────

export interface ChangesBetweenResult {
  changes: Array<{
    sourceNode: { id: string; name: string; type: string };
    targetNode: { id: string; name: string; type: string };
    relationType: string;
    action: 'created' | 'superseded';
    valid_from: string;
    valid_to: string | null;
    commitId?: string;
  }>;
  /**
   * Number of changes returned (after truncation).
   * When truncated=true, the true total exceeds this number.
   * When truncated is absent, this is the exact total (all matches returned).
   */
  totalCount: number;
  timeRange: { from: string; to: string };
  truncated?: boolean;
}

// ─── Registration ────────────────────────────────────────────────

export function registerChangesBetween(
  server: McpServer,
  queries: BitemporalQueries,
): void {
  server.registerTool(
    "changes_between",
    {
      description:
        "Query code/wiki relationship changes within a time range. " +
        "Returns structured change records with source/target node details, " +
        "relation type, action (created/superseded/deleted), and bi-temporal " +
        "metadata (valid_from/valid_to). Supports natural language time " +
        "('last week', '3 days ago') or ISO 8601. When nodeId is omitted, " +
        "queries project-wide changes across CODE_RELATION, DESCRIBES, and " +
        "DOCUMENTED_BY edges. Use relationTypes to filter specific edge types.",
      inputSchema: {
        projectId: z.string().describe("Project ID to scope the query"),
        nodeId: z
          .string()
          .optional()
          .describe("Specific node ID to scope changes to. Omit for project-wide query."),
        fromTime: z
          .string()
          .describe("Start of time range. ISO 8601 timestamp or natural language ('last week', '3 days ago')"),
        toTime: z
          .string()
          .optional()
          .describe("End of time range (default: now). ISO 8601 or natural language"),
        relationTypes: z
          .array(z.string())
          .optional()
          .describe("Filter by relation type (e.g., ['CODE_RELATION', 'DESCRIBES'])"),
        activeOnly: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), only return currently-active edges (valid_to IS NULL)"),
        limit: z
          .number()
          .optional()
          .default(50)
          .describe("Maximum number of changes to return (default 50). Use nodeId for detail when truncated"),
      },
    },
    async (params) => {
      try {
        const fromTime = parseNaturalLanguageTime(params.fromTime);
        const toTime = params.toTime
          ? parseNaturalLanguageTime(params.toTime)
          : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

        const activeOnly = params.activeOnly ?? true;
        const limit = params.limit ?? 50;

        // v1.3.0 self-audit fix: Always use projectChangesBetween for both
        // node-scoped and project-wide queries. This ensures:
        //   1. Cross-domain edges (DESCRIBES/DOCUMENTED_BY) are included (CK-9/CK-10)
        //   2. Full node details (name/type) are returned (CK-6)
        // Previously, node-scoped queries used findChangesBetween which only
        // returned CODE_RELATION edges with bare IDs (no names/types).
        const records = await queries.projectChangesBetween(
          params.projectId,
          fromTime,
          toTime,
          {
            nodeId: params.nodeId,
            relationTypes: params.relationTypes,
            activeOnly,
            limit: limit + 1, // fetch one extra to detect truncation
          },
        );

        // Client-side activeOnly filter as safety net
        const filteredRecords = activeOnly
          ? records.filter(r => r.valid_to === null)
          : records;

        const truncated = filteredRecords.length > limit;
        const limited = filteredRecords.slice(0, limit).map(r => ({
          sourceNode: r.sourceNode,
          targetNode: r.targetNode,
          relationType: r.relationType,
          action: deriveAction(r.valid_to),
          valid_from: r.valid_from,
          valid_to: r.valid_to,
          commitId: r.commitId,
        }));

        const result: ChangesBetweenResult = {
          changes: limited,
          totalCount: limited.length,
          timeRange: { from: fromTime, to: toTime },
          ...(truncated ? { truncated: true } : {}),
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Derive the action label from valid_to status.
 * - valid_to IS NULL     → 'created' (currently active)
 * - valid_to IS NOT NULL → 'superseded' (was active, now replaced)
 *
 * Note: 'deleted' is structurally impossible — hard-deleted edges don't
 * exist in the graph, so they never appear in query results.
 */
function deriveAction(validTo: string | null): 'created' | 'superseded' {
  if (validTo === null) return 'created';
  return 'superseded';
}
