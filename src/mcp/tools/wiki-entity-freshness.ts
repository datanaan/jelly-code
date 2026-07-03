/**
 * MCP Tool: wiki_entity_freshness
 *
 * Reports per-entity freshness for all wiki entities in a project.
 *
 * Wraps WikiService.getFreshness(projectId) which runs the 4-state
 * checkEntityFreshness machine (P0c-T4) for each entity:
 *
 *   fresh    — code signature matches current source code
 *   stale    — code has changed since last compile
 *   orphaned — referenced code symbol no longer exists
 *   unbound  — entity has no code signature binding
 *
 * Optional filters:
 *   status    — one of fresh|stale|orphaned|unbound
 *   entityId  — return only the freshness of this specific entity
 *
 * When filters narrow the result set, the summary is recomputed to
 * reflect only the filtered items (same behavior as the REST API in
 * routes.ts T5).
 *
 * Note: This tool name is "wiki_entity_freshness" — distinct from
 * src/mcp/tools/freshness.ts which is the Project-level freshness
 * utility (addFreshnessWarnings). No naming collision.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WikiService } from "../../wiki/service.js";

const VALID_FRESHNESS_STATES = ["fresh", "stale", "orphaned", "unbound"] as const;

export function registerWikiEntityFreshness(
  server: McpServer,
  wikiService: WikiService,
): void {
  server.registerTool(
    "wiki_entity_freshness",
    {
      description:
        "Get per-entity freshness report for a project's wiki entities. " +
        "Each entity is classified as fresh, stale, orphaned, or unbound " +
        "based on its code signature binding. Optionally filter by status " +
        "or entityId.",
      inputSchema: {
        projectId: z
          .string()
          .describe("Project ID to scope the freshness check to"),
        status: z
          .enum(VALID_FRESHNESS_STATES)
          .optional()
          .describe("Filter results to a specific freshness state"),
        entityId: z
          .string()
          .optional()
          .describe("Filter results to a specific entity ID"),
      },
    },
    async ({ projectId, status, entityId }) => {
      try {
        const report = await wikiService.getFreshness(projectId);

        // Apply optional filters
        let items = report.items;
        if (entityId) {
          items = items.filter((item) => item.entityId === entityId);
        }
        if (status) {
          items = items.filter((item) => item.status === status);
        }

        // Recompute summary for filtered results
        const summary: Record<string, number> = {
          fresh: 0,
          stale: 0,
          orphaned: 0,
          unbound: 0,
        };
        for (const item of items) {
          summary[item.status]++;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  projectId,
                  items,
                  summary,
                  filters: {
                    status: status ?? null,
                    entityId: entityId ?? null,
                  },
                },
                null,
                2,
              ),
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
