/**
 * MCP Server for jelly_code_project
 *
 * Provides code knowledge graph tools via the Model Context Protocol.
 * Supports both stdio and StreamableHTTP transports.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StoreSet } from '../store/interfaces.js';
import type { WikiService } from '../wiki/service.js';
import type { RepoCacheManager } from '../core/repo-cache.js';
import type { TaskManager } from '../task/index.js';
import { registerAllTools } from './tools/index.js';

/** Options for creating an MCP server */
export interface McpServerOptions {
  name?: string;
  version?: string;
  wikiService?: WikiService;
  repoCache?: RepoCacheManager;
  taskManager?: TaskManager;
}

/**
 * Create and configure the MCP server with all tools.
 */
export function createMcpServer(stores: StoreSet, options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: options?.name ?? 'jelly-code',
    version: options?.version ?? '1.1.4',
  });

  // Register all tools
  registerAllTools(server, stores, options?.wikiService, options?.repoCache, options?.taskManager);

  return server;
}

/**
 * Start the MCP server with stdio transport (for CLI usage).
 */
export async function startStdioServer(stores: StoreSet, wikiService?: WikiService, repoCache?: RepoCacheManager): Promise<void> {
  const server = createMcpServer(stores, { wikiService, repoCache });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Server started on stdio transport');
}
