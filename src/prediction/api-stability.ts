/**
 * API stability scoring — computes route stability from temporal change data.
 *
 * Queries Route nodes and their handler change history (CHANGED_IN relations)
 * to produce stability scores. Routes that change frequently are classified
 * as "volatile", while rarely-changed ones are "stable".
 *
 * Design decisions:
 * - Queries Route nodes via CODE_RELATION {type: 'HANDLES_ROUTE'} pattern.
 * - For each handler File, counts CHANGED_IN relations to measure change frequency.
 * - Uses a single batch query instead of N sequential queries for performance.
 * - Stability formula: max(0, 1 - changeCount * 0.1) — more changes = less stable.
 *   This simple v1 formula avoids edge cases with project age calculations.
 * - Stability levels: stable (0.8-1.0), moderate (0.5-0.8), volatile (0-0.5).
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { ApiStabilityScore } from "./types.js";

/**
 * Calculate API stability scores for all route handlers in a project.
 *
 * Route nodes inherit change history from their handler File nodes.
 * Uses a single batch query to count CHANGED_IN for all handlers.
 */
export async function calculateApiStability(
  projectId: string,
  graphStore: IGraphStore,
): Promise<ApiStabilityScore[]> {
  // Single batch query: find Route→handler File pairs, count CHANGED_IN per handler
  // Uses labels on handler:File, route:Route to leverage per-label indexes
  const routeResults = await graphStore.query(
    `MATCH (handler:File)-[r:CODE_RELATION {type: 'HANDLES_ROUTE'}]->(route:Route)
     WHERE route.projectId = $projectId
     WITH handler, route
     OPTIONAL MATCH (handler)-[change:CODE_RELATION {type: 'CHANGED_IN'}]->(c:Commit)
     RETURN handler.id AS handlerId, route.name AS routeName, route.filePath AS routeFile,
            count(DISTINCT c) AS changeCount,
            max(c.timestamp) AS lastChangedAt, min(c.timestamp) AS firstChangedAt`,
    { projectId },
  );

  if (routeResults.length === 0) {
    return [];
  }

  const scores: ApiStabilityScore[] = [];

  for (const routeRow of routeResults) {
    const routeName = routeRow.routeName as string;
    const routeFile = routeRow.routeFile as string;
    const apiPath = routeName || routeFile || (routeRow.handlerId as string);

    const changeCount =
      typeof routeRow.changeCount === "number"
        ? routeRow.changeCount
        : Number(routeRow.changeCount ?? 0);
    const lastChangedAt = (routeRow.lastChangedAt as string) ?? "";
    const firstChangedAt = (routeRow.firstChangedAt as string) ?? "";

    // Calculate change frequency
    let changeFrequency = 0;
    if (firstChangedAt && lastChangedAt) {
      const first = new Date(firstChangedAt);
      const last = new Date(lastChangedAt);
      const diffMs = last.getTime() - first.getTime();
      const monthsAge = diffMs / (1000 * 60 * 60 * 24 * 30.44);
      if (monthsAge >= 1) {
        changeFrequency = changeCount / monthsAge;
      } else {
        changeFrequency = changeCount; // less than a month, use raw count
      }
    } else {
      changeFrequency = changeCount;
    }

    // Calculate stability: more changes = less stable
    const stability = Math.max(0, Math.min(1, 1 - changeCount * 0.1));

    // Determine stability level
    let stabilityLevel: "stable" | "moderate" | "volatile";
    if (stability >= 0.8) {
      stabilityLevel = "stable";
    } else if (stability >= 0.5) {
      stabilityLevel = "moderate";
    } else {
      stabilityLevel = "volatile";
    }

    scores.push({
      apiPath,
      stability,
      changeFrequency,
      lastChangedAt,
      stabilityLevel,
    });
  }

  return scores;
}
