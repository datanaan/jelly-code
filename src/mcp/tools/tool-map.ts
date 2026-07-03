/**
 * MCP Tool: tool_map
 *
 * Show MCP/RPC tool definitions: which tools exist, where handled.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerToolMap(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'tool_map',
    {
      description: 'Show MCP/RPC tool definitions: which tools exist, their handler files, and descriptions.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        tool: z.string().optional().describe('Filter by tool name'),
      },
    },
    async ({ projectId, tool }) => {
      try {
        const nameFilter = tool ? ` AND n.name CONTAINS $tool` : '';
        const query = `
          MATCH (n)
          WHERE n.type = 'Tool' AND n.projectId = $projectId${nameFilter}
          RETURN n.name AS name, n.filePath AS filePath, n.description AS description
        `;
        const result = await stores.graph.query(query, { projectId, tool: tool ?? '' });

        const tools = (result ?? []).map((r: any) => ({
          name: r.name,
          filePath: r.filePath || '',
          description: (r.description || '').slice(0, 200),
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ tools, total: tools.length }, null, 2),
          }],
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
