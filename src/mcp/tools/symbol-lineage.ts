/**
 * MCP Tool: symbol_lineage
 *
 * Trace the rename/move history of a code symbol via EVOLVED_FROM chain.
 * Returns the full lineage (origin to current), or a single-element lineage
 * with a hint when no EVOLVED_FROM data exists.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";
import { traceLineage } from "../../lineage/lineage-tracker.js";
import { addFreshnessWarnings } from "./freshness.js";

export function registerSymbolLineage(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "symbol_lineage",
    {
      description:
        "Trace the rename/move history of a code symbol. Follows EVOLVED_FROM relations to show how a symbol evolved over time (renames, moves, splits, merges). Uses temporal data — lineage may be incomplete when temporalFreshness is stale or partial. Returns single-element lineage with a hint if no evolution history exists.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        nodeId: z.string().describe("Node ID of the symbol to trace"),
      },
    },
    async ({ projectId, nodeId }: { projectId: string; nodeId: string }) => {
      try {
        const lineage = await traceLineage(projectId, nodeId, stores.graph);

        // Build response
        const response: Record<string, unknown> = {
          currentId: lineage.currentId,
          originId: lineage.originId,
          historyLength: lineage.history.length,
          history: lineage.history,
        };

        // No EVOLVED_FROM data: provide a helpful hint
        if (lineage.history.length === 0) {
          response.hint = "No EVOLVED_FROM relations found. The symbol has no recorded rename/move history. Ensure git history analysis has been run to populate lineage data.";
        }

        await addFreshnessWarnings(projectId, stores.graph, response);

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
          content: [{ type: "text" as const, text: JSON.stringify({ error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
