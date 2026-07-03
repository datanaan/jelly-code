/**
 * MCP Tool: search_code
 *
 * Full-text code search across indexed repositories.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerSearchCode(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'search_code',
    {
      description: 'Search for code symbols by keyword. Uses full-text search to find functions, classes, methods, and interfaces.',
      inputSchema: {
        projectId: z.string().describe('Project ID to search in'),
        query: z.string().describe('Search query (function name, class name, etc.)'),
        limit: z.number().optional().default(10).describe('Maximum number of results'),
        filterByTypes: z.array(z.string()).optional().describe('Filter by node types (e.g., ["Function", "Class"])'),
      },
    },
    async ({ projectId, query, limit, filterByTypes }) => {
      try {
        const results = await stores.search.search(projectId, query, {
          limit: limit ?? 10,
          filterByTypes,
        });

        const formatted = results.map((r) => ({
          name: r.name,
          type: r.nodeType,
          filePath: r.filePath,
          score: r.score,
          nodeId: r.nodeId,
        }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ results: formatted, count: formatted.length, query }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error), query }) }],
          isError: true,
        };
      }
    },
  );
}
