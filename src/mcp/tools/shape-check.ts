/**
 * MCP Tool: shape_check
 *
 * Check API response shapes against consumers' property accesses.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerShapeCheck(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'shape_check',
    {
      description: 'Check API response shapes vs consumer access patterns. Detects mismatches where consumers access properties not in the route response.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        route: z.string().optional().describe('Filter by route path'),
      },
    },
    async ({ projectId, route }) => {
      try {
        const nameFilter = route ? ` AND n.name CONTAINS $route` : '';
        const query = `
          MATCH (n)
          WHERE n.type = 'Route' AND n.projectId = $projectId${nameFilter}
          OPTIONAL MATCH (consumer)-[:FETCHES]->(n)
          RETURN n.name AS route, n.filePath AS handlerFile,
                 n.responseKeys AS responseKeys, n.errorKeys AS errorKeys,
                 collect(DISTINCT {
                   name: consumer.name, file: consumer.filePath,
                   accessedKeys: consumer.accessedKeys
                 }) AS consumers
        `;
        const result = await stores.graph.query(query, { projectId, route: route ?? '' });

        const mismatches: any[] = [];
        for (const r of (result ?? [])) {
          const responseKeys = (r.responseKeys ?? []) as string[];
          const errorKeys = (r.errorKeys ?? []) as string[];
          const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

          for (const c of ((r.consumers || []) as any[])) {
            if (!c.name) continue;
            const accessedKeys = (c.accessedKeys ?? []) as string[];
            const mismatched = accessedKeys.filter(k => !allKnownKeys.has(k));
            if (mismatched.length > 0) {
              const fetchCount = (c as any).fetchCount ?? 1;
              mismatches.push({
                route: r.route,
                consumer: c.name,
                consumerFile: c.file,
                accessedKeys,
                responseKeys,
                mismatchedKeys: mismatched,
                mismatchConfidence: fetchCount > 1 ? 'low' : 'high',
              });
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ mismatches, total: mismatches.length }, null, 2),
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
