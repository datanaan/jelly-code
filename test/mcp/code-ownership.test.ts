import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCodeOwnership } from "../../src/mcp/tools/code-ownership.js";
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

describe("code_ownership MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return node-level ownership when nodeId provided", async () => {
    stores = createMockStores([
      [{ hasData: true }],     // hasTemporalData
      [                        // buildOwnership (AUTHORED_BY query)
        { nodeId: "node-1", authorId: "a1", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.8, lastChangeAt: "2026-05-01" },
        { nodeId: "node-1", authorId: "a2", authorName: "Bob", authorEmail: "bob@test.com", changeCount: 2, ownership: 0.2, lastChangeAt: "2026-04-01" },
      ],
      [{ authorId: "a1", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.8, lastChangeAt: "2026-05-01" }], // findExpert
    ]);

    registerCodeOwnership(server, stores);

    const tool = server.getTools()[0];
    expect(tool.name).toBe("code_ownership");

    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-1" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.nodeId).toBe("node-1");
    expect(parsed.owners).toHaveLength(2);
    expect(parsed.expert.authorName).toBe("Alice");
    expect(parsed.totalOwners).toBe(2);
  });

  it("should return empty with message when no temporal data", async () => {
    stores = createMockStores([
      [{ hasData: false }],
    ]);

    registerCodeOwnership(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", nodeId: "node-1" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ownership).toEqual([]);
    expect(parsed.message).toContain("No temporal data");
  });

  it("should return bus factor summary when no nodeId provided", async () => {
    stores = createMockStores([
      [{ hasData: true }],     // hasTemporalData
      [                        // buildOwnership (for calculateBusFactor)
        { nodeId: "n1", authorId: "a1", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.9, lastChangeAt: "2026-05-01" },
        { nodeId: "n2", authorId: "a1", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 5, ownership: 0.7, lastChangeAt: "2026-04-01" },
        { nodeId: "n2", authorId: "a2", authorName: "Bob", authorEmail: "bob@test.com", changeCount: 3, ownership: 0.3, lastChangeAt: "2026-04-15" },
      ],
      // buildOwnership is called again for the project-level summary
      [
        { nodeId: "n1", authorId: "a1", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.9, lastChangeAt: "2026-05-01" },
        { nodeId: "n2", authorId: "a1", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 5, ownership: 0.7, lastChangeAt: "2026-04-01" },
        { nodeId: "n2", authorId: "a2", authorName: "Bob", authorEmail: "bob@test.com", changeCount: 3, ownership: 0.3, lastChangeAt: "2026-04-15" },
      ],
    ]);

    registerCodeOwnership(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.busFactor).toBeDefined();
    expect(parsed.criticalAuthors).toBeDefined();
    expect(parsed.totalModules).toBe(2);
  });
});
