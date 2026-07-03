import { describe, it, expect, vi } from "vitest";
import { detectDrift, jaccardSimilarity, UnionFind } from "../../src/lineage/drift-detector.js";

function createMockGraphStore(queryResults?: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  return {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockImplementation(() => {
      const results = queryResults?.[callIndex++] ?? [];
      return Promise.resolve(results);
    }),
  } as any;
}

describe("detectDrift", () => {
  it("should return divergenceScore ≈ 0 for perfect alignment", async () => {
    // Structural communities match exactly with change clusters
    const graphStore = createMockGraphStore([
      // Community query
      [
        { communityId: "comm-1", members: ["a", "b", "c"] },
        { communityId: "comm-2", members: ["d", "e", "f"] },
      ],
      // CO_CHANGED_WITH query — same groupings
      [
        { nodeA: "a", nodeB: "b" },
        { nodeA: "b", nodeB: "c" },
        { nodeA: "d", nodeB: "e" },
        { nodeA: "e", nodeB: "f" },
      ],
    ]);

    const report = await detectDrift("proj-1", graphStore);

    expect(report.divergenceScore).toBeLessThan(0.3);
    expect(report.structuralCommunities).toHaveLength(2);
    expect(report.changeClusters.length).toBeGreaterThanOrEqual(2);
    expect(report.driftedCommunities).toHaveLength(0);
  });

  it("should return divergenceScore ≈ 1 for complete divergence", async () => {
    // Structural communities have completely different groupings than change clusters
    const graphStore = createMockGraphStore([
      // Community query — two groups: {a,b,c} and {d,e,f}
      [
        { communityId: "comm-1", members: ["a", "b", "c"] },
        { communityId: "comm-2", members: ["d", "e", "f"] },
      ],
      // CO_CHANGED_WITH — cross-group changes: {a,d}, {b,e}, {c,f}
      [
        { nodeA: "a", nodeB: "d" },
        { nodeA: "d", nodeB: "a" },
        { nodeA: "b", nodeB: "e" },
        { nodeA: "c", nodeB: "f" },
      ],
    ]);

    const report = await detectDrift("proj-1", graphStore);

    expect(report.divergenceScore).toBeGreaterThan(0.5);
    expect(report.driftedCommunities.length).toBeGreaterThan(0);
  });

  it("should return divergenceScore between 0 and 1 for partial drift", async () => {
    const graphStore = createMockGraphStore([
      // Community query
      [
        { communityId: "comm-1", members: ["a", "b", "c"] },
        { communityId: "comm-2", members: ["d", "e"] },
      ],
      // CO_CHANGED_WITH — partial overlap
      [
        { nodeA: "a", nodeB: "b" },
        { nodeA: "b", nodeB: "c" },
        { nodeA: "d", nodeB: "e" },
        { nodeA: "a", nodeB: "d" },  // cross-group
      ],
    ]);

    const report = await detectDrift("proj-1", graphStore);

    expect(report.divergenceScore).toBeGreaterThan(0);
    expect(report.divergenceScore).toBeLessThan(1);
  });

  it("should return -1 score with message when no temporal data", async () => {
    const graphStore = createMockGraphStore([
      // Community query returns some data
      [
        { communityId: "comm-1", members: ["a", "b"] },
      ],
      // No CO_CHANGED_WITH data
      [],
    ]);

    const report = await detectDrift("proj-1", graphStore);

    expect(report.divergenceScore).toBe(-1);
    expect(report.message).toContain("No temporal data");
  });

  it("should return -1 score when no data at all", async () => {
    const graphStore = createMockGraphStore([
      [],  // No communities
      [],  // No CO_CHANGED_WITH
    ]);

    const report = await detectDrift("proj-1", graphStore);

    expect(report.divergenceScore).toBe(-1);
    expect(report.message).toBeDefined();
  });
});

describe("jaccardSimilarity", () => {
  it("should return 1 for identical sets", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["x", "y", "z"]);

    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it("should return 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);

    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("should compute partial overlap correctly", () => {
    // A = {a, b, c}, B = {b, c, d}
    // Intersection = {b, c} = 2
    // Union = {a, b, c, d} = 4
    // J = 2/4 = 0.5
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);

    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  it("should return 1 for two empty sets", () => {
    const a = new Set<string>();
    const b = new Set<string>();

    expect(jaccardSimilarity(a, b)).toBe(1);
  });
});

describe("UnionFind", () => {
  it("should build correct connected components", () => {
    const uf = new UnionFind();

    // a-b-c are connected, d-e are connected, f is alone
    uf.union("a", "b");
    uf.union("b", "c");
    uf.union("d", "e");

    expect(uf.find("a")).toBe(uf.find("b"));
    expect(uf.find("b")).toBe(uf.find("c"));
    expect(uf.find("d")).toBe(uf.find("e"));
    expect(uf.find("a")).not.toBe(uf.find("d"));
    expect(uf.find("f")).toBe("f");  // isolated
  });

  it("should handle single element", () => {
    const uf = new UnionFind();
    expect(uf.find("solo")).toBe("solo");
  });

  it("should not merge already-connected components", () => {
    const uf = new UnionFind();
    uf.union("x", "y");
    uf.union("x", "y");  // redundant

    expect(uf.find("x")).toBe(uf.find("y"));
  });
});
