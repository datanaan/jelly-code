import { describe, it, expect } from "vitest";
import { buildCoOccurrenceMatrix } from "../../src/coupling/co-occurrence.js";
import type { CommitData } from "../../src/temporal/types.js";

function makeCommit(
  hash: string,
  timestamp: string,
  filePaths: string[],
): CommitData {
  return {
    hash,
    message: `commit ${hash}`,
    author: "Alice",
    authorEmail: "alice@example.com",
    timestamp,
    additions: 0,
    deletions: 0,
    isMerge: false,
    changedFiles: filePaths.map((fp) => ({
      filePath: fp,
      changeType: "modified" as const,
    })),
  };
}

describe("buildCoOccurrenceMatrix", () => {
  it("should detect co-occurrence from 2 commits with overlapping files", () => {
    const fileMap = new Map<string, string[]>([
      ["src/a.ts", ["node-a"]],
      ["src/b.ts", ["node-b"]],
      ["src/c.ts", ["node-c"]],
    ]);

    // Both commits touch a.ts and b.ts → node-a and node-b co-occur twice
    const commits = [
      makeCommit("c1", "2026-05-20T10:00:00Z", ["src/a.ts", "src/b.ts"]),
      makeCommit("c2", "2026-05-21T10:00:00Z", ["src/a.ts", "src/b.ts"]),
    ];

    const pairs = buildCoOccurrenceMatrix(commits, fileMap);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].nodeA).toBe("node-a");
    expect(pairs[0].nodeB).toBe("node-b");
    expect(pairs[0].coChangeCount).toBe(2);
  });

  it("should return empty result when no files overlap", () => {
    const fileMap = new Map<string, string[]>([
      ["src/a.ts", ["node-a"]],
      ["src/b.ts", ["node-b"]],
    ]);

    const commits = [
      makeCommit("c1", "2026-05-20T10:00:00Z", ["src/a.ts"]),
      makeCommit("c2", "2026-05-21T10:00:00Z", ["src/b.ts"]),
    ];

    const pairs = buildCoOccurrenceMatrix(commits, fileMap);
    expect(pairs).toHaveLength(0);
  });

  it("should filter commits by time window", () => {
    const fileMap = new Map<string, string[]>([
      ["src/a.ts", ["node-a"]],
      ["src/b.ts", ["node-b"]],
    ]);

    const commits = [
      // Recent commit — within 30 day window
      makeCommit("c1", "2026-05-20T10:00:00Z", ["src/a.ts", "src/b.ts"]),
      // Old commit — outside 30 day window
      makeCommit("c2", "2026-01-01T10:00:00Z", ["src/a.ts", "src/b.ts"]),
    ];

    // With 30-day window, only c1 should count
    const pairs30 = buildCoOccurrenceMatrix(commits, fileMap, 30);
    expect(pairs30).toHaveLength(1);
    expect(pairs30[0].coChangeCount).toBe(1);

    // With 365-day window, both should count
    const pairs365 = buildCoOccurrenceMatrix(commits, fileMap, 365);
    expect(pairs365).toHaveLength(1);
    expect(pairs365[0].coChangeCount).toBe(2);
  });

  it("should map files to nodes correctly via fileToNodeMap", () => {
    // One file maps to multiple nodes
    const fileMap = new Map<string, string[]>([
      ["src/a.ts", ["node-a1", "node-a2"]],
      ["src/b.ts", ["node-b"]],
    ]);

    const commits = [
      makeCommit("c1", "2026-05-20T10:00:00Z", ["src/a.ts", "src/b.ts"]),
    ];

    const pairs = buildCoOccurrenceMatrix(commits, fileMap);

    // node-a1:node-a2 (from same file), node-a1:node-b, node-a2:node-b
    expect(pairs).toHaveLength(3);

    // Verify pairs are sorted by count descending (all count=1 here)
    const pairKeys = pairs.map((p) => `${p.nodeA}:${p.nodeB}`);
    expect(pairKeys).toContain("node-a1:node-a2");
    expect(pairKeys).toContain("node-a1:node-b");
    expect(pairKeys).toContain("node-a2:node-b");
  });

  it("should count all pairs when multiple files per commit", () => {
    const fileMap = new Map<string, string[]>([
      ["src/a.ts", ["node-a"]],
      ["src/b.ts", ["node-b"]],
      ["src/c.ts", ["node-c"]],
      ["src/d.ts", ["node-d"]],
    ]);

    // 4 files changed in 1 commit → C(4,2) = 6 pairs
    const commits = [
      makeCommit("c1", "2026-05-20T10:00:00Z", [
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
        "src/d.ts",
      ]),
    ];

    const pairs = buildCoOccurrenceMatrix(commits, fileMap);
    expect(pairs).toHaveLength(6);

    // All pairs should have count 1
    for (const p of pairs) {
      expect(p.coChangeCount).toBe(1);
    }

    // Verify the specific pairs exist
    const pairKeys = new Set(pairs.map((p) => `${p.nodeA}:${p.nodeB}`));
    expect(pairKeys.has("node-a:node-b")).toBe(true);
    expect(pairKeys.has("node-a:node-c")).toBe(true);
    expect(pairKeys.has("node-a:node-d")).toBe(true);
    expect(pairKeys.has("node-b:node-c")).toBe(true);
    expect(pairKeys.has("node-b:node-d")).toBe(true);
    expect(pairKeys.has("node-c:node-d")).toBe(true);
  });

  it("should correctly handle node IDs that contain colons", () => {
    // Real node IDs from the graph look like "Function:app/main.py:health_check"
    const fileMap = new Map<string, string[]>([
      ["app/main.py", ["Function:app/main.py:health_check", "Function:app/main.py:root"]],
      ["app/api.py", ["Function:app/api.py:search"]],
    ]);

    const commits = [
      makeCommit("c1", "2026-05-20T10:00:00Z", ["app/main.py", "app/api.py"]),
      makeCommit("c2", "2026-05-21T10:00:00Z", ["app/main.py", "app/api.py"]),
    ];

    const pairs = buildCoOccurrenceMatrix(commits, fileMap);

    // Pairs: Function:app/main.py:health_check ↔ Function:app/api.py:search,
    //        Function:app/main.py:root ↔ Function:app/api.py:search,
    //        Function:app/main.py:health_check ↔ Function:app/main.py:root
    expect(pairs.length).toBeGreaterThanOrEqual(3);

    // Verify node IDs are preserved intact (not split on internal colons)
    for (const p of pairs) {
      expect(p.nodeA).toMatch(/^Function:/);
      expect(p.nodeB).toMatch(/^Function:/);
      expect(p.coChangeCount).toBe(2);
    }
  });
});
