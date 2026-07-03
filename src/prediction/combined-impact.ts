/**
 * Combined impact analysis — structural BFS + historical co-change coupling.
 *
 * Predicts the blast radius of a change by combining:
 * 1. Structural analysis: BFS from seed nodes through CALLS/IMPORTS/EXTENDS/IMPLEMENTS
 * 2. Historical coupling: CO_CHANGED_WITH relations from temporal data
 *
 * The intersection (structural ∩ historical) yields high-confidence predictions.
 * The difference (historical - structural) reveals "hidden" coupling invisible
 * to static analysis alone.
 *
 * If no temporal data exists (no CO_CHANGED_WITH relations), this degenerates
 * to pure structural BFS (C is empty, so highRisk and hidden are empty).
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { ImpactPrediction } from "./types.js";

/**
 * Predict combined impact using structural BFS + historical co-change coupling.
 *
 * Steps:
 * 1. BFS from seed nodes to get structural blast set S
 * 2. For each node in S, query CO_CHANGED_WITH relations to get coupled set C
 * 3. highRisk = S ∩ C (both structural and historical confirmation)
 * 4. hidden = C - S (only historical, invisible to structure)
 * 5. combined = S ∪ C
 *
 * If no temporal data: degenerates to pure structural BFS (C is empty).
 */
export async function predictCombinedImpact(
  projectId: string,
  seedNodeIds: string[],
  graphStore: IGraphStore,
  options?: { maxBfsDepth?: number; minSupport?: number },
): Promise<ImpactPrediction> {
  const maxDepth = options?.maxBfsDepth ?? 3;
  const minSupport = options?.minSupport ?? 0.05;

  // Edge case: no seeds → empty result
  if (seedNodeIds.length === 0) {
    return {
      structuralBlast: [],
      historicalCoupling: [],
      highRisk: [],
      hidden: [],
      combined: [],
    };
  }

  // Step 1: Structural BFS to get blast set S
  const bfsResult = await graphStore.bfsTraverse(
    projectId,
    seedNodeIds,
    ["CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS"],
    maxDepth,
  );

  const structuralSet = new Set(
    bfsResult.visited.map((n) => n.id),
  );
  // Seeds are part of the structural blast
  for (const id of seedNodeIds) {
    structuralSet.add(id);
  }

  // Step 2: For each node in structural set, query CO_CHANGED_WITH to get coupled set C
  const coupledSet = new Set<string>();

  for (const nodeId of structuralSet) {
    const coupled = await graphStore.query(
      `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]-(m)
       WHERE m.projectId = $projectId AND r.support >= $minSupport
       RETURN DISTINCT m.id AS nodeId`,
      { nodeId, projectId, minSupport },
    );

    for (const row of coupled) {
      const coupledId = row.nodeId as string;
      coupledSet.add(coupledId);
    }
  }

  const S = Array.from(structuralSet);
  const C = Array.from(coupledSet);

  // Step 3: highRisk = S ∩ C
  const highRiskSet = new Set<string>();
  for (const id of S) {
    if (coupledSet.has(id)) {
      highRiskSet.add(id);
    }
  }

  // Step 4: hidden = C - S
  const hiddenSet = new Set<string>();
  for (const id of C) {
    if (!structuralSet.has(id)) {
      hiddenSet.add(id);
    }
  }

  // Step 5: combined = S ∪ C
  const combinedSet = new Set([...S, ...C]);

  return {
    structuralBlast: S,
    historicalCoupling: C,
    highRisk: Array.from(highRiskSet),
    hidden: Array.from(hiddenSet),
    combined: Array.from(combinedSet),
  };
}
