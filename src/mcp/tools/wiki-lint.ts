/**
 * MCP Tool: wiki_lint
 *
 * Check for orphans, missing refs, stale entities, and contradictions.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiLint(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_lint',
    {
      description: 'Lint the Wiki for quality issues scoped to a project: orphan entities, missing references, stale content, and contradictions.',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the lint to (multi-tenant isolation)'),
      },
    },
    async ({ projectId }) => {
      try {
        const issues = await wikiService.lint(projectId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ projectId, issues, count: issues.length }, null, 2),
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
