/**
 * MCP Tool: wiki_sync
 *
 * Sync wiki content to a Jelly KB.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiSync(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_sync',
    {
      description: 'Sync Wiki entities and topics as Markdown to a Jelly knowledge base. Only syncs content scoped to the specified project.',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the sync source to (multi-tenant isolation)'),
        kb_id: z.string().describe('Jelly KB ID to sync to'),
      },
    },
    async ({ projectId, kb_id }) => {
      try {
        const result = await wikiService.syncToJelly(projectId, kb_id);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...result, projectId }, null, 2),
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
