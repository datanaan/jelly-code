import { describe, it, expect, vi } from "vitest";
import { detectHotspots, hasTemporalData } from "../../src/coupling/hotspot-detector.js";

function createMockGraphStore(queryResults?: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  return {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockImplementation(() => {
      const results = queryResults?.[callIndex++] ?? [];
      return Promise.resolve(results);
    }),
  } as any;
}

describe("detectHotspots", () => {
  it("should detect hotspots from mock query results", async () => {
    // First call: change counts; second call: age data
    const graphStore = createMockGraphStore([
      [
        { nodeId: "file-a.ts", changeCount: 120 },
        { nodeId: "file-b.ts", changeCount: 30 },
        { nodeId: "file-c.ts", changeCount: 3 },
      ],
      [
        { firstCommit: "2026-01-01T00:00:00Z", lastCommit: "2026-05-01T00:00:00Z" },
      ],
    ]);

    const hotspots = await detectHotspots("proj-1", graphStore);

    expect(hotspots).toHaveLength(3);
    expect(hotspots[0].nodeId).toBe("file-a.ts");
    expect(hotspots[0].changeCount).toBe(120);
    // 120 changes over ~4 months = 30 changes/month
    expect(hotspots[0].changeFrequency).toBeGreaterThan(0);
  });

  it("should classify risk levels correctly", async () => {
    // Custom thresholds: high > 10, medium >= 3
    const graphStore = createMockGraphStore([
      [
        { nodeId: "high-risk", changeCount: 60 },
        { nodeId: "medium-risk", changeCount: 10 },
        { nodeId: "low-risk", changeCount: 1 },
      ],
      [
        { firstCommit: "2026-01-01T00:00:00Z", lastCommit: "2026-03-01T00:00:00Z" },
      ],
    ]);

    const hotspots = await detectHotspots("proj-1", graphStore, {
      riskThresholds: { high: 10, medium: 3 },
    });

    // With ~2 months age:
    // high-risk: 60/2 = 30/month > 10 → high
    // medium-risk: 10/2 = 5/month, 3 <= 5 <= 10 → medium
    // low-risk: 1/2 = 0.5/month < 3 → low
    expect(hotspots[0].riskLevel).toBe("high");
    expect(hotspots[1].riskLevel).toBe("medium");
    expect(hotspots[2].riskLevel).toBe("low");
  });
});

describe("hasTemporalData", () => {
  it("should return true when commits exist", async () => {
    const graphStore = createMockGraphStore([
      [{ hasData: true }],
    ]);

    const result = await hasTemporalData("proj-1", graphStore);

    expect(result).toBe(true);
    expect(graphStore.query).toHaveBeenCalledTimes(1);
    const call = graphStore.query.mock.calls[0];
    expect(call[0]).toContain("Commit");
    expect(call[1]).toEqual({ projectId: "proj-1" });
  });

  it("should return false when no commits exist", async () => {
    const graphStore = createMockGraphStore([
      [{ hasData: false }],
    ]);

    const result = await hasTemporalData("proj-1", graphStore);

    expect(result).toBe(false);
  });
});
