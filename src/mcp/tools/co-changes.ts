/**
 * MCP Tool: co_changes
 *
 * Query co-change coupling data from CO_CHANGED_WITH relations.
 * Supports both node-level (what changes with this symbol) and project-level queries.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";
import { hasTemporalData } from "../../coupling/hotspot-detector.js";
import { addFreshnessWarnings } from "./freshness.js";

export function registerCoChanges(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "co_changes",
    {
      description:
        "Query co-change coupling data. If nodeId is provided, returns symbols that frequently change together with this one. If no nodeId, returns top co-change pairs for the project. Uses temporal data — results are best-effort when temporalFreshness is stale or partial. Requires temporal data (analyze with git history first).",
      inputSchema: {
        projectId: z.string().describe("Project ID to query"),
        nodeId: z.string().optional().describe("Specific node ID to get co-changes for"),
        minSupport: z.number().optional().default(0.05).describe("Minimum support threshold (default 0.05)"),
        topN: z.number().optional().default(50).describe("Maximum number of results (default 50)"),
      },
    },
    async ({ projectId, nodeId, minSupport, topN }: { projectId: string; nodeId?: string; minSupport?: number; topN?: number }) => {
      try {
        // Check if temporal data exists
        const hasData = await hasTemporalData(projectId, stores.graph);
        if (!hasData) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  coChanges: [],
                  message: "No temporal data. Analyze with git history first.",
                }),
              },
            ],
          };
        }

        const supportThreshold = minSupport ?? 0.05;
        const limit = topN ?? 50;

        if (nodeId) {
          // Node-level: query CO_CHANGED_WITH for this specific node
          const results = await stores.graph.query(
            `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]->(target {projectId: $projectId})
             RETURN target.id AS nodeId, target.name AS name, target.type AS type, target.filePath AS filePath,
                    r.support AS support, r.confidence AS confidence, r.lift AS lift, r.coChangeCount AS coChangeCount
             ORDER BY r.confidence DESC`,
            { projectId, nodeId },
          );

          const filtered = results
            .filter((row) => {
              const support = typeof row.support === "number" ? row.support : Number(row.support);
              return support >= supportThreshold;
            })
            .slice(0, limit);

          const responseData: Record<string, unknown> = {
            nodeId,
            coChanges: filtered.map((row) => ({
              nodeId: row.nodeId as string,
              name: row.name as string,
              type: row.type as string,
              filePath: row.filePath as string,
              support: row.support,
              confidence: row.confidence,
              lift: row.lift,
              coChangeCount: row.coChangeCount,
            })),
            total: filtered.length,
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
        }

        // Project-level: query all CO_CHANGED_WITH pairs
        const results = await stores.graph.query(
          `MATCH (a {projectId: $projectId})-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]->(b {projectId: $projectId})
           RETURN a.id AS nodeAId, a.name AS nodeAName, a.type AS nodeAType,
                  b.id AS nodeBId, b.name AS nodeBName, b.type AS nodeBType,
                  r.support AS support, r.confidence AS confidence, r.lift AS lift, r.coChangeCount AS coChangeCount
           ORDER BY r.confidence DESC`,
          { projectId },
        );

        const filtered = results
          .filter((row) => {
            const support = typeof row.support === "number" ? row.support : Number(row.support);
            return support >= supportThreshold;
          })
          .slice(0, limit);

        const responseData: Record<string, unknown> = {
          coChanges: filtered.map((row) => ({
            nodeA: { id: row.nodeAId as string, name: row.nodeAName as string, type: row.nodeAType as string },
            nodeB: { id: row.nodeBId as string, name: row.nodeBName as string, type: row.nodeBType as string },
            support: row.support,
            confidence: row.confidence,
            lift: row.lift,
            coChangeCount: row.coChangeCount,
          })),
          total: filtered.length,
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
