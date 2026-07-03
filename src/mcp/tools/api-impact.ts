/**
 * MCP Tool: api_impact
 *
 * Pre-change impact report for API route handlers.
 * Combines route_map + shape_check + impact data.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerApiImpact(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'api_impact',
    {
      description: 'Pre-change impact report for API route handlers. Shows consumers, middleware, response shape mismatches, and risk assessment.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        route: z.string().optional().describe('Route path (e.g. "/api/search")'),
        file: z.string().optional().describe('Handler file path'),
      },
    },
    async ({ projectId, route, file }) => {
      try {
        if (!route && !file) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either "route" or "file" parameter is required' }) }],
            isError: true,
          };
        }

        const routeFilter = route ? ` AND n.name CONTAINS $route` : '';
        const fileFilter = file ? ` AND n.filePath CONTAINS $file` : '';
        const query = `
          MATCH (n:Route)
          WHERE n.projectId = $projectId${routeFilter}${fileFilter}
          OPTIONAL MATCH (consumer)-[fetchRel:CODE_RELATION {type: 'FETCHES'}]->(n)
          RETURN n.name AS route, n.filePath AS handlerFile, n.method AS method,
                 n.middleware AS middleware, n.responseKeys AS responseKeys,
                 collect(DISTINCT {
                   name: consumer.name, file: consumer.filePath,
                   accessedKeys: consumer.accessedKeys
                 }) AS consumers
        `;
        const result = await stores.graph.query(query, { projectId, route: route ?? '', file: file ?? '' });

        const routes: any[] = [];
        const allMismatches: any[] = [];
        let totalConsumers = 0;

        for (const r of (result ?? [])) {
          const consumers = ((r.consumers || []) as any[]).filter((c: any) => c.name);
          totalConsumers += consumers.length;

          const responseKeys = (r.responseKeys ?? []) as string[];
          const allKnownKeys = new Set(responseKeys);

          const routeMismatches: any[] = [];
          for (const c of consumers) {
            const accessedKeys = (c.accessedKeys ?? []) as string[];
            const mismatched = accessedKeys.filter(k => !allKnownKeys.has(k));
            if (mismatched.length > 0) {
              routeMismatches.push({
                consumer: c.name, file: c.file,
                mismatchedKeys: mismatched,
              });
            }
          }
          allMismatches.push(...routeMismatches);

          routes.push({
            route: r.route,
            handler: r.handlerFile,
            method: r.method,
            middleware: r.middleware || [],
            consumers: consumers.map((c: any) => ({ name: c.name, file: c.file })),
            mismatches: routeMismatches,
          });
        }

        // Risk assessment
        const mismatchCount = allMismatches.length;
        let risk = 'LOW';
        if (totalConsumers >= 10 || (mismatchCount >= 4 && totalConsumers >= 4)) risk = 'HIGH';
        else if (totalConsumers >= 4 || mismatchCount > 0) risk = 'MEDIUM';

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              risk,
              summary: `${totalConsumers} consumers, ${mismatchCount} mismatches across ${routes.length} routes`,
              routes,
              mismatches: allMismatches,
            }, null, 2),
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
