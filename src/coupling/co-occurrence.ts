/**
 * Build co-occurrence matrix from commit data.
 *
 * For each commit, every pair of changed nodes that appear together
 * gets their co-change count incremented. This forms the basis for
 * computing coupling metrics like support, confidence, and lift.
 */

import type { CommitData } from "../temporal/types.js";
import type { CoOccurrencePair } from "./types.js";

/**
 * Build a co-occurrence matrix from commit data.
 *
 * For each commit, collect all unique node IDs from its file changes
 * (using fileToNodeMap). For every pair (A, B) where A < B
 * lexicographically, increment their co-change count.
 *
 * @param commits - Array of commit data with changed files/nodes
 * @param fileToNodeMap - Map from file path to node IDs (for mapping file changes to graph nodes)
 * @param timeWindowDays - Only consider commits within this many days (default 365)
 * @returns Array of co-occurrence pairs sorted by count descending
 */
export function buildCoOccurrenceMatrix(
  commits: CommitData[],
  fileToNodeMap: Map<string, string[]>,
  timeWindowDays: number = 365,
): CoOccurrencePair[] {
  const pairCounts = new Map<string, number>();

  // Calculate the cutoff timestamp: use latest commit as "now"
  // (not Date.now(), so the function is deterministic and test-friendly)
  let latestMs = 0;
  for (const c of commits) {
    const ts = new Date(c.timestamp).getTime();
    if (ts > latestMs) latestMs = ts;
  }
  const cutoffMs = latestMs - timeWindowDays * 24 * 60 * 60 * 1000;

  for (const commit of commits) {
    // Filter by time window
    const commitDate = new Date(commit.timestamp).getTime();
    if (commitDate < cutoffMs) {
      continue;
    }

    // Collect all unique node IDs touched by this commit
    const nodeIds = new Set<string>();
    for (const fc of commit.changedFiles) {
      const mapped = fileToNodeMap.get(fc.filePath);
      if (mapped) {
        for (const nodeId of mapped) {
          nodeIds.add(nodeId);
        }
      }
    }

    // Need at least 2 nodes to form a pair
    if (nodeIds.size < 2) {
      continue;
    }

    // Generate all pairs (A, B) where A < B lexicographically
    // Use \0 (null char) as separator — node IDs contain ':' so it can't be used.
    const sorted = Array.from(nodeIds).sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Convert to array and sort by count descending
  const pairs: CoOccurrencePair[] = [];
  for (const [key, count] of pairCounts) {
    const sepIdx = key.indexOf('\0');
    const nodeA = key.substring(0, sepIdx);
    const nodeB = key.substring(sepIdx + 1);
    pairs.push({ nodeA, nodeB, coChangeCount: count });
  }

  pairs.sort((a, b) => b.coChangeCount - a.coChangeCount);
  return pairs;
}
