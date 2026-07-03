/**
 * Prediction types for combined impact analysis and API stability scoring (Phase 4).
 *
 * These types model the results of combining structural BFS traversal
 * with historical co-change coupling to predict change impact,
 * plus API route stability scoring from temporal data.
 */

/** Result of combined structural + historical impact analysis */
export interface ImpactPrediction {
  /** Nodes found by structural BFS traversal */
  structuralBlast: string[];
  /** Nodes found by historical co-change coupling */
  historicalCoupling: string[];
  /** Nodes confirmed by BOTH structural and historical (S ∩ C) — high confidence */
  highRisk: string[];
  /** Nodes found ONLY by historical coupling, invisible to structural analysis (C - S) */
  hidden: string[];
  /** Combined unique set (S ∪ C) */
  combined: string[];
}

/** API stability score for a route */
export interface ApiStabilityScore {
  apiPath: string;
  stability: number;       // 0-1
  changeFrequency: number; // changes per month
  lastChangedAt: string;
  stabilityLevel: "stable" | "moderate" | "volatile";
}

/** Analysis level for large repos */
export enum AnalysisLevel {
  /** Git log only — no AST parsing, seconds */
  L0_GIT_LOG = "L0_GIT_LOG",
  /** Full analysis — AST + git + embeddings, minutes to hours */
  L2_FULL = "L2_FULL",
}
