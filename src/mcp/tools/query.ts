/**
 * MCP Tool: query
 *
 * Execute a read-only Cypher query against the knowledge graph.
 * Write operations (CREATE/MERGE/SET/DELETE/DETACH/REMOVE) are rejected.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { addFreshnessWarnings } from './freshness.js';

/**
 * Cypher keywords that indicate write operations — reject these from the query tool.
 *
 * Detects write keywords appearing as the first keyword in any statement within
 * the Cypher query. This catches:
 *   - Single-statement writes: "CREATE (n)", "SET n.x = 1"
 *   - Multi-statement writes: "MATCH (n) SET n.x = 1"
 *   - Write after clause boundary: "MATCH (n)\nDELETE n"
 *
 * The regex matches a write keyword that is preceded by either:
 *   - Start of string (possibly with whitespace/comments before)
 *   - A clause boundary: ), ;, or newline followed by whitespace
 *
 * The \b word boundary ensures we don't match "SETTING" or "DELETE_ME".
 */
const WRITE_PATTERNS = /(?:^|[);\n])\s*(?:CREATE|MERGE|SET|DETACH\s+DELETE|DELETE|REMOVE)\b/im;

export function registerQuery(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'query',
    {
      description: 'Execute a read-only Cypher query against the code knowledge graph. Use for graph traversal, pattern matching, and relationship queries. Results include freshness status — check for stale community/temporal data warnings. Note: write operations (CREATE/MERGE/SET/DELETE) are blocked; use safe_query for controlled mutations.',
      inputSchema: {
        projectId: z.string().describe('Project ID to query'),
        cypher: z.string().describe('Cypher query string (read-only; write operations are rejected)'),
      },
    },
    async ({ projectId, cypher }) => {
      try {
        // Reject write operations — query tool is read-only
        if (WRITE_PATTERNS.test(cypher)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Write operations are not allowed via the query tool. Use safe_query for controlled mutations.',
                cypher,
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Pass projectId as $projectId for intuitive use in hand-written Cypher
        const queryParams = { projectId };
        const result = await stores.graph.query(cypher, queryParams);
        const responseData: Record<string, unknown> = { result, count: result.length };
        await addFreshnessWarnings(projectId, stores.graph, responseData);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(responseData, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error), cypher }) }],
          isError: true,
        };
      }
    },
  );
}
