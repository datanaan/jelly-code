/**
 * MCP Tool: wiki_query
 *
 * Query the Wiki with hybrid search + LLM synthesis.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiQuery(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_query',
    {
      description: 'Query the Wiki using hybrid search and LLM synthesis. Returns a synthesized answer based on wiki content scoped to the specified project.',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the query to (multi-tenant isolation)'),
        question: z.string().describe('Question to ask the wiki'),
        write_back: z.boolean().optional().describe('Whether to save the answer as a Topic in the wiki'),
      },
    },
    async ({ projectId, question, write_back }) => {
      try {
        const answer = await wikiService.query(projectId, question, write_back);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ answer, projectId }, null, 2),
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
