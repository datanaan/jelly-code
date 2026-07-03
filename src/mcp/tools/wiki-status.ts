/**
 * MCP Tool: wiki_status
 *
 * List compiled sources and classify files as compiled/uncompiled.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiStatus(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_status',
    {
      description: 'Show Wiki compilation status for a project. Lists compiled sources and optionally identifies uncompiled files in a directory.',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the status to (multi-tenant isolation)'),
        dir: z.string().optional().describe('Directory to scan for uncompiled files'),
      },
    },
    async ({ projectId, dir }) => {
      try {
        const [result, activeTasks] = await Promise.all([
          wikiService.status(projectId, dir),
          Promise.resolve(wikiService.getActiveTasks(projectId)),
        ]);

        // Convert activeTasks Map to plain object for JSON serialization
        const tasks: Record<string, unknown> = {};
        for (const [id, task] of activeTasks) {
          tasks[id] = task;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...result, projectId, activeTasks: tasks }, null, 2),
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
