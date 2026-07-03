/**
 * MCP Tool: context
 *
 * Get the full context of a code symbol by ID or name.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { addFreshnessWarnings } from './freshness.js';

export function registerContext(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'context',
    {
      description: 'Get the full context of a code symbol: its definition, inbound dependencies (who uses it), outbound dependencies (what it uses), and surrounding code. Supports lookup by nodeId or by symbol name. Note: community-related data may be stale if communitiesFreshness != fresh. Use project_status to check data freshness.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        nodeId: z.string().optional().describe('Node ID of the symbol (direct lookup)'),
        name: z.string().optional().describe('Symbol name for lookup (alternative to nodeId)'),
        file_path: z.string().optional().describe('File path to disambiguate when name matches multiple symbols'),
        depth: z.number().optional().default(1).describe('Depth of relationship traversal'),
      },
    },
    async ({ projectId, nodeId, name, file_path, depth }) => {
      try {
        // Resolve nodeId from name if needed
        let resolvedId = nodeId;
        if (!resolvedId && name) {
          const candidates = await stores.graph.findSymbol(projectId, name);
          if (candidates.length === 0) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Symbol not found: ${name}` }) }],
              isError: true,
            };
          }

          let matched = candidates;
          // Disambiguate by file path if provided
          if (file_path) {
            const filtered = candidates.filter(c => c.filePath.includes(file_path));
            if (filtered.length > 0) matched = filtered;
          }

          // Prefer Class/Interface over other types
          const preferred = matched.find(c => c.type === 'Class' || c.type === 'Interface');
          resolvedId = (preferred ?? matched[0]).id;
        }

        if (!resolvedId) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either nodeId or name is required' }) }],
            isError: true,
          };
        }

        const node = await stores.graph.getNode(projectId, resolvedId);
        if (!node) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Node not found', nodeId: resolvedId }) }],
            isError: true,
          };
        }

        const inbound = await stores.graph.getInboundRelations(projectId, resolvedId);
        const outbound = await stores.graph.getOutboundRelations(projectId, resolvedId);

        const relatedNodes: Array<{ id: string; name: string; type: string; filePath: string }> = [];
        if ((depth ?? 1) > 1) {
          const relatedIds = new Set([
            ...inbound.map((r) => r.sourceId),
            ...outbound.map((r) => r.targetId),
          ]);
          for (const id of relatedIds) {
            const related = await stores.graph.getNode(projectId, id);
            if (related) {
              relatedNodes.push({ id: related.id, name: related.name, type: related.type, filePath: related.filePath });
            }
          }
        }

        const responseData: Record<string, unknown> = {
          node: {
            id: node.id, name: node.name, type: node.type, filePath: node.filePath,
            startLine: node.startLine, endLine: node.endLine,
            content: node.content?.substring(0, 2000),
          },
          inboundDependencies: inbound.map((r) => ({ type: r.type, sourceId: r.sourceId, confidence: r.confidence })),
          outboundDependencies: outbound.map((r) => ({ type: r.type, targetId: r.targetId, confidence: r.confidence })),
        };
        if ((depth ?? 1) > 1) responseData.relatedNodes = relatedNodes;
        await addFreshnessWarnings(projectId, stores.graph, responseData);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(responseData, null, 2),
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
