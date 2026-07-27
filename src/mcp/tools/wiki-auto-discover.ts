/**
 * MCP Tool: wiki_auto_discover
 *
 * Auto-discover documents in a repository, determine the best glob pattern,
 * and start batch ingestion — all in one call.
 *
 * Wraps WikiService.startAutoDiscover which:
 *   1. Walks the repo to find documentation files
 *   2. Classifies them by language/type
 *   3. Derives optimal batch params (dir, pattern)
 *   4. Starts batchIngest in background
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiAutoDiscover(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_auto_discover',
    {
      description:
        'Auto-discover documentation files in a repository and start batch ingestion. ' +
        'Scans the repo, classifies documents, derives optimal glob pattern, and compiles them into wiki entities. ' +
        'Returns status="processing" with a taskId on success, or status="already_running" if auto-discovery ' +
        'for this repository is already in progress (concurrency guard).',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the wiki data to (multi-tenant isolation)'),
        repoPath: z.string().describe('Absolute path to the repository root to scan for documents'),
      },
    },
    async ({ projectId, repoPath }) => {
      try {
        const taskId = wikiService.startAutoDiscover(projectId, repoPath);
        if (taskId === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    status: 'already_running',
                    mode: 'auto-discover',
                    projectId,
                    repoPath,
                    hint: 'Auto-discovery for this repository is already in progress. Use wiki_status to check progress.',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'processing',
                  mode: 'auto-discover',
                  taskId,
                  projectId,
                  repoPath,
                  hint: 'Auto-discovery started in background. The system will scan the repo, classify documents, and ingest them. Use wiki_status to check progress.',
                },
                null,
                2,
              ),
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
