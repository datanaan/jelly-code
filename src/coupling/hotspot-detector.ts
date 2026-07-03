/**
 * Hotspot detector — identifies frequently-changed nodes from CHANGED_IN data.
 *
 * Uses the CHANGED_IN relation count per node to compute change frequency
 * and classify risk levels (high / medium / low).
 *
 * Design decisions:
 * - Queries CHANGED_IN relations directly via graphStore.query().
 * - Change frequency = changeCount / project age in months.
 *   Since project age may not be readily available, we approximate using
 *   the first commit timestamp, or fall back to raw changeCount if no
 *   temporal data is available for age calculation.
 * - Default risk thresholds: high (>50/month), medium (10-50/month), low (<10/month).
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { HotspotInfo } from "./types.js";

const DEFAULT_RISK_THRESHOLDS = { high: 50, medium: 10 };

/**
 * Detect hotspot nodes by change frequency.
 * Queries CHANGED_IN relations and aggregates per-node counts.
 */
export async function detectHotspots(
  projectId: string,
  graphStore: IGraphStore,
  options?: { riskThresholds?: { high: number; medium: number } },
): Promise<HotspotInfo[]> {
  const thresholds = options?.riskThresholds ?? DEFAULT_RISK_THRESHOLDS;

  // Get change counts per node
  const changeCounts = await graphStore.query(
    `MATCH (n)-[r:CODE_RELATION {type: 'CHANGED_IN'}]->(c:Commit {projectId: $projectId})
     WHERE n.projectId = $projectId
     RETURN n.id AS nodeId, count(r) AS changeCount
     ORDER BY changeCount DESC`,
    { projectId },
  );

  // Get project age in months from first commit
  const ageResults = await graphStore.query(
    `MATCH (c:Commit {projectId: $projectId})
     RETURN min(c.timestamp) AS firstCommit, max(c.timestamp) AS lastCommit`,
    { projectId },
  );

  const firstCommit = ageResults[0]?.firstCommit as string | null;
  const lastCommit = ageResults[0]?.lastCommit as string | null;

  let monthsAge: number;
  if (firstCommit && lastCommit) {
    const first = new Date(firstCommit);
    const last = new Date(lastCommit);
    const diffMs = last.getTime() - first.getTime();
    monthsAge = diffMs / (1000 * 60 * 60 * 24 * 30.44); // average month
    if (monthsAge < 1) monthsAge = 1; // minimum 1 month to avoid division issues
  } else {
    monthsAge = 1; // fallback
  }

  return changeCounts.map((row) => {
    const nodeId = row.nodeId as string;
    const changeCount =
      typeof row.changeCount === "number"
        ? row.changeCount
        : Number(row.changeCount);
    const changeFrequency = changeCount / monthsAge;

    let riskLevel: "high" | "medium" | "low";
    if (changeFrequency > thresholds.high) {
      riskLevel = "high";
    } else if (changeFrequency >= thresholds.medium) {
      riskLevel = "medium";
    } else {
      riskLevel = "low";
    }

    return { nodeId, changeCount, changeFrequency, riskLevel };
  });
}

/**
 * Check if a project has temporal data.
 * Queries for existence of Commit nodes.
 */
export async function hasTemporalData(
  projectId: string,
  graphStore: IGraphStore,
): Promise<boolean> {
  const results = await graphStore.query(
    `MATCH (c:Commit {projectId: $projectId}) RETURN count(c) > 0 AS hasData`,
    { projectId },
  );

  if (results.length === 0) return false;
  const hasData = results[0].hasData;
  return hasData === true || hasData === 1;
}
