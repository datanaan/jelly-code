/**
 * Architecture drift detector — compares structural communities vs change clusters.
 *
 * Detects architectural drift by comparing the structural decomposition (Leiden
 * communities) with the actual change patterns (CO_CHANGED_WITH connected components).
 * Uses Jaccard similarity to measure alignment between structure and reality.
 *
 * Interpretation:
 * - divergenceScore < 0.3: healthy code organization
 * - 0.3-0.6: mild drift, some modules need reorganization
 * - > 0.6: severe drift, architecture needs restructuring
 * - divergenceScore = -1: no temporal data available
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { DriftReport } from "./types.js";

/**
 * Union-Find data structure for building connected components.
 */
class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    let root = x;
    while (this.parent.get(root)! !== root) {
      // Path compression
      this.parent.set(root, this.parent.get(this.parent.get(root)!)!);
      root = this.parent.get(root)!;
    }
    return root;
  }

  union(x: string, y: string): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;

    const rankX = this.rank.get(rootX) ?? 0;
    const rankY = this.rank.get(rootY) ?? 0;

    if (rankX < rankY) {
      this.parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      this.parent.set(rootY, rootX);
    } else {
      this.parent.set(rootY, rootX);
      this.rank.set(rootX, rankX + 1);
    }
  }
}

/**
 * Compute Jaccard similarity between two sets.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1.0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const unionSize = setA.size + setB.size - intersection;
  if (unionSize === 0) return 1.0;

  return intersection / unionSize;
}

/**
 * Detect architectural drift.
 * Compares structural communities (Leiden) with change clusters (CO_CHANGED_WITH connected components).
 * Uses Jaccard similarity to measure alignment.
 */
export async function detectDrift(
  projectId: string,
  graphStore: IGraphStore,
): Promise<DriftReport> {
  // 1. Get structural communities
  const communityResults = await graphStore.query(
    `MATCH (c:Community {projectId: $projectId})-[r:CODE_RELATION {type: 'MEMBER_OF'}]-(n)
     RETURN c.id AS communityId, collect(n.id) AS members`,
    { projectId },
  );

  // 2. Get change clusters from CO_CHANGED_WITH
  const coChangeResults = await graphStore.query(
    `MATCH (a)-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]-(b)
     WHERE a.projectId = $projectId AND r.support >= 0.05
     RETURN a.id AS nodeA, b.id AS nodeB`,
    { projectId },
  );

  // No temporal data check
  if (coChangeResults.length === 0 && communityResults.length === 0) {
    return {
      projectId,
      structuralCommunities: [],
      changeClusters: [],
      divergenceScore: -1,
      driftedCommunities: [],
      message: "No temporal data or structural communities available for drift analysis",
    };
  }

  if (coChangeResults.length === 0) {
    return {
      projectId,
      structuralCommunities: communityResults.map((r) => ({
        communityId: r.communityId as string,
        memberCount: (r.members as string[]).length,
      })),
      changeClusters: [],
      divergenceScore: -1,
      driftedCommunities: [],
      message: "No temporal data available for drift analysis",
    };
  }

  // Build structural communities as Map<communityId, Set<nodeId>>
  const communities = new Map<string, Set<string>>();
  for (const row of communityResults) {
    const communityId = row.communityId as string;
    const members = (row.members as string[]) || [];
    communities.set(communityId, new Set(members));
  }

  // Build change clusters using Union-Find
  const uf = new UnionFind();
  const allNodes = new Set<string>();
  for (const row of coChangeResults) {
    const nodeA = row.nodeA as string;
    const nodeB = row.nodeB as string;
    uf.union(nodeA, nodeB);
    allNodes.add(nodeA);
    allNodes.add(nodeB);
  }

  // Group nodes by their root to form clusters
  const clusterMap = new Map<string, Set<string>>();
  for (const node of allNodes) {
    const root = uf.find(node);
    if (!clusterMap.has(root)) {
      clusterMap.set(root, new Set());
    }
    clusterMap.get(root)!.add(node);
  }

  // 3. For each structural community, find best-matching change cluster by Jaccard
  const driftedCommunities: Array<{ communityId: string; jaccardSimilarity: number }> = [];
  let totalBestJaccard = 0;

  for (const [communityId, communityMembers] of communities) {
    let bestJaccard = 0;

    for (const [, clusterMembers] of clusterMap) {
      const similarity = jaccardSimilarity(communityMembers, clusterMembers);
      if (similarity > bestJaccard) {
        bestJaccard = similarity;
      }
    }

    totalBestJaccard += bestJaccard;

    if (bestJaccard < 0.5) {
      driftedCommunities.push({ communityId, jaccardSimilarity: bestJaccard });
    }
  }

  // 4. Calculate divergence score
  const communityCount = communities.size;
  const divergenceScore = communityCount > 0
    ? 1 - (totalBestJaccard / communityCount)
    : 0;

  // Build report
  const structuralCommunities = Array.from(communities.entries()).map(
    ([communityId, members]) => ({ communityId, memberCount: members.size }),
  );

  const changeClusters = Array.from(clusterMap.entries()).map(
    ([clusterId, members]) => ({ clusterId, memberCount: members.size }),
  );

  return {
    projectId,
    structuralCommunities,
    changeClusters,
    divergenceScore,
    driftedCommunities,
  };
}

/**
 * Export Jaccard similarity for testing.
 */
export { jaccardSimilarity, UnionFind };
