/**
 * Tool registration entry point.
 *
 * Registers all MCP tools on the server instance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import type { WikiService } from '../../wiki/service.js';
import type { RepoCacheManager } from '../../core/repo-cache.js';
import { registerListRepos } from './list-repos.js';
import { registerQuery } from './query.js';
import { registerSearchCode } from './search-code.js';
import { registerSimilarCode } from './similar-code.js';
import { registerContext } from './context.js';
import { registerImpact } from './impact.js';
import { registerDetectChanges } from './detect-changes.js';
import { registerRename } from './rename.js';
import { registerRouteMap } from './route-map.js';
import { registerToolMap } from './tool-map.js';
import { registerShapeCheck } from './shape-check.js';
import { registerApiImpact } from './api-impact.js';
import { registerProjectStatus } from './project-status.js';
import { registerAnalyzeRepo } from './analyze-repo.js';
import { registerIncrementalAnalyze } from './incremental-analyze.js';
import { registerSafeQuery } from './safe-query.js';
import { registerWikiIngest } from './wiki-ingest.js';
import { registerWikiBatchIngest } from './wiki-batch-ingest.js';
import { registerWikiAutoDiscover } from './wiki-auto-discover.js';
import { registerWikiQuery } from './wiki-query.js';
import { registerWikiIndex } from './wiki-index.js';
import { registerWikiStatus } from './wiki-status.js';
import { registerWikiLint } from './wiki-lint.js';
import { registerWikiSync } from './wiki-sync.js';
import { registerWikiAutoFix } from './wiki-auto-fix.js';
import { registerWikiEntityFreshness } from './wiki-entity-freshness.js';
import { registerCodeEvolutionStory } from './code-evolution-story.js';
import { registerHotspots } from './hotspots.js';
import { registerCodeOwnership } from './code-ownership.js';
import { registerCoChanges } from './co-changes.js';
import { registerApiStability } from './api-stability.js';
import { registerSymbolLineage } from './symbol-lineage.js';
import { registerFindDeadCode } from './find-dead-code.js';
import { registerListDependencies } from './list-dependencies.js';
import { registerAffectedTests } from './affected-tests.js';
import { registerCodeAsOf } from './code-as-of.js';
import { registerChangesBetween } from './changes-between.js';
import { createBitemporalQueries } from '../../store/neo4j/bitemporal-queries.js';

export function registerAllTools(server: McpServer, stores: StoreSet, wikiService?: WikiService, repoCache?: RepoCacheManager, taskManager?: import('../../task/index.js').TaskManager): void {
  registerAnalyzeRepo(server, stores, repoCache, taskManager);
  registerSafeQuery(server, stores);
  registerListRepos(server, stores);
  registerQuery(server, stores);
  registerSearchCode(server, stores);
  registerSimilarCode(server, stores);
  registerContext(server, stores);
  registerImpact(server, stores);
  registerDetectChanges(server, stores);
  registerRename(server, stores);
  registerRouteMap(server, stores);
  registerToolMap(server, stores);
  registerShapeCheck(server, stores);
  registerApiImpact(server, stores);
  registerHotspots(server, stores);
  registerCodeOwnership(server, stores);
  registerCoChanges(server, stores);
  registerApiStability(server, stores);
  registerSymbolLineage(server, stores);
  registerFindDeadCode(server, stores);
  registerListDependencies(server, stores);
  registerAffectedTests(server, stores);

  // Bi-temporal point-in-time query tool
  // BitemporalQueries is constructed from stores.graph (always available)
  const bitemporalQueries = createBitemporalQueries(stores.graph);
  registerCodeAsOf(server, bitemporalQueries);
  // v1.3.0 Phase 2 T2-2: changes_between tool (project-wide + node-scoped)
  registerChangesBetween(server, bitemporalQueries);

  // Task status tool (only when taskManager is provided)
  if (taskManager) {
    registerProjectStatus(server, taskManager, stores);
  }

  // Incremental analysis tool (only when repoCache is provided)
  if (repoCache) {
    registerIncrementalAnalyze(server, stores, repoCache, taskManager);
  }

  // Wiki tools (only when wikiService is provided)
  if (wikiService) {
    registerWikiIngest(server, wikiService);
    registerWikiBatchIngest(server, wikiService);
    registerWikiAutoDiscover(server, wikiService);
    registerWikiQuery(server, wikiService);
    registerWikiIndex(server, wikiService);
    registerWikiStatus(server, wikiService);
    registerWikiLint(server, wikiService);
    registerWikiSync(server, wikiService);
    registerWikiEntityFreshness(server, wikiService);
    registerCodeEvolutionStory(server, wikiService);
    // v1.3.0 Phase 2 T2-4: wiki_auto_fix tool (scan + fix + delete-orphaned + undo-auto-derived)
    registerWikiAutoFix(server, wikiService, stores);
  }
}
