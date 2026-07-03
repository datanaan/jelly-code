/**
 * Coupling analysis types for evolution coupling detection (Phase 3).
 *
 * These types model co-occurrence pairs, coupling metrics, thresholds,
 * hotspot information, and ownership data used to detect which files
 * and symbols tend to change together.
 */

/** A pair of nodes that co-occurred in commits */
export interface CoOccurrencePair {
  nodeA: string;
  nodeB: string;
  coChangeCount: number;
}

/** Coupling metrics for a pair */
export interface CouplingMetrics {
  nodeA: string;
  nodeB: string;
  coChangeCount: number;
  support: number;        // coChange(A,B) / totalCommits
  confidenceAtoB: number; // coChange(A,B) / commitsTouchingA
  confidenceBtoA: number; // coChange(A,B) / commitsTouchingB
  lift: number;           // support(A,B) / (support(A) * support(B))
}

/** Thresholds for filtering noisy couplings */
export interface CouplingThreshold {
  minSupport: number;       // default 0.05
  minCoChangeCount: number; // default 2
  minLift: number;          // default 1.5
}

/** Hotspot information for a node */
export interface HotspotInfo {
  nodeId: string;
  changeCount: number;
  changeFrequency: number; // changes per month
  riskLevel: "high" | "medium" | "low";
}

/** Ownership info for a node-author pair */
export interface OwnershipInfo {
  authorId: string;
  authorName: string;
  authorEmail: string;
  changeCount: number;
  ownership: number;       // 0-1
  lastChangeAt: string;
}

export const DEFAULT_COUPLING_THRESHOLDS: CouplingThreshold = {
  minSupport: 0.01,       // co-change in ≥1% of commits (was 0.05, too strict)
  minCoChangeCount: 2,
  minLift: 1.0,           // lift > 1 = positively correlated (was 1.5, too strict)
};
