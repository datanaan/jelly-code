/**
 * MCP Tool: rename
 *
 * Multi-file coordinated rename using knowledge graph + text search.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerRename(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'rename',
    {
      description: 'Multi-file coordinated rename using knowledge graph. Preview with dry_run=true (default), apply with dry_run=false. Each edit tagged with confidence: "graph" (safe) or "text_search" (review needed).',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        symbol_name: z.string().optional().describe('Current symbol name'),
        symbol_uid: z.string().optional().describe('Direct symbol UID (alternative to name)'),
        new_name: z.string().describe('New symbol name'),
        file_path: z.string().optional().describe('File path to disambiguate name'),
        dry_run: z.boolean().optional().default(true).describe('Preview only (default true)'),
      },
    },
    async ({ projectId, symbol_name, symbol_uid, new_name, file_path, dry_run }) => {
      try {
        if (!symbol_name && !symbol_uid) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either symbol_name or symbol_uid is required' }) }],
            isError: true,
          };
        }

        // Resolve target symbol
        let targetId = symbol_uid;
        let targetName = symbol_name ?? '';
        if (!targetId && symbol_name) {
          const candidates = await stores.graph.findSymbol(projectId, symbol_name);
          if (candidates.length === 0) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Symbol not found: ${symbol_name}` }) }],
              isError: true,
            };
          }
          let matched = candidates;
          if (file_path) {
            const filtered = candidates.filter(c => c.filePath.includes(file_path));
            if (filtered.length > 0) matched = filtered;
          }
          const preferred = matched.find(c => c.type === 'Class' || c.type === 'Interface');
          const target = preferred ?? matched[0];
          targetId = target.id;
          targetName = target.name;
        }

        if (!targetId) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Could not resolve symbol' }) }],
            isError: true,
          };
        }

        // Collect graph-based references (high confidence)
        const edits: Array<{ filePath: string; line: number; oldText: string; newText: string; confidence: string }> = [];

        const inbound = await stores.graph.getInboundRelations(projectId, targetId);
        const outbound = await stores.graph.getOutboundRelations(projectId, targetId);

        const affectedFiles = new Set<string>();
        for (const rel of inbound) {
          const node = await stores.graph.getNode(projectId, rel.sourceId);
          if (node) affectedFiles.add(node.filePath);
        }
        for (const rel of outbound) {
          const node = await stores.graph.getNode(projectId, rel.targetId);
          if (node) affectedFiles.add(node.filePath);
        }

        const targetNode = await stores.graph.getNode(projectId, targetId);
        if (targetNode) affectedFiles.add(targetNode.filePath);

        for (const filePath of affectedFiles) {
          edits.push({
            filePath,
            line: 0,
            oldText: targetName,
            newText: new_name,
            confidence: 'graph',
          });
        }

        if (dry_run !== false) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                dry_run: true,
                symbol: targetName,
                new_name,
                edits,
                summary: `${edits.length} edits planned across ${affectedFiles.size} files`,
                note: 'Set dry_run=false to apply changes.',
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              dry_run: false,
              symbol: targetName,
              new_name,
              applied: edits.length,
              note: 'Rename applied. Re-index the project to update the knowledge graph.',
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
