import { describe, it, expect, vi } from "vitest";
import { predictCombinedImpact } from "../../src/prediction/combined-impact.js";
import type { CodeNode, BFSResult } from "../../src/store/interfaces.js";

/**
 * Creates a mock IGraphStore with configurable bfsTraverse and query results.
 *
 * bfsResults: map from seed IDs joined by "," to BFSResult
 * queryResults: array of result arrays, consumed in order per call
 */
function createMockGraphStore(options: {
  bfsResults?: Record<string, BFSResult>;
  queryResults?: Record<string, Record<string, unknown>[]>;
}) {
  return {
    bfsTraverse: vi.fn(async (
      _projectId: string,
      seedIds: string[],
      _relTypes: string[],
      _maxDepth: number,
    ): Promise<BFSResult> => {
      const key = seedIds.sort().join(",");
      return options.bfsResults?.[key] ?? { visited: [], edges: [], depths: new Map() };
    }),
    query: vi.fn(async (
      cypher: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      // Extract nodeId from params for CO_CHANGED_WITH queries
      const nodeId = params.nodeId as string;
      const key = nodeId;
      return options.queryResults?.[key] ?? [];
    }),
  } as any;
}

describe("predictCombinedImpact", () => {
  it("should combine structural and historical data", async () => {
    // Structural BFS visits: node-a, node-b, node-c
    // CO_CHANGED_WITH for node-a: [node-b, node-d]
    // CO_CHANGED_WITH for node-b: [node-a]
    // CO_CHANGED_WITH for node-c: []
    const graphStore = createMockGraphStore({
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "node-a", type: "Function", projectId: "p1", name: "fnA", filePath: "a.ts" },
            { id: "node-b", type: "Function", projectId: "p1", name: "fnB", filePath: "b.ts" },
            { id: "node-c", type: "Function", projectId: "p1", name: "fnC", filePath: "c.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {
        "node-a": [{ nodeId: "node-b" }, { nodeId: "node-d" }],
        "node-b": [{ nodeId: "node-a" }],
        "node-c": [],
        "seed-1": [],
      },
    });

    const result = await predictCombinedImpact("p1", ["seed-1"], graphStore);

    // Structural: seed-1, node-a, node-b, node-c
    expect(result.structuralBlast).toHaveLength(4);
    expect(result.structuralBlast).toContain("seed-1");
    expect(result.structuralBlast).toContain("node-a");
    expect(result.structuralBlast).toContain("node-b");
    expect(result.structuralBlast).toContain("node-c");

    // Historical: node-b, node-d, node-a
    expect(result.historicalCoupling).toHaveLength(3);
    expect(result.historicalCoupling).toContain("node-a");
    expect(result.historicalCoupling).toContain("node-b");
    expect(result.historicalCoupling).toContain("node-d");

    // High risk (S ∩ C): node-a, node-b
    expect(result.highRisk).toHaveLength(2);
    expect(result.highRisk).toContain("node-a");
    expect(result.highRisk).toContain("node-b");

    // Hidden (C - S): node-d
    expect(result.hidden).toHaveLength(1);
    expect(result.hidden).toContain("node-d");

    // Combined (S ∪ C): seed-1, node-a, node-b, node-c, node-d
    expect(result.combined).toHaveLength(5);
    expect(result.combined).toContain("seed-1");
    expect(result.combined).toContain("node-a");
    expect(result.combined).toContain("node-b");
    expect(result.combined).toContain("node-c");
    expect(result.combined).toContain("node-d");
  });

  it("should degenerate to pure structural when no CO_CHANGED_WITH data", async () => {
    const graphStore = createMockGraphStore({
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "node-a", type: "Function", projectId: "p1", name: "fnA", filePath: "a.ts" },
            { id: "node-b", type: "Function", projectId: "p1", name: "fnB", filePath: "b.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {}, // no CO_CHANGED_WITH data
    });

    const result = await predictCombinedImpact("p1", ["seed-1"], graphStore);

    // Structural: seed-1, node-a, node-b
    expect(result.structuralBlast).toHaveLength(3);
    expect(result.structuralBlast).toContain("seed-1");

    // No historical coupling
    expect(result.historicalCoupling).toHaveLength(0);

    // No high risk (empty intersection)
    expect(result.highRisk).toHaveLength(0);

    // No hidden nodes
    expect(result.hidden).toHaveLength(0);

    // Combined equals structural
    expect(result.combined).toHaveLength(3);
    expect(result.combined).toEqual(expect.arrayContaining(result.structuralBlast));
  });

  it("should return empty result for empty seed nodes", async () => {
    const graphStore = createMockGraphStore({});

    const result = await predictCombinedImpact("p1", [], graphStore);

    expect(result.structuralBlast).toHaveLength(0);
    expect(result.historicalCoupling).toHaveLength(0);
    expect(result.highRisk).toHaveLength(0);
    expect(result.hidden).toHaveLength(0);
    expect(result.combined).toHaveLength(0);

    // Should not call bfsTraverse or query
    expect(graphStore.bfsTraverse).not.toHaveBeenCalled();
    expect(graphStore.query).not.toHaveBeenCalled();
  });

  it("should correctly compute highRisk as intersection of structural and historical", async () => {
    // S = {seed, a, b, c}
    // C = {a, d}  (only node-a is in both)
    const graphStore = createMockGraphStore({
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "a", type: "Function", projectId: "p1", name: "a", filePath: "a.ts" },
            { id: "b", type: "Function", projectId: "p1", name: "b", filePath: "b.ts" },
            { id: "c", type: "Function", projectId: "p1", name: "c", filePath: "c.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {
        "seed-1": [{ nodeId: "a" }, { nodeId: "d" }],
        "a": [{ nodeId: "d" }],
        "b": [],
        "c": [],
      },
    });

    const result = await predictCombinedImpact("p1", ["seed-1"], graphStore);

    // highRisk = S ∩ C = {a}
    // seed-1: C includes a from seed-1's coupling, but seed-1 itself is in S.
    //   Actually: C = {a, d} (from seed-1: {a, d}, from a: {d}, from b: {}, from c: {})
    //   C = {a, d}
    //   S = {seed-1, a, b, c}
    //   S ∩ C = {a}
    expect(result.highRisk).toEqual(["a"]);
  });

  it("should correctly compute hidden as C minus S", async () => {
    // S = {seed, a}
    // C = {b, c, d}  (all coupled, none in S)
    const graphStore = createMockGraphStore({
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "a", type: "Function", projectId: "p1", name: "a", filePath: "a.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {
        "seed-1": [{ nodeId: "b" }, { nodeId: "c" }],
        "a": [{ nodeId: "d" }],
      },
    });

    const result = await predictCombinedImpact("p1", ["seed-1"], graphStore);

    // S = {seed-1, a}, C = {b, c, d}
    // hidden = C - S = {b, c, d}
    expect(result.hidden).toHaveLength(3);
    expect(result.hidden).toContain("b");
    expect(result.hidden).toContain("c");
    expect(result.hidden).toContain("d");
  });

  it("should correctly compute combined as union of S and C", async () => {
    // S = {seed, a, b}
    // C = {a, c}
    // S ∪ C = {seed, a, b, c}
    const graphStore = createMockGraphStore({
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "a", type: "Function", projectId: "p1", name: "a", filePath: "a.ts" },
            { id: "b", type: "Function", projectId: "p1", name: "b", filePath: "b.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {
        "seed-1": [{ nodeId: "a" }, { nodeId: "c" }],
        "a": [],
        "b": [],
      },
    });

    const result = await predictCombinedImpact("p1", ["seed-1"], graphStore);

    // combined = S ∪ C = {seed-1, a, b, c}
    expect(result.combined).toHaveLength(4);
    expect(result.combined).toContain("seed-1");
    expect(result.combined).toContain("a");
    expect(result.combined).toContain("b");
    expect(result.combined).toContain("c");
  });
});
