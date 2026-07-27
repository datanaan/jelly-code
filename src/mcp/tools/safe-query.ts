/**
 * MCP Tool: safe_query
 *
 * Execute a pre-defined safe Cypher query by template name.
 * Only accepts templates from SAFE_CYPHER_TEMPLATES — prevents Cypher injection.
 *
 * Available templates: findSymbol, findSymbolByFile, getNode, bfsTraverse,
 * clearProject, findRelated, listProjects, getConstraints, getProject,
 * findSymbolByName, findSymbolsByProject, resolveLabels, markStale
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { SAFE_CYPHER_TEMPLATES } from '../../store/neo4j/safe-queries.js';

export function registerSafeQuery(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'safe_query',
    {
      description:
        'Execute a pre-defined safe Cypher query by template name. ' +
        'Prevents Cypher injection — only accepts templates from the safe dictionary. ' +
        `Available templates: ${Object.keys(SAFE_CYPHER_TEMPLATES).join(', ')}. ` +
        'Use this instead of raw query() for external-facing query endpoints.',
      inputSchema: {
        templateName: z.string().describe('Name of the safe query template to execute'),
        params: z.string().optional().describe('JSON string of parameterized query parameters'),
      },
    },
    async ({ templateName, params }: { templateName: string; params?: string }, _extra: unknown) => {
      try {
        if (!stores.graph.safeQuery) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'safeQuery not available on this graph store' }) }],
            isError: true,
          };
        }
        const parsedParams: Record<string, unknown> = params ? (() => {
          try { return JSON.parse(params) as Record<string, unknown>; }
          catch { return {}; }
        })() : {};
        const result = await stores.graph.safeQuery(templateName, parsedParams);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );
}
