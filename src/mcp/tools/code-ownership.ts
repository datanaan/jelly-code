/**
 * MCP Tool: code_ownership
 *
 * Query code ownership data from AUTHORED_BY relations.
 * Supports both node-level (who owns this symbol) and project-level (bus factor) queries.
 * Extended with drift detection and configurable bus factor threshold.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";
import { hasTemporalData } from "../../coupling/hotspot-detector.js";
import { buildOwnership, findExpert } from "../../coupling/ownership-builder.js";
import { calculateEnhancedBusFactor } from "../../lineage/bus-factor.js";
import { detectDrift } from "../../lineage/drift-detector.js";
import { addFreshnessWarnings } from "./freshness.js";

export function registerCodeOwnership(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "code_ownership",
    {
      description:
        "Query code ownership data. If nodeId is provided, returns ownership info and expert for that symbol. If no nodeId, returns project-level bus factor summary. Uses temporal data — results are best-effort when temporalFreshness is stale or partial. Supports drift detection (includeDrift) and configurable bus factor threshold. Requires temporal data (analyze with git history first).",
      inputSchema: {
        projectId: z.string().describe("Project ID to query"),
        nodeId: z.string().optional().describe("Specific node ID to get ownership for"),
        includeDrift: z.boolean().optional().default(false).describe("Include architecture drift report in the response"),
        busFactorThreshold: z.number().optional().default(0.5).describe("Threshold for bus factor calculation (0-1, default 0.5)"),
      },
    },
    async ({ projectId, nodeId, includeDrift, busFactorThreshold }: {
      projectId: string;
      nodeId?: string;
      includeDrift?: boolean;
      busFactorThreshold?: number;
    }) => {
      try {
        // Check if temporal data exists
        const hasData = await hasTemporalData(projectId, stores.graph);
        if (!hasData) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ownership: [],
                  message: "No temporal data. Analyze with git history first.",
                }),
              },
            ],
          };
        }

        const threshold = busFactorThreshold ?? 0.5;

        if (nodeId) {
          // Node-level: ownership + expert for this specific node
          const ownershipMap = await buildOwnership(projectId, stores.graph);
          const owners = ownershipMap.get(nodeId) ?? [];
          const expert = await findExpert(projectId, nodeId, stores.graph);

          const response: Record<string, unknown> = {
            nodeId,
            owners,
            expert,
            totalOwners: owners.length,
          };

          // Include drift report if requested
          if (includeDrift) {
            const driftReport = await detectDrift(projectId, stores.graph);
            response.driftReport = driftReport;
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
        }

        // Project-level: enhanced bus factor summary
        const busFactorResult = await calculateEnhancedBusFactor(projectId, stores.graph, threshold);
        const ownershipMap = await buildOwnership(projectId, stores.graph);

        const response: Record<string, unknown> = {
          busFactor: busFactorResult.busFactor,
          criticalAuthors: busFactorResult.criticalAuthors,
          riskModules: busFactorResult.riskModules,
          threshold: busFactorResult.threshold,
          totalModules: ownershipMap.size,
        };

        // Include drift report if requested
        if (includeDrift) {
          const driftReport = await detectDrift(projectId, stores.graph);
          response.driftReport = driftReport;
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
