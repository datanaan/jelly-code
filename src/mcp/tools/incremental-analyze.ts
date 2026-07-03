/**
 * MCP Tool: incremental_analyze
 *
 * Run incremental analysis for a previously analyzed project.
 * Detects changes since the last analysis and only re-indexes changed files.
 * Falls back to full analysis if no previous commit is found.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import type { RepoCacheManager } from '../../core/repo-cache.js';
import { runIncrementalAnalyze } from '../../core/run-incremental.js';

export function registerIncrementalAnalyze(server: McpServer, stores: StoreSet, repoCache: RepoCacheManager): void {
  server.registerTool(
    'incremental_analyze',
    {
      description:
        'Run incremental analysis for a previously indexed project. Detects changes since the last analysis commit and only re-indexes changed files. Falls back to full analysis if needed. Check progress with list_repos.',
      inputSchema: {
        projectId: z.string().describe('Project ID (must have been analyzed previously with analyze_repo)'),
      },
    },
    async ({ projectId }) => {
      console.log(`[mcp:incremental_analyze] Starting: projectId=${projectId}`);

      // Fire-and-forget — analysis can take minutes for large repos
      setImmediate(async () => {
        try {
          const result = await runIncrementalAnalyze(projectId, stores, repoCache);
          console.log(
            `[mcp:incremental_analyze] Completed: ${projectId} — mode=${result.mode}, ` +
            `${result.nodeCount} nodes, ${result.relationCount} relations`,
          );
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : '';
          console.error(`[mcp:incremental_analyze] FAILED for ${projectId}: ${msg}`);
          console.error(`[mcp:incremental_analyze] Stack: ${stack}`);
        }
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'started',
              projectId,
              warning: '此模式仅节省 git clone I/O，pipeline 仍全量运行。社区检测和时序分析标记为 stale。',
              freshness: {
                symbols: 'fresh',
                communities: 'stale',
                temporal: 'stale',
              },
              hint: 'Incremental analysis runs in background. Use list_repos to check when complete.',
            }, null, 2),
          },
        ],
      };
    },
  );
}
