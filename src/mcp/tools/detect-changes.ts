/**
 * MCP Tool: detect_changes
 *
 * Detect which code symbols are affected by changes.
 * Supports manual file list or automatic git diff.
 */

import { z } from 'zod';
import { execFileSync } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerDetectChanges(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'detect_changes',
    {
      description: 'Detect which code symbols are affected by file changes. Provide changedFiles list, or use scope with repoPath for automatic git diff detection.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        changedFiles: z.array(z.string()).optional().describe('List of changed file paths (relative to repo root)'),
        scope: z.enum(['unstaged', 'staged', 'all', 'compare', 'since_last']).optional().describe('Git diff scope — requires repoPath. since_last compares against last analyzed commit.'),
        base_ref: z.string().optional().describe('Base ref for compare scope (default: main)'),
        repoPath: z.string().optional().describe('Absolute path to git repo (required for scope mode, auto-resolved from Project if omitted)'),
        depth: z.number().optional().default(2).describe('Depth of dependency traversal'),
      },
    },
    async ({ projectId, changedFiles, scope, base_ref, repoPath, depth }) => {
      try {
        // Auto-resolve repoPath from Project node if not provided
        let resolvedRepoPath = repoPath;
        if (!resolvedRepoPath) {
          try {
            const projResult = await stores.graph.query(
              'MATCH (p:Project {id: $projectId}) RETURN p.localPath AS localPath',
              { projectId },
            );
            const projData = projResult[0] as Record<string, unknown> | undefined;
            if (projData?.localPath) {
              resolvedRepoPath = projData.localPath as string;
            }
          } catch { /* ignore */ }
        }

        // Resolve changed files from scope if not provided
        let files = changedFiles ?? [];
        if (files.length === 0 && scope && resolvedRepoPath) {
          let diffArgs: string[];
          switch (scope) {
            case 'since_last': {
              const lastResult = await stores.graph.query(
                'MATCH (p:Project {id: $projectId}) RETURN p.lastCommit AS c',
                { projectId },
              );
              const lastCommit = (lastResult[0] as Record<string, unknown> | undefined)?.c as string | undefined;
              if (!lastCommit) {
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No previous analysis commit found. Run analyze_repo first.' }) }],
                  isError: true,
                };
              }
              diffArgs = ['diff', `${lastCommit}..HEAD`, '--name-only'];
              break;
            }
            case 'staged':
              diffArgs = ['diff', '--staged', '--name-only'];
              break;
            case 'all':
              diffArgs = ['diff', 'HEAD', '--name-only'];
              break;
            case 'compare':
              diffArgs = ['diff', base_ref || 'main', '--name-only'];
              break;
            default: // unstaged
              diffArgs = ['diff', '--name-only'];
          }
          try {
            const output = execFileSync('git', diffArgs, { cwd: resolvedRepoPath, encoding: 'utf-8' });
            files = output.trim().split('\n').filter(f => f.length > 0);
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `git diff failed: ${(e as Error).message}` }) }],
              isError: true,
            };
          }
        }

        if (files.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No changed files. Provide changedFiles or scope+repoPath.' }) }],
            isError: true,
          };
        }

        const changedSymbols: Array<{ id: string; name: string; type: string; filePath: string }> = [];

        for (const filePath of files) {
          try {
            const symbols = await stores.graph.findSymbolByFile(projectId, filePath);
            for (const sym of symbols) {
              if (!sym.id) continue; // skip nodes with missing id
              changedSymbols.push({ id: sym.id, name: sym.name, type: sym.type, filePath: sym.filePath });
            }
          } catch {
            // File might not be indexed
          }
        }

        const dependents: Array<{ id: string; name: string; type: string; filePath: string; via: string }> = [];

        for (const sym of changedSymbols) {
          const inbound = await stores.graph.getInboundRelations(projectId, sym.id);
          for (const rel of inbound) {
            const dependent = await stores.graph.getNode(projectId, rel.sourceId);
            if (dependent) {
              dependents.push({ id: dependent.id, name: dependent.name, type: dependent.type, filePath: dependent.filePath, via: rel.type });
            }
          }
        }

        const uniqueDependents = Array.from(new Map(dependents.map((d) => [d.id, d])).values());

        // Risk summary
        let riskLevel = 'LOW';
        if (changedSymbols.length >= 10 || uniqueDependents.length >= 10) riskLevel = 'HIGH';
        else if (changedSymbols.length >= 5 || uniqueDependents.length >= 5) riskLevel = 'MEDIUM';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                changedFiles: files,
                changedSymbols,
                dependents: uniqueDependents,
                risk_summary: `${riskLevel}: ${changedSymbols.length} symbols, ${uniqueDependents.length} dependents`,
                totalChangedSymbols: changedSymbols.length,
                totalDependents: uniqueDependents.length,
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
