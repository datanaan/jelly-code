/**
 * MCP Tool: query
 *
 * Execute a Cypher query against the knowledge graph.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { addFreshnessWarnings } from './freshness.js';

export function registerQuery(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'query',
    {
      description: 'Execute a Cypher query against the code knowledge graph. Use for graph traversal, pattern matching, and relationship queries. Results include freshness status — check for stale community/temporal data warnings.',
      inputSchema: {
        projectId: z.string().describe('Project ID to query'),
        cypher: z.string().describe('Cypher query string'),
      },
    },
    async ({ projectId, cypher }) => {
      try {
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
