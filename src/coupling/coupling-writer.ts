/**
 * Coupling writer — persists CO_CHANGED_WITH relations to the graph store.
 *
 * For each coupling pair (A, B), writes TWO directed relations:
 *   A -[CODE_RELATION {type: 'CO_CHANGED_WITH'}]-> B  (confidenceAtoB)
 *   B -[CODE_RELATION {type: 'CO_CHANGED_WITH'}]-> A  (confidenceBtoA)
 *
 * Uses `batchCreateRelations` which resolves node labels to avoid
 * label-less MATCH (full table scan on 120K+ nodes).
 */

import type { IGraphStore, Relation } from "../store/interfaces.js";
import type { CouplingMetrics } from "./types.js";

const BATCH_SIZE = 500;

/**
 * Write CO_CHANGED_WITH relations to Neo4j.
 * Uses CODE_RELATION {type: 'CO_CHANGED_WITH'} pattern.
 * First deletes existing CO_CHANGED_WITH for the project, then batch writes.
 */
export async function writeCoChangedRelations(
  couplings: CouplingMetrics[],
  projectId: string,
  graphStore: IGraphStore,
  totalCommits: number,
): Promise<void> {
  if (couplings.length === 0) return;

  // Step 1: Delete existing CO_CHANGED_WITH relations for this project
  await graphStore.query(
    `MATCH (a)-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]->(b)
     WHERE a.projectId = $projectId
     DELETE r`,
    { projectId },
  );

  // Step 2: Build Relation[] — two directed relations per coupling pair
  // Use batchCreateRelations which resolves labels for indexed MATCH
  const relations: Relation[] = [];
  for (const m of couplings) {
    // A -> B
    relations.push({
      id: `${m.nodeA}-CO_CHANGED_WITH-${m.nodeB}`,
      sourceId: m.nodeA,
      targetId: m.nodeB,
      type: "CO_CHANGED_WITH",
      confidence: m.confidenceAtoB,
      projectId,
      coChangeCount: m.coChangeCount,
      totalCommits,
      support: m.support,
      lift: m.lift,
    });
    // B -> A
    relations.push({
      id: `${m.nodeB}-CO_CHANGED_WITH-${m.nodeA}`,
      sourceId: m.nodeB,
      targetId: m.nodeA,
      type: "CO_CHANGED_WITH",
      confidence: m.confidenceBtoA,
      projectId,
      coChangeCount: m.coChangeCount,
      totalCommits,
      support: m.support,
      lift: m.lift,
    });
  }

  // Step 3: Batch write via batchCreateRelations (label-aware MATCH)
  for (let i = 0; i < relations.length; i += BATCH_SIZE) {
    const batch = relations.slice(i, i + BATCH_SIZE);
    await graphStore.batchCreateRelations(batch);
  }
}
