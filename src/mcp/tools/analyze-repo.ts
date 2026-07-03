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
import { runAnalyze } from '../../core/run-analyze.js';
import { runIncrementalAnalyze } from '../../core/run-incremental.js';
import { determineAnalysisLevel } from '../../prediction/level-strategy.js';
import { analyzeLevel0 } from '../../prediction/level0-analyzer.js';
import { AnalysisLevel } from '../../prediction/types.js';

export function registerAnalyzeRepo(server: McpServer, stores: StoreSet, repoCache?: RepoCacheManager, taskManager?: TaskManager): void {
  server.registerTool(
    'analyze_repo',
    {
      description:
        'Start indexing a code repository into the knowledge graph. IMPORTANT: Always prefer gitUrl for remote clients. The server will clone the repo and cache it. Only use repoPath if the repository is already on the server filesystem. AUTO-INCREMENTAL: If the project was previously analyzed and has a lastCommit, automatically switches to incremental mode (only re-indexes changed files) unless forceLevel is specified. Returns immediately — analysis runs in background. Check progress with project_status.',
      inputSchema: {
        projectId: z.string().describe('Unique project ID for the repository'),
        gitUrl: z.string().optional().describe('Git repository URL to clone and analyze. PREFERRED. Example: git@host:org/repo.git or https://host/org/repo.git'),
        repoPath: z.string().optional().describe('Local filesystem path on the server. ONLY use if the repo already exists on the server. Ignored if gitUrl is provided.'),
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
            console.log(`[mcp:analyze_repo] Re-using stored gitUrl for ${projectId}: ${gitUrl}`);
          } else if (stored?.localPath) {
            repoPath = stored.localPath as string;
            storedLastCommit = stored.lastCommit as string | undefined;
            console.log(`[mcp:analyze_repo] Re-using stored localPath for ${projectId}: ${repoPath}`);
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

      if (taskManager) {
        await taskManager.requestAnalyze(projectId, { repoPath, gitUrl });

        setImmediate(async () => {
          taskManager.markAnalyzing(projectId);
          try {
            // Auto-incremental path: project already analyzed, switch to incremental
            if (canAutoIncremental) {
              console.log(`[mcp:analyze_repo] Auto-switching to incremental for ${projectId} (lastCommit: ${storedLastCommit})`);
              taskManager.updateProgress(projectId, { phase: 'incremental', percent: 0 });
              const incResult = await runIncrementalAnalyze(projectId, stores, repoCache!, {
                onProgress: (phase, percent) => {
                  taskManager.updateProgress(projectId, { phase, percent });
                },
              });
              taskManager.markReady(projectId);
              console.log(
                `[mcp:analyze_repo] Incremental completed: ${projectId} — mode=${incResult.mode}, ` +
                `${incResult.nodeCount} nodes, ${incResult.relationCount} relations` +
                (incResult.changeSet ? ` (changes: ${incResult.changeSet.modified}M/${incResult.changeSet.deleted}D/${incResult.changeSet.added}A)` : ''),
              );
              return;
            }

            // Full analysis path (new project or forceLevel specified)
            // Determine analysis level — try to use cached totalFiles to avoid execSync
            const effectiveRepoPath = repoPath || '';
            let cachedFileCount: number | undefined;
            if (!forceLevel) {
              try {
                const proj = await stores.graph.query(
                  'MATCH (p:Project {id: $id}) RETURN p.totalFiles AS totalFiles',
                  { id: projectId },
                );
                if (proj[0]?.totalFiles !== undefined && proj[0]?.totalFiles !== null) {
                  cachedFileCount = Number(proj[0].totalFiles);
                }
              } catch { /* project might not exist yet — estimate from disk */ }
            }
            const levelDecision = await determineAnalysisLevel(
              effectiveRepoPath,
              {
                forceLevel: forceLevel as AnalysisLevel | undefined,
                cachedFileCount,
              },
            );
            console.log(`[mcp:analyze_repo] Level decision for ${projectId}: ${levelDecision.level} (${levelDecision.reason})`);

            if (levelDecision.level === AnalysisLevel.L0_GIT_LOG) {
              // L0: lightweight git-log-only analysis
              console.log(`[mcp:analyze_repo] Running L0 analysis for ${projectId}...`);
              const stats = await analyzeLevel0(effectiveRepoPath, projectId, stores);
              taskManager.markReady(projectId);
              console.log(
                `[mcp:analyze_repo] L0 analysis completed: ${projectId} — ${stats.commitCount} commits, ${stats.fileCount} files, ${stats.couplingPairs} coupling pairs`,
              );
            } else {
              // L2: full AST + git + embeddings
              console.log(`[mcp:analyze_repo] Running L2 analysis for ${projectId}...`);
              const stats = await runAnalyze(
                effectiveRepoPath,
                projectId,
                stores,
                {
                  gitUrl: gitUrl || undefined,
                  repoCache,
                  onProgress: (phase, percent) => {
                    taskManager.updateProgress(projectId, { phase, percent });
                  },
                },
              );
              taskManager.markReady(projectId);
              console.log(`[mcp:analyze_repo] L2 analysis completed: ${projectId} — ${stats.nodeCount} nodes, ${stats.relationCount} relations`);
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error ? error.stack : '';
            console.error(`[mcp:analyze_repo] Analysis FAILED for ${projectId}: ${msg}`);
            console.error(`[mcp:analyze_repo] Stack: ${stack}`);
            taskManager.markError(projectId, msg);
          }
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'queued',
              projectId,
              source,
              mode: canAutoIncremental ? 'incremental' : 'full',
              hint: canAutoIncremental
                ? 'Project already analyzed — auto-switched to incremental mode. Use project_status to check progress.'
                : 'Analysis queued. Use project_status to check progress.',
            }, null, 2),
          }],
        };
      }

      // Legacy fallback — no TaskManager available
      console.log(`[mcp:analyze_repo] Starting (legacy): projectId=${projectId}`);
      setImmediate(async () => {
        try {
          // Determine analysis level for legacy mode too
          const effectiveRepoPath = repoPath || '';
          let cachedFileCount: number | undefined;
          if (!forceLevel) {
            try {
              const proj = await stores.graph.query(
                'MATCH (p:Project {id: $id}) RETURN p.totalFiles AS totalFiles',
                { id: projectId },
              );
              if (proj[0]?.totalFiles !== undefined && proj[0]?.totalFiles !== null) {
                cachedFileCount = Number(proj[0].totalFiles);
              }
            } catch { /* project might not exist yet */ }
          }
          const levelDecision = await determineAnalysisLevel(
            effectiveRepoPath,
            { forceLevel: forceLevel as AnalysisLevel | undefined, cachedFileCount },
          );
          console.log(`[mcp:analyze_repo] Level decision (legacy): ${levelDecision.level} (${levelDecision.reason})`);

          if (levelDecision.level === AnalysisLevel.L0_GIT_LOG) {
            const stats = await analyzeLevel0(effectiveRepoPath, projectId, stores);
            console.log(`[mcp:analyze_repo] L0 analysis completed (legacy): ${projectId} — ${stats.commitCount} commits`);
          } else {
            await runAnalyze(effectiveRepoPath, projectId, stores, { gitUrl: gitUrl || undefined, repoCache });
            console.log(`[mcp:analyze_repo] L2 analysis completed (legacy): ${projectId}`);
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[mcp:analyze_repo] Analysis FAILED: ${msg}`);
        }
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'started', projectId, source, hint: 'Legacy mode. Use list_repos to check.' }),
        }],
      };
    },
  );
}
