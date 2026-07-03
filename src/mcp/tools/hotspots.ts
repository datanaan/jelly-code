/**
 * MCP Tool: hotspots
 *
 * Identify frequently-changed code symbols (hotspots) from temporal data.
 * Returns nodes ranked by change frequency with risk classification.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";
import { detectHotspots, hasTemporalData } from "../../coupling/hotspot-detector.js";
import { addFreshnessWarnings } from "./freshness.js";

export function registerHotspots(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "hotspots",
    {
      description:
        "Identify frequently-changed code symbols (hotspots) from git history. Uses temporal data — results are best-effort when temporalFreshness is stale or partial. Returns nodes ranked by change frequency with risk classification (high/medium/low). Requires temporal data (analyze with git history first).",
      inputSchema: {
        projectId: z.string().describe("Project ID to analyze"),
        riskLevel: z.enum(["high", "medium", "low"]).optional().describe("Filter by risk level"),
        limit: z.number().optional().default(20).describe("Maximum number of results (default 20)"),
      },
    },
    async ({ projectId, riskLevel, limit }: { projectId: string; riskLevel?: "high" | "medium" | "low"; limit?: number }) => {
      try {
        // Check if temporal data exists
        const hasData = await hasTemporalData(projectId, stores.graph);
        if (!hasData) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  hotspots: [],
                  message: "No temporal data. Analyze with git history first.",
                }),
              },
            ],
          };
        }

        const hotspots = await detectHotspots(projectId, stores.graph);

        // Filter by riskLevel if provided
        const filtered = riskLevel
          ? hotspots.filter((h) => h.riskLevel === riskLevel)
          : hotspots;

        // Limit results
        const limited = filtered.slice(0, limit ?? 20);

        const responseData: Record<string, unknown> = {
          hotspots: limited,
          total: hotspots.length,
          filteredBy: riskLevel ?? null,
        };
        await addFreshnessWarnings(projectId, stores.graph, responseData);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(responseData, null, 2),
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
