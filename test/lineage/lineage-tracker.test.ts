import { describe, it, expect, vi } from "vitest";
import { traceLineage, findOrigin, getLineageTimeline } from "../../src/lineage/lineage-tracker.js";

function createMockGraphStore(queryResults?: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  return {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockImplementation(() => {
      const results = queryResults?.[callIndex++] ?? [];
      return Promise.resolve(results);
    }),
  } as any;
}

describe("traceLineage", () => {
  it("should return 2-entry lineage for a single rename", async () => {
    // Node C evolved from node B (one rename step)
    const graphStore = createMockGraphStore([
      // First call: C evolved from B
      [
        {
          nodeId: "node-b",
          commitId: "commit-2",
          timestamp: "2026-03-01T00:00:00Z",
          originalName: "oldFunc",
          originalFile: "old.ts",
        },
      ],
      // Second call: B has no EVOLVED_FROM
      [],
    ]);

    const result = await traceLineage("proj-1", "node-c", graphStore);

    expect(result.currentId).toBe("node-c");
    expect(result.history).toHaveLength(1);
    expect(result.history[0].nodeId).toBe("node-b");
    expect(result.originId).toBe("node-b");
  });

  it("should return full chain for rename A→B→C (3 entries)", async () => {
    // Node C evolved from B, B evolved from A
    const graphStore = createMockGraphStore([
      // First call: C evolved from B
      [
        {
          nodeId: "node-b",
          commitId: "commit-2",
          timestamp: "2026-03-01T00:00:00Z",
          originalName: "funcB",
          originalFile: "b.ts",
        },
      ],
      // Second call: B evolved from A
      [
        {
          nodeId: "node-a",
          commitId: "commit-1",
          timestamp: "2026-01-01T00:00:00Z",
          originalName: "funcA",
          originalFile: "a.ts",
        },
      ],
      // Third call: A has no EVOLVED_FROM
      [],
    ]);

    const result = await traceLineage("proj-1", "node-c", graphStore);

    expect(result.currentId).toBe("node-c");
    expect(result.history).toHaveLength(2);
    expect(result.history[0].nodeId).toBe("node-b");
    expect(result.history[1].nodeId).toBe("node-a");
    expect(result.originId).toBe("node-a");
  });

  it("should detect cycles and stop traversal", async () => {
    // C evolved from B, B evolved from C (cycle!)
    const graphStore = createMockGraphStore([
      // First call: C evolved from B
      [
        {
          nodeId: "node-b",
          commitId: "commit-1",
          timestamp: "2026-02-01T00:00:00Z",
          originalName: "funcB",
          originalFile: "b.ts",
        },
      ],
      // Second call: B evolved from C (cycle)
      [
        {
          nodeId: "node-c",
          commitId: "commit-0",
          timestamp: "2026-01-01T00:00:00Z",
          originalName: "funcC",
          originalFile: "c.ts",
        },
      ],
    ]);

    const result = await traceLineage("proj-1", "node-c", graphStore);

    // Should stop after detecting node-c was already visited
    expect(result.history).toHaveLength(1);
    expect(result.history[0].nodeId).toBe("node-b");
    expect(result.originId).toBe("node-b");
  });

  it("should respect max depth limit", async () => {
    // Create a chain of 5 nodes, but maxDepth = 2
    const graphStore = createMockGraphStore([
      [
        { nodeId: "node-4", commitId: "c4", timestamp: "2026-04-01T00:00:00Z", originalName: "f4", originalFile: "4.ts" },
      ],
      [
        { nodeId: "node-3", commitId: "c3", timestamp: "2026-03-01T00:00:00Z", originalName: "f3", originalFile: "3.ts" },
      ],
      // Should not reach this point due to depth limit
      [
        { nodeId: "node-2", commitId: "c2", timestamp: "2026-02-01T00:00:00Z", originalName: "f2", originalFile: "2.ts" },
      ],
    ]);

    const result = await traceLineage("proj-1", "node-5", graphStore, 2);

    expect(result.history).toHaveLength(2);
    expect(result.originId).toBe("node-3");
    expect(graphStore.query).toHaveBeenCalledTimes(2);
  });

  it("should return single-element lineage when no EVOLVED_FROM data", async () => {
    const graphStore = createMockGraphStore([
      [],  // No EVOLVED_FROM
    ]);

    const result = await traceLineage("proj-1", "node-x", graphStore);

    expect(result.currentId).toBe("node-x");
    expect(result.history).toHaveLength(0);
    expect(result.originId).toBe("node-x");
  });
});

describe("findOrigin", () => {
  it("should return the root entry of the lineage chain", async () => {
    // Chain: C → B → A
    const graphStore = createMockGraphStore([
      [
        { nodeId: "node-b", commitId: "c2", timestamp: "2026-02-01T00:00:00Z", originalName: "funcB", originalFile: "b.ts" },
      ],
      [
        { nodeId: "node-a", commitId: "c1", timestamp: "2026-01-01T00:00:00Z", originalName: "funcA", originalFile: "a.ts" },
      ],
      [],
    ]);

    const origin = await findOrigin("proj-1", "node-c", graphStore);

    expect(origin).not.toBeNull();
    expect(origin!.nodeId).toBe("node-a");
    expect(origin!.originalName).toBe("funcA");
    expect(origin!.originalFile).toBe("a.ts");
  });

  it("should return null when no lineage exists", async () => {
    const graphStore = createMockGraphStore([[]]);

    const origin = await findOrigin("proj-1", "node-x", graphStore);

    expect(origin).toBeNull();
  });
});

describe("getLineageTimeline", () => {
  it("should return lineage entries sorted by timestamp ascending", async () => {
    // Chain returns in reverse chronological order
    const graphStore = createMockGraphStore([
      [
        { nodeId: "node-b", commitId: "c2", timestamp: "2026-03-01T00:00:00Z", originalName: "funcB", originalFile: "b.ts" },
      ],
      [
        { nodeId: "node-a", commitId: "c1", timestamp: "2026-01-01T00:00:00Z", originalName: "funcA", originalFile: "a.ts" },
      ],
      [],
    ]);

    const timeline = await getLineageTimeline("proj-1", "node-c", graphStore);

    expect(timeline).toHaveLength(2);
    // Should be sorted ascending by timestamp
    expect(new Date(timeline[0].timestamp).getTime()).toBeLessThan(
      new Date(timeline[1].timestamp).getTime(),
    );
    expect(timeline[0].nodeId).toBe("node-a");
    expect(timeline[1].nodeId).toBe("node-b");
  });
});
