/**
 * MCP Tool: list_dependencies
 *
 * List project dependencies — both external (node_modules) and internal (src/ modules).
 * Uses existing IMPORTS edges from the Neo4j graph.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";

// Cypher: external package dependencies from node_modules
const EXTERNAL_DEPS_QUERY = `
  MATCH (f {projectId: $projectId})-[r:CODE_RELATION {type: 'IMPORTS'}]->(dep {projectId: $projectId})
  WHERE dep.filePath CONTAINS 'node_modules/'
  WITH dep.filePath AS packagePath,
       collect(DISTINCT f.filePath) AS usedBy,
       count(DISTINCT f.filePath) AS usageCount
  RETURN packagePath, usageCount, usedBy
  ORDER BY usageCount DESC
  LIMIT $limit
`;

// Cypher: internal modules grouped by directory prefix
const INTERNAL_MODULES_QUERY = `
  MATCH (f {projectId: $projectId})-[r:CODE_RELATION {type: 'IMPORTS'}]->(dep {projectId: $projectId})
  WHERE f.filePath STARTS WITH 'src/'
    AND NOT dep.filePath CONTAINS 'node_modules/'
  WITH dep.filePath AS depPath, count(*) AS importCount, count(DISTINCT f.filePath) AS consumerCount
  RETURN
    CASE
      WHEN size(split(depPath, '/')) >= 2
      THEN split(depPath, '/')[0] + '/' + split(depPath, '/')[1]
      ELSE depPath
    END AS module,
    importCount,
    count(DISTINCT depPath) AS fileCount,
    consumerCount
  ORDER BY importCount DESC
  LIMIT 500
`;

function extractPackageName(packagePath: string): string {
  // node_modules/{scope}/{name} or node_modules/{name}
  const parts = packagePath.split("node_modules/");
  if (parts.length < 2) return packagePath;
  const rest = parts[1]!;
  // Handle scoped packages: @scope/name
  const segments = rest.split("/");
  if (segments.length >= 2 && segments[0]!.startsWith("@")) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? rest;
}

export function registerListDependencies(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "list_dependencies",
    {
      description:
        "List project dependencies including external packages (from node_modules) and internal modules (src/ directories grouped by prefix). Use this to understand dependency structure before refactoring or to identify heavily used packages.",
      inputSchema: {
        projectId: z.string().describe("Project ID to analyze"),
        scope: z.enum(["all", "external", "internal"]).optional().default("all").describe("Scope of dependencies to include: 'all' (both), 'external' (node_modules only), 'internal' (src/ modules only)"),
        limit: z.number().optional().default(100).describe("Maximum number of external packages to return (default 100)"),
      },
    },
    async ({ projectId, scope, limit }: { projectId: string; scope?: string; limit?: number }) => {
      try {
        const effectiveScope = scope ?? "all";
        const effectiveLimit = limit ?? 100;
        const externalPackages: Array<{ name: string; filePath: string; usageCount: number; usedBy: string[] }> = [];
        const internalModules: Array<{ name: string; importCount: number; fileCount: number; consumerCount: number }> = [];

        // Query external packages
        if (effectiveScope === "all" || effectiveScope === "external") {
          const extResults = await stores.graph.query(EXTERNAL_DEPS_QUERY, { projectId, limit: effectiveLimit });
          for (const row of extResults) {
            externalPackages.push({
              name: extractPackageName(row.packagePath as string),
              filePath: row.packagePath as string,
              usageCount: typeof row.usageCount === "number" ? row.usageCount : Number(row.usageCount),
              usedBy: (row.usedBy as string[]) ?? [],
            });
          }
        }

        // Query internal modules
        if (effectiveScope === "all" || effectiveScope === "internal") {
          const intResults = await stores.graph.query(INTERNAL_MODULES_QUERY, { projectId });
          for (const row of intResults) {
            internalModules.push({
              name: row.module as string,
              importCount: typeof row.importCount === "number" ? row.importCount : Number(row.importCount),
              fileCount: typeof row.fileCount === "number" ? row.fileCount : Number(row.fileCount),
              consumerCount: typeof row.consumerCount === "number" ? row.consumerCount : Number(row.consumerCount),
            });
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                externalPackages,
                internalModules,
                totalExternal: externalPackages.length,
                totalInternalModules: internalModules.length,
              }, null, 2),
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
