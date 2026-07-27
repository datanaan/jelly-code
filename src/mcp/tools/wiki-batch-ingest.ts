/**
 * MCP Tool: wiki_batch_ingest
 *
 * Batch ingest all files matching a glob pattern in a directory.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiBatchIngest(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_batch_ingest',
    {
      description: 'Batch ingest all files matching a glob pattern in a directory. Compiles each document into structured wiki entities. Returns status="processing" with a taskId on success, or status="already_running" if a batch for the same directory is already in progress (concurrency guard).',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the wiki data to (multi-tenant isolation)'),
        dir: z.string().describe('Directory path to scan for files'),
        pattern: z.string().optional().describe('Glob pattern to match files (default: **/*.md)'),
      },
    },
    async ({ projectId, dir, pattern }) => {
      try {
        const taskId = wikiService.startBatchIngest(projectId, dir, pattern);
        if (taskId === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'already_running',
                  projectId,
                  dir,
                  pattern: pattern ?? '**/*.md',
                  hint: 'Batch ingestion for this directory is already in progress. Use wiki_status to check progress.',
                }, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'processing',
                taskId,
                projectId,
                dir,
                pattern: pattern ?? '**/*.md',
                hint: 'Batch ingestion started in background. Use wiki_status to check progress.',
              }, null, 2),
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
