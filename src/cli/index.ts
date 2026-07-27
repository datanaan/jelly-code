#!/usr/bin/env node

/**
 * jelly_code_project CLI
 *
 * Commands:
 *   analyze <path>  - Analyze a code repository
 *   serve           - Start the HTTP server
 *   mcp             - Start MCP stdio transport
 */

import { Command } from 'commander';
import { loadConfig } from '../config/index.js';
import { createStoreSet } from '../store/factory.js';
import { runAnalyze } from '../core/run-analyze.js';
import { startStdioServer } from '../mcp/server.js';
import { WikiService } from '../wiki/service.js';
import { RepoCacheManager } from '../core/repo-cache.js';

const program = new Command();

program
  .name('jelly-code')
  .description('MCP-native, multi-language code knowledge graph service')
  .version('1.1.4');

program
  .command('analyze <repoPath>')
  .description('Analyze a code repository and index it')
  .option('-p, --project-id <id>', 'Project ID', 'default')
  .action(async (repoPath: string, options: { projectId: string }) => {
    try {
      const config = loadConfig();
      const stores = createStoreSet(config);
      const repoCache = new RepoCacheManager(config.repo);

      console.log(`Analyzing: ${repoPath} → project ${options.projectId}`);

      await stores.graph.initializeSchema();
      await runAnalyze(repoPath, options.projectId, stores, { repoCache });

      console.log('Analysis complete!');
      await stores.graph.close();
      await stores.search.close();
      await stores.vector.close();
    } catch (error) {
      console.error('Analysis failed:', error);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start the HTTP server')
  .action(async () => {
    // Dynamic import to start the server
    await import('../server/index.js');
  });

program
  .command('mcp')
  .description('Start MCP stdio transport (for use with AI agents)')
  .option('-p, --project-id <id>', 'Default project ID', 'default')
  .action(async (options: { projectId: string }) => {
    try {
      const config = loadConfig();
      const stores = createStoreSet(config);
      const wikiService = new WikiService(stores, config.wiki);
      const repoCache = new RepoCacheManager(config.repo);

      // Initialize schema before starting
      try {
        await stores.graph.initializeSchema();
      } catch {
        // Schema init may fail if Neo4j is not available
        // but MCP tools will handle this gracefully
      }

      console.error(`[mcp] Starting MCP stdio server (default project: ${options.projectId})`);
      await startStdioServer(stores, wikiService, repoCache);
    } catch (error) {
      console.error('[mcp] Failed to start MCP server:', error);
      process.exit(1);
    }
  });

program.parse();
