/**
 * MCP Tool: list_repos
 *
 * List all indexed projects (repositories).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';

export function registerListRepos(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'list_repos',
    {
      description: 'List all indexed code repositories (projects). Returns project IDs and metadata.',
    },
    async () => {
      try {
        const projectIds = await stores.graph.listProjects();

        const projects = await Promise.all(
          projectIds.map(async (id) => {
            try {
              const result = await stores.graph.query(
                'MATCH (p:Project {id: $id}) RETURN p.nodeCount AS nodeCount, p.relationCount AS relationCount, p.analyzedAt AS analyzedAt, p.gitUrl AS gitUrl, p.localPath AS localPath, p.lastCommit AS lastCommit',
                { id },
              );
              const data = result[0] as Record<string, unknown> | undefined;
              return {
                id,
                nodeCount: data?.nodeCount ?? 0,
                relationCount: data?.relationCount ?? 0,
                analyzedAt: data?.analyzedAt ?? null,
                gitUrl: data?.gitUrl ?? null,
                localPath: data?.localPath ?? null,
                lastCommit: data?.lastCommit ?? null,
              };
            } catch {
              return { id, nodeCount: 0, relationCount: 0, analyzedAt: null };
            }
          }),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ projects, count: projects.length }, null, 2),
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
