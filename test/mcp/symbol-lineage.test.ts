import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSymbolLineage } from "../../src/mcp/tools/symbol-lineage.js";
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

describe("symbol_lineage MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return lineage for a node with history", async () => {
    // traceLineage makes 2 queries:
    // Query 1: finds EVOLVED_FROM relation to prev node
    // Query 2: no more EVOLVED_FROM relations
    stores = createMockStores([
      // First EVOLVED_FROM hop
      [{
        nodeId: "prev-node-1",
        commitId: "commit-abc",
        timestamp: "2026-03-01T00:00:00Z",
        originalName: "oldFunctionName",
        originalFile: "src/old-file.ts",
      }],
      // Second hop: no more history
      [],
    ]);

    registerSymbolLineage(server, stores);

    const tool = server.getTools()[0];
    expect(tool.name).toBe("symbol_lineage");

    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-1" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.currentId).toBe("node-1");
    expect(parsed.originId).toBe("prev-node-1");
    expect(parsed.historyLength).toBe(1);
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history[0].nodeId).toBe("prev-node-1");
    expect(parsed.history[0].originalName).toBe("oldFunctionName");
    // No hint when there is history
    expect(parsed.hint).toBeUndefined();
  });

  it("should return single-element lineage for node with no history", async () => {
    // No EVOLVED_FROM relations found
    stores = createMockStores([
      [], // No EVOLVED_FROM data
    ]);

    registerSymbolLineage(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-solo" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.currentId).toBe("node-solo");
    expect(parsed.originId).toBe("node-solo");
    expect(parsed.historyLength).toBe(0);
    expect(parsed.history).toHaveLength(0);
  });

  it("should return hint when no EVOLVED_FROM data", async () => {
    stores = createMockStores([
      [], // No EVOLVED_FROM data at all
    ]);

    registerSymbolLineage(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-nohistory" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toContain("No EVOLVED_FROM");
    expect(parsed.hint).toContain("lineage data");
  });

  it("should handle errors gracefully", async () => {
    const graphStore = {
      query: vi.fn().mockRejectedValue(new Error("DB connection failed")),
    };
    stores = {
      graph: graphStore,
      search: {} as any,
      vector: {} as any,
      llm: {} as any,
    } as unknown as StoreSet;

    registerSymbolLineage(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-1" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("DB connection failed");
  });
});
