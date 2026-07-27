/**
 * MCP Tool: affected_tests
 *
 * Given a list of changed files, find which test files are affected.
 * Uses IMPORTS edges for direct impact and CALLS edges for transitive impact.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreSet } from "../../store/interfaces.js";

// Step 1: Find test files that directly import the changed files
const DIRECT_TEST_IMPACT_QUERY = `
  MATCH (tf {projectId: $projectId})-[r:CODE_RELATION {type: 'IMPORTS'}]->(cf {projectId: $projectId})
  WHERE cf.filePath IN $changedFiles
    AND (tf.filePath CONTAINS '.test.' OR tf.filePath CONTAINS '.spec.')
  RETURN tf.filePath AS testFile, cf.filePath AS changedFile, 'direct_import' AS reason
`;

// Step 2: Find test files that call changed symbols (transitive impact)
const CALL_CHAIN_TEST_IMPACT_QUERY = `
  MATCH (changed {projectId: $projectId})
  WHERE changed.filePath IN $changedFiles
  MATCH (changed)<-[r:CODE_RELATION {type: 'CALLS'}]-(caller {projectId: $projectId})
  WHERE caller.filePath CONTAINS '.test.' OR caller.filePath CONTAINS '.spec.'
  WITH caller.filePath AS testFile,
       collect(DISTINCT changed.name) AS changedSymbols,
       collect(DISTINCT changed.filePath) AS affectedFiles
  RETURN testFile, changedSymbols, affectedFiles, 'call_chain' AS reason
`;

// Step 3: Find changed files that have no test coverage
const UNTESTED_CHANGES_QUERY = `
  MATCH (cf {projectId: $projectId})
  WHERE cf.filePath IN $changedFiles
    AND NOT cf.filePath CONTAINS '.test.'
    AND NOT cf.filePath CONTAINS '.spec.'
    AND NOT EXISTS {
      MATCH (tf {projectId: $projectId})-[r:CODE_RELATION {type: 'IMPORTS'}]->(cf)
      WHERE tf.filePath CONTAINS '.test.' OR tf.filePath CONTAINS '.spec.'
    }
  RETURN cf.filePath AS untestedFile
`;

export function registerAffectedTests(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    "affected_tests",
    {
      description:
        "Find test files affected by code changes. Given a list of changed file paths, returns: (1) test files that directly import changed files, (2) test files that call changed symbols through call chains, (3) changed files without test coverage. Use before committing changes to identify which tests to run.",
      inputSchema: {
        projectId: z.string().describe("Project ID to analyze"),
        changedFiles: z.array(z.string()).describe("List of changed file paths (e.g. ['src/api/users.ts', 'src/utils/helper.ts'])"),
      },
    },
    async ({ projectId, changedFiles }: { projectId: string; changedFiles: string[] }) => {
      try {
        if (!changedFiles || changedFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  directlyAffected: [],
                  transitivelyAffected: [],
                  totalTestFiles: 0,
                  untestedChangedFiles: [],
                  message: "No changed files provided.",
                }, null, 2),
              },
            ],
          };
        }

        // Step 1: Direct import impact
        const directResults = await stores.graph.query(DIRECT_TEST_IMPACT_QUERY, { projectId, changedFiles });
        const directlyAffected: Array<{ testFile: string; changedFile: string; reason: string }> = [];
        for (const row of directResults) {
          directlyAffected.push({
            testFile: row.testFile as string,
            changedFile: row.changedFile as string,
            reason: row.reason as string,
          });
        }

        // Step 2: Call chain transitive impact
        const callChainResults = await stores.graph.query(CALL_CHAIN_TEST_IMPACT_QUERY, { projectId, changedFiles });
        const transitivelyAffected: Array<{ testFile: string; changedSymbols: string[]; changedFiles: string[]; reason: string }> = [];
        for (const row of callChainResults) {
      transitivelyAffected.push({
        testFile: row.testFile as string,
        changedSymbols: (row.changedSymbols as string[]) ?? [],
        changedFiles: (row.affectedFiles as string[]) ?? [],
        reason: row.reason as string,
      });
        }

        // Step 3: Untested changed files
        const untestedResults = await stores.graph.query(UNTESTED_CHANGES_QUERY, { projectId, changedFiles });
        const untestedChangedFiles: string[] = untestedResults.map((row) => row.untestedFile as string);

        // Deduplicate test files for total count
        const allTestFiles = new Set<string>();
        for (const a of directlyAffected) allTestFiles.add(a.testFile);
        for (const a of transitivelyAffected) allTestFiles.add(a.testFile);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                directlyAffected,
                transitivelyAffected,
                totalTestFiles: allTestFiles.size,
                untestedChangedFiles,
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
