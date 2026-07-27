/**
 * MCP Tool: analyze_repo
 *
 * Start indexing a code repository into the knowledge graph.
 * Uses TaskManager for concurrency control: dedup, state tracking, progress.
 *
 * Level strategy:
 * - L0_GIT_LOG: lightweight git-log-only analysis for mega repos (50K+ files)
 * - L2_FULL: complete AST + git + embeddings for normal repos
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import type { RepoCacheManager } from '../../core/repo-cache.js';
import type { TaskManager } from '../../task/index.js';
import { analyzeQueue } from '../../core/queue-setup.js';
import { logger } from '../../core/logger.js';

export function registerAnalyzeRepo(server: McpServer, stores: StoreSet, repoCache?: RepoCacheManager, taskManager?: TaskManager): void {
  server.registerTool(
    'analyze_repo',
    {
      description:
        'Start indexing a code repository into the knowledge graph. IMPORTANT: Always use gitUrl. The server clones the repo and caches it. Do NOT send local file paths as repoPath — the server cannot access your local filesystem. AUTO-INCREMENTAL: If the project was previously analyzed and has a lastCommit, automatically switches to incremental mode (only re-indexes changed files) unless forceLevel is specified. Returns immediately — analysis runs in background. Check progress with project_status.',
      inputSchema: {
        projectId: z.string().describe('Unique project ID for the repository'),
        gitUrl: z.string().optional().describe('Git repository URL to clone and analyze. Example: git@host:org/repo.git or https://host/org/repo.git. Always use this — do NOT send local file paths.'),
        repoPath: z.string().optional().describe('DEPRECATED: Local filesystem path on the server. Do NOT send your local path — the server cannot access it. Always use gitUrl instead.'),
        forceLevel: z.enum(['L0_GIT_LOG', 'L2_FULL']).optional().describe('Force analysis level (override auto-detection)'),
      },
    },
    async ({ projectId, gitUrl, repoPath, forceLevel }: { projectId: string; gitUrl?: string; repoPath?: string; forceLevel?: string }) => {
      // Dedup check
      if (taskManager) {
        const currentState = taskManager.getState(projectId);
        if (currentState?.status === 'analyzing' || currentState?.status === 'queued') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: currentState.status,
                projectId,
                position: currentState.pendingRequests.length + 1,
                hint: `Project is already ${currentState.status}. Use project_status to check progress.`,
              }),
            }],
          };
        }
      }

      // Look up stored source if none provided
      let storedLastCommit: string | undefined;
      if (!gitUrl && !repoPath) {
        try {
          const result = await stores.graph.query(
            'MATCH (p:Project {id: $id}) RETURN p.gitUrl AS gitUrl, p.localPath AS localPath, p.lastCommit AS lastCommit',
            { id: projectId },
          );
          const stored = result[0] as Record<string, unknown> | undefined;
          if (stored?.gitUrl) {
            gitUrl = stored.gitUrl as string;
            storedLastCommit = stored.lastCommit as string | undefined;
            logger.info({ projectId, gitUrl }, 'Re-using stored gitUrl');
          } else if (stored?.localPath) {
            repoPath = stored.localPath as string;
            storedLastCommit = stored.lastCommit as string | undefined;
            logger.info({ projectId, repoPath }, 'Re-using stored localPath');
          }
        } catch { /* project might not exist yet */ }
      } else {
        // Source provided by caller — check if project already exists for auto-incremental
        try {
          const result = await stores.graph.query(
            'MATCH (p:Project {id: $id}) RETURN p.lastCommit AS lastCommit',
            { id: projectId },
          );
          const stored = result[0] as Record<string, unknown> | undefined;
          storedLastCommit = stored?.lastCommit as string | undefined;
        } catch { /* not exist yet */ }
      }

      if (!gitUrl && !repoPath) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide gitUrl or repoPath. No stored source found for this project.' }) }],
          isError: true,
        };
      }

      // Auto-incremental: if project has been analyzed before (has lastCommit) and
      // user did not explicitly force a level, switch to incremental mode automatically.
      const canAutoIncremental = !!storedLastCommit && !!gitUrl && !!repoCache && !forceLevel;

      const source = gitUrl || repoPath;

      // Submit to BullMQ queue (persistent, with retry and timeout)
      await analyzeQueue.add('analyze', {
        projectId,
        gitUrl,
        repoPath,
        forceLevel,
        canAutoIncremental,
        storedLastCommit,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'queued',
            projectId,
            source,
            mode: canAutoIncremental ? 'incremental' : 'full',
            jobId: undefined,  // BullMQ returns job ID on the worker side
            hint: canAutoIncremental
              ? 'Project already analyzed — auto-switched to incremental mode. Use project_status to check progress.'
              : 'Analysis queued (persistent). Use project_status to check progress.',
          }, null, 2),
        }],
      };
    },
  );
}
