/**
 * MCP Tool: route_map
 *
 * Show API route mappings: handlers, middleware, consumers.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerRouteMap(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'route_map',
    {
      description: 'Show API route mappings: which handler serves which route, middleware chain, and which consumers call each route.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        route: z.string().optional().describe('Filter by route path (e.g. "/api/search")'),
      },
    },
    async ({ projectId, route }) => {
      try {
        const nameFilter = route ? ` AND n.name CONTAINS $route` : '';
        const query = `
          MATCH (n:Route)
          WHERE n.projectId = $projectId${nameFilter}
          OPTIONAL MATCH (handler:File)-[:CODE_RELATION {type: 'HANDLES_ROUTE'}]->(n)
          OPTIONAL MATCH (consumer)-[:CODE_RELATION {type: 'FETCHES'}]->(n)
          RETURN n.name AS route, n.filePath AS handlerFile, n.method AS method,
                 n.middleware AS middleware,
                 collect(DISTINCT {name: consumer.name, file: consumer.filePath}) AS consumers
        `;
        const result = await stores.graph.query(query, { projectId, route: route ?? '' });

        const routes = (result ?? []).map((r: any) => ({
          route: r.route,
          handler: r.handlerFile || '',
          method: r.method || '',
          middleware: r.middleware || [],
          consumers: (r.consumers || []).filter((c: any) => c.name),
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ routes, total: routes.length }, null, 2),
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
