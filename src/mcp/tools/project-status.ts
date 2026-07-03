/**
 * MCP Tool: project_status
 *
 * Query the analysis status and progress of a project.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskManager } from '../../task/index.js';

export function registerProjectStatus(server: McpServer, taskManager: TaskManager): void {
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
      const state = taskManager.getState(projectId);

      if (!state) {
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
      }

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
    },
  );
}
