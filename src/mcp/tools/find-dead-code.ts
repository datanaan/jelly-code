/**
 * MCP Tool: find_dead_code
 *
 * Find dead (unreferenced) code symbols by analyzing CALLS/IMPORTS/EXTENDS/IMPLEMENTS/OVERRIDES edges.
 * Supports confidence scoring: exported with no callers=1.0, internal with no callers=0.9, self-reference only=0.95.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";

// Cypher: exported symbols with zero inbound references (confidence 1.0)
// Only match code symbols (not File/Project nodes) to avoid false positives.
const DEAD_EXPORTED_QUERY = `
  MATCH (n {projectId: $projectId})
  WHERE n.isExported = true
    AND n.type IS NOT NULL AND n.type <> 'File' AND n.type <> 'Project'
    AND NOT EXISTS {
      MATCH (n)<-[r:CODE_RELATION]-(caller {projectId: $projectId})
      WHERE r.type IN ['CALLS', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES', 'USES']
    }
  RETURN n.name as name, n.type as type, n.filePath as filePath,
         1.0 as confidence, 'no_callers_exported' as reason
  ORDER BY n.filePath
`;

// Cypher: internal (non-exported) symbols with zero inbound references (confidence 0.9)
const DEAD_INTERNAL_QUERY = `
  MATCH (n {projectId: $projectId})
  WHERE (n.isExported = false OR n.isExported IS NULL)
    AND n.type IS NOT NULL AND n.type <> 'File' AND n.type <> 'Project'
    AND NOT EXISTS {
      MATCH (n)<-[r:CODE_RELATION]-(caller {projectId: $projectId})
      WHERE r.type IN ['CALLS', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES', 'USES']
    }
  RETURN n.name as name, n.type as type, n.filePath as filePath,
         0.9 as confidence, 'no_callers_internal' as reason
  ORDER BY n.filePath
`;

// Cypher: symbols that only reference themselves (confidence 0.95)
const SELF_REF_ONLY_QUERY = `
  MATCH (n {projectId: $projectId})
  WHERE n.type IS NOT NULL AND n.type <> 'File' AND n.type <> 'Project'
    AND EXISTS {
      MATCH (n)-[r:CODE_RELATION]->(n)
      WHERE r.type IN ['CALLS', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES', 'USES']
    }
    AND NOT EXISTS {
      MATCH (n)<-[r:CODE_RELATION]-(caller {projectId: $projectId})
      WHERE r.type IN ['CALLS', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES', 'USES']
        AND caller <> n
    }
  RETURN n.name as name, n.type as type, n.filePath as filePath,
         0.95 as confidence, 'self_reference_only' as reason
  ORDER BY n.filePath
`;

interface DeadSymbol {
  name: string;
  type: string;
  filePath: string;
  labels: string[];
  confidence: number;
  reason: string;
}

function buildByFile(symbols: DeadSymbol[]): Record<string, number> {
  const byFile: Record<string, number> = {};
  for (const sym of symbols) {
    byFile[sym.filePath] = (byFile[sym.filePath] || 0) + 1;
  }
  return byFile;
}

export function registerFindDeadCode(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "find_dead_code",
    {
      description:
        "Find dead (unreferenced) code symbols in a project. Checks exported symbols with no callers (confidence 1.0), internal symbols with no callers (confidence 0.9), and symbols that only reference themselves (confidence 0.95). Use this before refactoring to identify safe candidates for removal.",
      inputSchema: {
        projectId: z.string().describe("Project ID to scan for dead code"),
        minConfidence: z.number().optional().default(0.8).describe("Minimum confidence threshold (0-1). Symbols below this are excluded from results"),
        includeExportedOnly: z.boolean().optional().default(true).describe("When true, only checks exported symbols. When false, also checks internal (non-exported) symbols"),
        filePath: z.string().optional().describe("Optional file path filter. When set, only returns dead symbols in this file"),
      },
    },
    async ({ projectId, minConfidence, includeExportedOnly, filePath }: { projectId: string; minConfidence?: number; filePath?: string; includeExportedOnly?: boolean }) => {
      try {
        const confidenceThreshold = minConfidence ?? 0.8;
        const allSymbols: DeadSymbol[] = [];

        // Query A: exported symbols with no callers (always run)
        const exportedResults = await stores.graph.query(DEAD_EXPORTED_QUERY, { projectId });
        for (const row of exportedResults) {
          allSymbols.push({
            name: row.name as string,
            type: row.type as string,
            filePath: row.filePath as string,
            labels: (row.labels as string[]) ?? [],
            confidence: 1.0,
            reason: row.reason as string,
          });
        }

        // Query B: internal symbols with no callers (only when includeExportedOnly=false)
        if (includeExportedOnly === false) {
          const internalResults = await stores.graph.query(DEAD_INTERNAL_QUERY, { projectId });
          for (const row of internalResults) {
            allSymbols.push({
              name: row.name as string,
              type: row.type as string,
              filePath: row.filePath as string,
              labels: (row.labels as string[]) ?? [],
              confidence: 0.9,
              reason: row.reason as string,
            });
          }
        }

        // Query C: self-reference only (always run)
        const selfRefResults = await stores.graph.query(SELF_REF_ONLY_QUERY, { projectId });
        for (const row of selfRefResults) {
          allSymbols.push({
            name: row.name as string,
            type: row.type as string,
            filePath: row.filePath as string,
            labels: (row.labels as string[]) ?? [],
            confidence: 0.95,
            reason: row.reason as string,
          });
        }

        // Filter by confidence threshold
        let filtered = allSymbols.filter((sym) => sym.confidence >= confidenceThreshold);

        // Filter by file path if specified
        if (filePath) {
          filtered = filtered.filter((sym) => sym.filePath === filePath);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                total: filtered.length,
                deadSymbols: filtered.map((sym) => ({
                  name: sym.name,
                  type: sym.type,
                  filePath: sym.filePath,
                  confidence: sym.confidence,
                  reason: sym.reason,
                })),
                byFile: buildByFile(filtered),
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
