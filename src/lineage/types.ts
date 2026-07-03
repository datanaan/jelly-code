/**
 * Lineage and drift types for symbol tracking and architecture analysis (Phase 5).
 *
 * These types model symbol rename/move history (lineage), architecture drift
 * detection (structural vs change alignment), and bus factor analysis.
 */

/** Symbol lineage — rename/move history */
export interface SymbolLineage {
  currentId: string;
  history: LineageEntry[];
  originId: string;
}

/** A single entry in the lineage chain */
export interface LineageEntry {
  nodeId: string;
  commitId: string;
  timestamp: string;
  changeType: "renamed" | "moved" | "split" | "merged";
  originalName: string;
  originalFile: string;
}

/** Architecture drift report */
export interface DriftReport {
  projectId: string;
  structuralCommunities: Array<{ communityId: string; memberCount: number }>;
  changeClusters: Array<{ clusterId: string; memberCount: number }>;
  divergenceScore: number;  // 0-1, 0 = perfect alignment, 1 = complete divergence; -1 = no data
  driftedCommunities: Array<{ communityId: string; jaccardSimilarity: number }>;
  message?: string;         // present when no temporal data
}

/** Bus factor report */
export interface BusFactorReport {
  projectId: string;
  busFactor: number;
  criticalAuthors: Array<{
    authorId: string;
    name: string;
    email: string;
    ownedModules: number;
  }>;
  riskModules: Array<{
    moduleId: string;
    moduleName: string;
    soleAuthorId: string;
  }>;
  threshold: number;  // the threshold used for calculation
  message?: string;   // present when no temporal data
}
