/**
 * MCP Tool: wiki_index
 *
 * Return the aggregated Wiki index (knowledge map).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiIndex(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_index',
    {
      description: 'Return the aggregated Wiki index — a knowledge map of all entities, sources, and topics scoped to the specified project.',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the wiki index to (multi-tenant isolation)'),
      },
    },
    async ({ projectId }) => {
      try {
        const result = await wikiService.getIndex(projectId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
