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

describe("code_ownership MCP tool (extended)", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should include driftReport when includeDrift=true", async () => {
    // hasTemporalData returns true, then calculateEnhancedBusFactor queries Community/AUTHORED_BY,
    // then buildOwnership queries AUTHORED_BY, then detectDrift queries communities + CO_CHANGED_WITH
    stores = createMockStores([
      [{ hasData: true }],  // hasTemporalData
      // calculateEnhancedBusFactor: queryModuleAuthors (Community + AUTHORED_BY)
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
      ],
      // buildOwnership (AUTHORED_BY)
      [
        { nodeId: "n1", authorId: "a1", authorName: "Alice", authorEmail: "a@t.com", changeCount: 10, ownership: 0.9, lastChangeAt: "2026-05-01" },
      ],
      // detectDrift: Community query
      [
        { communityId: "comm-1", members: ["a", "b"] },
      ],
      // detectDrift: CO_CHANGED_WITH query
      [
        { nodeA: "a", nodeB: "b" },
      ],
    ]);

    registerCodeOwnership(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", includeDrift: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.busFactor).toBeDefined();
    expect(parsed.criticalAuthors).toBeDefined();
    expect(parsed.driftReport).toBeDefined();
    expect(parsed.driftReport.projectId).toBe("test-proj");
    expect(parsed.driftReport.divergenceScore).toBeDefined();
  });

  it("should use busFactorThreshold parameter", async () => {
    // Test with a low threshold (0.3)
    stores = createMockStores([
      [{ hasData: true }],  // hasTemporalData
      // calculateEnhancedBusFactor: queryModuleAuthors
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
        { moduleId: "m2", moduleName: "Module2", authorId: "a2", name: "Bob", email: "b@t.com", ownership: 0.8 },
        { moduleId: "m3", moduleName: "Module3", authorId: "a3", name: "Carol", email: "c@t.com", ownership: 0.7 },
      ],
      // buildOwnership
      [
        { nodeId: "n1", authorId: "a1", authorName: "Alice", authorEmail: "a@t.com", changeCount: 10, ownership: 0.9, lastChangeAt: "2026-05-01" },
        { nodeId: "n2", authorId: "a2", authorName: "Bob", authorEmail: "b@t.com", changeCount: 5, ownership: 0.8, lastChangeAt: "2026-04-01" },
        { nodeId: "n3", authorId: "a3", authorName: "Carol", authorEmail: "c@t.com", changeCount: 3, ownership: 0.7, lastChangeAt: "2026-03-01" },
      ],
    ]);

    registerCodeOwnership(server, stores);

    const tool = server.getTools()[0];

    // With threshold 0.3: floor(3 * 0.3) = 0 → removing any 1 author orphans 1 > 0 → busFactor = 1
    const result = await tool.handler({ projectId: "test-proj", busFactorThreshold: 0.3 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.threshold).toBe(0.3);
    expect(parsed.busFactor).toBeDefined();
    // With 3 modules each owned by different authors:
    // threshold=0.3 → orphanThreshold=floor(3*0.3)=0 → remove 1 author → 1 orphaned > 0 → busFactor=1
    expect(parsed.busFactor).toBe(1);
  });

  it("should not include driftReport by default", async () => {
    stores = createMockStores([
      [{ hasData: true }],  // hasTemporalData
      // calculateEnhancedBusFactor
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
      ],
      // buildOwnership
      [
        { nodeId: "n1", authorId: "a1", authorName: "Alice", authorEmail: "a@t.com", changeCount: 10, ownership: 0.9, lastChangeAt: "2026-05-01" },
      ],
    ]);

    registerCodeOwnership(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.busFactor).toBeDefined();
    expect(parsed.driftReport).toBeUndefined();
  });
});
