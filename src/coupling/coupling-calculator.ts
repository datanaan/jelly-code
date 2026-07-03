/**
 * Calculate coupling metrics from co-occurrence data.
 *
 * Computes support, confidence, and lift for each co-occurrence pair,
 * then provides filtering and ranking utilities.
 */

import type { CoOccurrencePair, CouplingMetrics, CouplingThreshold } from "./types.js";
import { DEFAULT_COUPLING_THRESHOLDS } from "./types.js";

/**
 * Calculate coupling metrics (support, confidence, lift) for co-occurrence pairs.
 *
 * @param pairs - Co-occurrence pairs from buildCoOccurrenceMatrix
 * @param commitsTouchingNode - Map of nodeId to number of commits that touch it
 * @param totalCommits - Total number of commits in the analysis window
 * @returns Array of coupling metrics with support, confidence, and lift
 */
export function calculateCouplingMetrics(
  pairs: CoOccurrencePair[],
  commitsTouchingNode: Map<string, number>,
  totalCommits: number,
): CouplingMetrics[] {
  if (totalCommits === 0) {
    return [];
  }

  return pairs.map((pair) => {
    const commitsA = commitsTouchingNode.get(pair.nodeA) ?? 0;
    const commitsB = commitsTouchingNode.get(pair.nodeB) ?? 0;

    const support = pair.coChangeCount / totalCommits;
    const confidenceAtoB = commitsA > 0 ? pair.coChangeCount / commitsA : 0;
    const confidenceBtoA = commitsB > 0 ? pair.coChangeCount / commitsB : 0;

    // support(A) = commitsTouchingA / totalCommits
    // support(B) = commitsTouchingB / totalCommits
    // lift = support(A,B) / (support(A) * support(B))
    const supportA = commitsA / totalCommits;
    const supportB = commitsB / totalCommits;
    const denominator = supportA * supportB;
    const lift = denominator > 0 ? support / denominator : 0;

    return {
      nodeA: pair.nodeA,
      nodeB: pair.nodeB,
      coChangeCount: pair.coChangeCount,
      support,
      confidenceAtoB,
      confidenceBtoA,
      lift,
    };
  });
}

/**
 * Filter noisy couplings using thresholds.
 *
 * Applies all three thresholds with AND logic:
 * - support >= minSupport (default 0.05)
 * - coChangeCount >= minCoChangeCount (default 2)
 * - lift > minLift (default 1.5)
 *
 * @param metrics - Coupling metrics to filter
 * @param thresholds - Optional partial thresholds (merged with defaults)
 * @returns Filtered metrics that pass all thresholds
 */
export function filterNoisyCouplings(
  metrics: CouplingMetrics[],
  thresholds?: Partial<CouplingThreshold>,
): CouplingMetrics[] {
  const t: CouplingThreshold = {
    ...DEFAULT_COUPLING_THRESHOLDS,
    ...thresholds,
  };

  return metrics.filter(
    (m) =>
      m.support >= t.minSupport &&
      m.coChangeCount >= t.minCoChangeCount &&
      m.lift > t.minLift,
  );
}

/**
 * Get top N couplings by confidence (regardless of support).
 *
 * Useful for large repos where support is naturally low.
 * Sorts by confidenceAtoB descending and returns the first N results.
 *
 * @param metrics - Coupling metrics to rank
 * @param n - Maximum number of results to return
 * @returns Top N metrics sorted by confidenceAtoB descending
 */
export function getTopNCouplings(
  metrics: CouplingMetrics[],
  n: number,
): CouplingMetrics[] {
  return [...metrics]
    .sort((a, b) => b.confidenceAtoB - a.confidenceAtoB)
    .slice(0, n);
}
