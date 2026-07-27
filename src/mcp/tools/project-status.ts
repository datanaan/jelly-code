/**
 * MCP Tool: project_status
 *
 * Query the analysis status and progress of a project.
 * Falls back to Neo4j Project node data when TaskManager state
 * is unavailable (e.g. after server restart).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskManager } from '../../task/index.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerProjectStatus(server: McpServer, taskManager: TaskManager, stores: StoreSet): void {
  server.registerTool(
    'project_status',
    {
      description:
        'Query the analysis status and progress of a project. Returns current state (idle/queued/analyzing/ready/error), progress info, and estimated wait time. Use this instead of polling list_repos.',
      inputSchema: {
        projectId: z.string().describe('Project ID to check status for'),
      },
    },
    async ({ projectId }: { projectId: string }) => {
      // 1. Try in-memory TaskManager first (most accurate during active analysis)
      const state = taskManager.getState(projectId);

      if (state) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: state.status,
              projectId,
              startedAt: state.startedAt?.toISOString(),
              progress: state.progress,
              error: state.error,
              pendingRequests: state.pendingRequests.length,
            }, null, 2),
          }],
        };
      }

      // 2. Fallback to Neo4j Project node (survives server restart)
      try {
        const result = await stores.graph.query(
          'MATCH (p:Project {id: $projectId}) RETURN p',
          { projectId },
        );
        const project = result[0] as Record<string, unknown> | undefined;
        const projectData = project?.p as Record<string, unknown> | undefined;

        if (projectData) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'indexed',
                projectId,
                message: 'Previously analyzed project (status from Neo4j).',
              }, null, 2),
            }],
          };
        }
      } catch {
        // Non-fatal: Neo4j unavailable, fall through to "not found"
      }

      // 3. Not found in either source
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'idle',
            projectId,
            message: 'Project not found or not yet analyzed.',
          }),
        }],
      };
    },
  );
}
