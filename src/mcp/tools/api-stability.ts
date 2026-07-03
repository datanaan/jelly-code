/**
 * MCP Tool: api_stability
 *
 * Assess API route stability from temporal change data.
 * Returns stability scores per route handler, classified as
 * stable / moderate / volatile.
 *
 * Graceful degradation when no temporal data exists.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { calculateApiStability } from '../../prediction/api-stability.js';

export function registerApiStability(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'api_stability',
    {
      description:
        'Assess API route stability from git change history. Returns stability scores (0-1) and levels (stable/moderate/volatile) for each route handler. Requires temporal data (analyze with git history first).',
      inputSchema: {
        projectId: z.string().describe('Project ID to analyze'),
        apiPath: z.string().optional().describe('Filter results to a specific API path prefix'),
        stabilityThreshold: z.number().optional().describe('Only show routes with stability below this threshold (0-1)'),
      },
    },
    async ({ projectId, apiPath, stabilityThreshold }: { projectId: string; apiPath?: string; stabilityThreshold?: number }) => {
      try {
        const allScores = await calculateApiStability(projectId, stores.graph);

        // No temporal data
        if (allScores.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  scores: [],
                  total: 0,
                  message: 'No API route stability data available. Analyze the project with git history first.',
                }, null, 2),
              },
            ],
          };
        }

        // Apply filters
        let filtered = allScores;

        if (apiPath) {
          filtered = filtered.filter(s =>
            s.apiPath.includes(apiPath),
          );
        }

        if (stabilityThreshold !== undefined) {
          filtered = filtered.filter(s => s.stability < stabilityThreshold);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                scores: filtered,
                total: filtered.length,
                totalRoutes: allScores.length,
                filteredBy: {
                  apiPath: apiPath ?? null,
                  stabilityBelow: stabilityThreshold ?? null,
                },
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
