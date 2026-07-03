/**
 * Community Rebuilder
 *
 * Rebuilds communities from scratch for a project. Used when accumulated
 * changes exceed the threshold or when the user manually triggers a rebuild.
 *
 * Community detection (Leiden) is a global graph property and cannot be
 * done incrementally. This function deletes old Community/Process nodes
 * and re-runs the full detection.
 */

import type { StoreSet } from '../store/interfaces.js';
import type { PipelineResult } from '../types/pipeline.js';

export interface RebuildCommunitiesResult {
  success: boolean;
  communityCount: number;
  durationMs: number;
  error?: string;
}

/**
 * Rebuild communities for a project using the full CALLS/EXTENDS/IMPLEMENTS
 * graph from Neo4j.
 *
 * @param stores - Store set for graph access
 * @param projectId - Project to rebuild communities for
 * @param pipelineResult - Current pipeline result (used for process rebuild)
 * @returns Result indicating success/failure with community count
 */
export async function rebuildCommunities(
  stores: StoreSet,
  projectId: string,
  pipelineResult?: PipelineResult,
): Promise<RebuildCommunitiesResult> {
  const startTime = Date.now();

  try {
    // 1. Delete old Community and Process nodes
    await stores.graph.query(
      `MATCH (n) WHERE n.projectId = $projectId
       AND (n:Community OR n:Process) DETACH DELETE n`,
      { projectId },
    );

    // 2. Load full CALLS/EXTENDS/IMPLEMENTS graph from Neo4j
    // This is used as input to the Leiden algorithm
    const relations = await stores.graph.query(
      `MATCH (n1)-[r:CALLS|EXTENDS|IMPLEMENTS]->(n2)
       WHERE n1.projectId = $projectId AND n2.projectId = $projectId
       AND n1.id IS NOT NULL AND n2.id IS NOT NULL
       RETURN r.type AS type, n1.id AS sourceId, n2.id AS targetId`,
      { projectId },
    );

    // 3. Re-run community detection via pipeline's internal function
    // We need to import dynamically to avoid circular dependencies
    const { processCommunities } = await import('./ingestion/community-processor.js');
    const { createKnowledgeGraph: createGraph } = await import('./graph/graph.js');

    // Create a temporary knowledge graph and add the relations
    const tempGraph = createGraph() as any;
    for (const rel of relations) {
      tempGraph.addEdge(
        rel.sourceId as string,
        rel.targetId as string,
        rel.type as string,
        0.9,
        'community-rebuild',
      );
    }

    // Run community detection
    const communityResult = await processCommunities(tempGraph, (msg) => {
      console.log(`[rebuildCommunities] ${projectId}: ${msg}`);
    });

    // 4. Write community nodes to Neo4j
    const communityNodes = communityResult.communities.map((c: any) => ({
      id: c.id as string,
      type: 'Community' as const,
      projectId,
      name: c.label as string,
      filePath: '',
      heuristicLabel: c.heuristicLabel as string,
      keywords: c.keywords as string[],
      description: c.description as string,
      cohesion: c.cohesion as number,
      symbolCount: c.symbolCount as number,
    }));

    if (communityNodes.length > 0) {
      await stores.graph.batchCreateNodes(communityNodes as any);
    }

    // 5. Check for Leiden timeout fallback: single community with all nodes
    const isTimeoutFallback =
      communityResult.communities.length === 1 &&
      communityResult.memberships.length > 1;

    if (isTimeoutFallback) {
      console.warn(`[rebuildCommunities] ${projectId}: suspicious fallback to single community (possible timeout)`);
    }

    // 6. Update Project freshness
    const freshnessStatus = isTimeoutFallback ? 'error' : 'fresh';
    await stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       SET p.communitiesFreshness = $freshness,
           p.lastCommunityRebuildAt = datetime(),
           p.accumulatedChanges = 0,
           p.lastFullRebuildAt = datetime()`,
      { projectId, freshness: freshnessStatus },
    );

    const durationMs = Date.now() - startTime;
    console.log(`[rebuildCommunities] ${projectId}: ${communityNodes.length} communities, ${durationMs}ms${isTimeoutFallback ? ' (FALLBACK)' : ''}`);

    return {
      success: !isTimeoutFallback,
      communityCount: communityNodes.length,
      durationMs,
      error: isTimeoutFallback ? 'Leiden timeout fallback: all nodes assigned to single community' : undefined,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[rebuildCommunities] ${projectId}: FAILED: ${errorMsg}`);

    // Mark communities as error
    await stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       SET p.communitiesFreshness = 'error',
           p.lastCommunityErrorAt = datetime()`,
      { projectId },
    );

    return {
      success: false,
      communityCount: 0,
      durationMs: Date.now() - startTime,
      error: errorMsg,
    };
  }
}
