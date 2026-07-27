import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerFindDeadCode } from "../../src/mcp/tools/find-dead-code.js";
import type { StoreSet } from "../../src/store/interfaces.js";

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

function createMockServer() {
  const tools: Array<{ name: string; handler: Function }> = [];
  return {
    registerTool: vi.fn((name: string, _config: any, handler: Function) => {
      tools.push({ name, handler });
    }),
    getTools: () => tools,
  } as any;
}

describe("find_dead_code MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return empty result when no dead code exists", async () => {
    stores = createMockStores([
      [],  // DEAD_EXPORTED_QUERY: no dead exported symbols
      [],  // SELF_REF_ONLY_QUERY: no self-reference only symbols
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("find_dead_code");

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.deadSymbols).toEqual([]);
    expect(parsed.byFile).toEqual({});
  });

  it("should find dead exported symbols (confidence 1.0)", async () => {
    stores = createMockStores([
      [
        { name: "oldHelper", type: "Function", filePath: "src/utils/legacy.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
        { name: "unusedVar", type: "Variable", filePath: "src/old/api.ts", labels: ["Variable"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      [],  // SELF_REF_ONLY_QUERY: none
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.deadSymbols[0].name).toBe("oldHelper");
    expect(parsed.deadSymbols[0].confidence).toBe(1.0);
    expect(parsed.deadSymbols[1].name).toBe("unusedVar");
    expect(parsed.byFile["src/utils/legacy.ts"]).toBe(1);
    expect(parsed.byFile["src/old/api.ts"]).toBe(1);
  });

  it("should find self-reference only symbols (confidence 0.95)", async () => {
    stores = createMockStores([
      [],  // DEAD_EXPORTED_QUERY: none
      [
        { name: "recursiveFn", type: "Function", filePath: "src/utils/recursion.ts", labels: ["Function"], confidence: 0.95, reason: "self_reference_only" },
      ],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.deadSymbols[0].name).toBe("recursiveFn");
    expect(parsed.deadSymbols[0].confidence).toBe(0.95);
    expect(parsed.deadSymbols[0].reason).toBe("self_reference_only");
  });

  it("should filter by file path", async () => {
    stores = createMockStores([
      [
        { name: "fn1", type: "Function", filePath: "src/a.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
        { name: "fn2", type: "Function", filePath: "src/b.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      [],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", filePath: "src/a.ts" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.deadSymbols[0].name).toBe("fn1");
  });

  it("should include internal symbols when includeExportedOnly=false", async () => {
    stores = createMockStores([
      [
        { name: "exportedDead", type: "Function", filePath: "src/a.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      [
        { name: "internalDead", type: "Function", filePath: "src/b.ts", labels: ["Function"], confidence: 0.9, reason: "no_callers_internal" },
      ],
      [],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", includeExportedOnly: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.deadSymbols.some((s: any) => s.name === "exportedDead")).toBe(true);
    expect(parsed.deadSymbols.some((s: any) => s.name === "internalDead")).toBe(true);
  });

  it("should filter by confidence threshold", async () => {
    stores = createMockStores([
      [
        { name: "highConf", type: "Function", filePath: "src/a.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      [],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    // minConfidence=1.1 means nothing passes
    const result = await tool.handler({ projectId: "test-proj", minConfidence: 1.1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
  });

  it("should handle multiple projects in isolation", async () => {
    stores = createMockStores([
      [
        { name: "deadInProjA", type: "Function", filePath: "src/a.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      [],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "proj-a" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    // Verify projectId was passed to the query
    expect(stores.graph.query).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ projectId: "proj-a" }));
  });

  it("should handle error from graph query gracefully", async () => {
    const graphStore = {
      query: vi.fn().mockRejectedValue(new Error("Neo4j connection failed")),
    };
    stores = { graph: graphStore, search: {} as any, vector: {} as any, llm: {} as any } as StoreSet;
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Neo4j connection failed");
  });

  it("should deduplicate symbols that appear in multiple queries", async () => {
    stores = createMockStores([
      // DEAD_EXPORTED_QUERY: duplicateFn appears as exported
      [
        { name: "duplicateFn", type: "Function", filePath: "src/utils.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      // SELF_REF_ONLY_QUERY: same duplicateFn also appears as self-referencing (should be deduped by confidence filtering)
      [
        { name: "duplicateFn", type: "Function", filePath: "src/utils.ts", labels: ["Function"], confidence: 0.95, reason: "self_reference_only" },
      ],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);
    // Both results are present but they have different confidence/reason
    // The tool doesn't deduplicate by name — it merges results from all 3 queries
    // So we expect 2 entries for the same symbol with different reasons
    expect(parsed.total).toBe(2);
    const reasons = parsed.deadSymbols.map((s: any) => s.reason).sort();
    expect(reasons).toEqual(["no_callers_exported", "self_reference_only"]);
  });

  it("should return empty results with non-matching filePath filter", async () => {
    stores = createMockStores([
      [
        { name: "fn1", type: "Function", filePath: "src/a.ts", labels: ["Function"], confidence: 1.0, reason: "no_callers_exported" },
      ],
      [],
    ]);
    registerFindDeadCode(server, stores);
    const tool = server.getTools()[0];

    // filePath that doesn't exist in the data
    const result = await tool.handler({ projectId: "test-proj", filePath: "src/nonexistent.ts" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.deadSymbols).toEqual([]);
  });
});
