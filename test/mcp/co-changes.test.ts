import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCoChanges } from "../../src/mcp/tools/co-changes.js";
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

describe("co_changes MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return node-level co-changes when nodeId provided", async () => {
    stores = createMockStores([
      [{ hasData: true }],  // hasTemporalData
      [                     // CO_CHANGED_WITH query for specific node
        { nodeId: "node-b", name: "foo", type: "Function", filePath: "src/foo.ts", support: 0.1, confidence: 0.8, lift: 2.5, coChangeCount: 5 },
        { nodeId: "node-c", name: "bar", type: "Class", filePath: "src/bar.ts", support: 0.02, confidence: 0.3, lift: 1.2, coChangeCount: 1 },
      ],
    ]);

    registerCoChanges(server, stores);

    const tool = server.getTools()[0];
    expect(tool.name).toBe("co_changes");

    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-a", minSupport: 0.01 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.nodeId).toBe("node-a");
    expect(parsed.coChanges).toHaveLength(2);
    expect(parsed.coChanges[0].nodeId).toBe("node-b");
    expect(parsed.total).toBe(2);
  });

  it("should return empty with message when no temporal data", async () => {
    stores = createMockStores([
      [{ hasData: false }],
    ]);

    registerCoChanges(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.coChanges).toEqual([]);
    expect(parsed.message).toContain("No temporal data");
  });

  it("should return project-level co-changes with topN limit", async () => {
    stores = createMockStores([
      [{ hasData: true }],
      [  // All CO_CHANGED_WITH for project
        { nodeAId: "a1", nodeAName: "fn1", nodeAType: "Function", nodeBId: "b1", nodeBName: "fn2", nodeBType: "Function", support: 0.15, confidence: 0.9, lift: 3.0, coChangeCount: 10 },
        { nodeAId: "a2", nodeAName: "cls1", nodeAType: "Class", nodeBId: "b2", nodeBName: "cls2", nodeBType: "Class", support: 0.08, confidence: 0.7, lift: 2.0, coChangeCount: 5 },
        { nodeAId: "a3", nodeAName: "fn3", nodeAType: "Function", nodeBId: "b3", nodeBName: "fn4", nodeBType: "Function", support: 0.03, confidence: 0.4, lift: 1.3, coChangeCount: 2 },
      ],
    ]);

    registerCoChanges(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", minSupport: 0.05, topN: 2 });
    const parsed = JSON.parse(result.content[0].text);

    // minSupport 0.05 filters out the 0.03 entry, topN 2 limits to 2
    expect(parsed.coChanges).toHaveLength(2);
    expect(parsed.coChanges[0].coChangeCount).toBe(10);
    expect(parsed.coChanges[1].coChangeCount).toBe(5);
  });
});
