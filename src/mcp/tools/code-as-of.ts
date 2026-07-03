/**
 * MCP Tool: code_as_of
 *
 * Point-in-time query for code node state via bi-temporal search.
 *
 * Wraps BitemporalQueries.findNodeAsOf(projectId, nodeId, time) (P1-T2)
 * to expose "what did this code look like at time T?" queries via MCP.
 *
 * The REST API equivalent is GET /api/code/as-of (P1-T6, code-routes.ts).
 *
 * Input:
 *   projectId — required, project identifier
 *   nodeId    — required, node identifier
 *   time      — required, ISO 8601 timestamp for point-in-time query
 *   format    — optional, "full" (default) or "diff"
 *
 * Output (full):
 *   { projectId, nodeId, time, node, relations }
 *
 * Output (diff):
 *   Same as full, plus:
 *   { format: "diff", diff: { added: relations, removed: [] } }
 *
 * Pattern follows wiki-entity-freshness.ts (P0c-T7).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitemporalQueries } from "../../store/neo4j/bitemporal-queries.js";

export function registerCodeAsOf(
  server: McpServer,
  queries: BitemporalQueries,
): void {
  server.registerTool(
    "code_as_of",
    {
      description:
        "Query the state of a code node at a specific point in time (as-of query). " +
        "Returns the node and its valid relations at the given timestamp using " +
        "bi-temporal data. Useful for 'what did this code look like on date X?' " +
        "questions. Optionally use format='diff' for a change-diff representation.",
      inputSchema: {
        projectId: z
          .string()
          .describe("Project ID to scope the query to"),
        nodeId: z
          .string()
          .describe("Node identifier to query"),
        time: z
          .string()
          .describe("ISO 8601 timestamp for the point-in-time query (e.g., '2026-06-01T00:00:00Z')"),
        format: z
          .enum(["full", "diff"])
          .optional()
          .describe("Output format: 'full' (default) returns node + relations; 'diff' adds a change-diff representation"),
      },
    },
    async ({ projectId, nodeId, time, format }) => {
      try {
        const result = await queries.findNodeAsOf(projectId, nodeId, time);

        const response: Record<string, unknown> = {
          projectId,
          nodeId,
          time,
          node: result.node,
          relations: result.relations,
        };

        // format=diff: add change-diff representation
        // At point-in-time T, "added" = relations valid at T, "removed" = empty
        // (the query already filters to only valid-at-T relations)
        if (format === "diff") {
          response.format = "diff";
          response.diff = {
            added: result.relations,
            removed: [],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
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
