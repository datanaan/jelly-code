/**
 * MCP Tool: wiki_ingest
 *
 * Ingest a single source file into the Wiki knowledge graph.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiService } from '../../wiki/service.js';

export function registerWikiIngest(server: McpServer, wikiService: WikiService): void {
  server.registerTool(
    'wiki_ingest',
    {
      description: 'Ingest a single source file into the Wiki. Compiles the document into structured wiki entities using LLM. Use content parameter to send file body directly (no server filesystem access needed). Returns status="processing" with a taskId on success, or status="already_running" if an ingestion for the same file is already in progress (concurrency guard).',
      inputSchema: {
        projectId: z.string().describe('Project ID to scope the wiki data to (multi-tenant isolation)'),
        source_path: z.string().describe('Path to the source file to ingest (used as identifier)'),
        content: z.string().optional().describe('File content. If provided, skips reading from filesystem. Use when file is not on the server.'),
      },
    },
    async ({ projectId, source_path, content }) => {
      try {
        const taskId = wikiService.startIngest(projectId, source_path, content);
        if (taskId === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'already_running',
                  projectId,
                  sourcePath: source_path,
                  hint: 'Ingestion for this file is already in progress. Use wiki_status to check progress.',
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
                sourcePath: source_path,
                hint: 'Ingestion started in background. Use wiki_status to check progress.',
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
