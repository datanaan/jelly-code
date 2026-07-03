import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerHotspots } from "../../src/mcp/tools/hotspots.js";
import type { StoreSet } from "../../src/store/interfaces.js";

/**
 * Helper: create a mock StoreSet with controllable graphStore.query responses.
 */
function createMockStores(queryResults?: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  const graphStore = {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockImplementation(() => {
      const results = queryResults?.[callIndex++] ?? [];
      return Promise.resolve(results);
    }),
  };
  return {
    graph: graphStore,
    search: {} as any,
    vector: {} as any,
    llm: {} as any,
  } as unknown as StoreSet;
}

/**
 * Helper: create a mock McpServer that captures registerTool calls.
 */
function createMockServer() {
  const tools: Array<{ name: string; handler: Function }> = [];
  return {
    registerTool: vi.fn((name: string, _config: any, handler: Function) => {
      tools.push({ name, handler });
    }),
    getTools: () => tools,
  } as any;
}

describe("hotspots MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register the tool and return hotspots data", async () => {
    // hasTemporalData returns true (first call), then detectHotspots uses 2 more calls,
    // then addFreshnessWarnings uses 1 call
    stores = createMockStores([
      [{ hasData: true }],                           // hasTemporalData
      [                                              // detectHotspots: change counts
        { nodeId: "node-high", changeCount: 120 },
        { nodeId: "node-low", changeCount: 5 },
      ],
      [{ firstCommit: "2026-01-01T00:00:00Z", lastCommit: "2026-05-01T00:00:00Z" }], // detectHotspots: age
      [{ sf: "fresh", cf: "fresh", tf: "fresh" }],  // addFreshnessWarnings
    ]);

    registerHotspots(server, stores);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("hotspots");

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.hotspots).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(parsed.filteredBy).toBeNull();
  });

  it("should return empty array with message when no temporal data", async () => {
    stores = createMockStores([
      [{ hasData: false }],  // hasTemporalData returns false
    ]);

    registerHotspots(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.hotspots).toEqual([]);
    expect(parsed.message).toContain("No temporal data");
  });

  it("should filter by riskLevel and respect limit", async () => {
    stores = createMockStores([
      [{ hasData: true }],
      [
        { nodeId: "node-high", changeCount: 120 },
        { nodeId: "node-med", changeCount: 30 },
        { nodeId: "node-low", changeCount: 1 },
      ],
      [{ firstCommit: "2026-01-01T00:00:00Z", lastCommit: "2026-05-01T00:00:00Z" }],
      [{ sf: "fresh", cf: "fresh", tf: "fresh" }],  // addFreshnessWarnings
    ]);

    registerHotspots(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", riskLevel: "high", limit: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.filteredBy).toBe("high");
    // All returned hotspots should have riskLevel "high"
    for (const h of parsed.hotspots) {
      expect(h.riskLevel).toBe("high");
    }
  });
});
