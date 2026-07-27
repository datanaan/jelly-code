import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerListDependencies } from "../../src/mcp/tools/list-dependencies.js";
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

describe("list_dependencies MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return external packages", async () => {
    stores = createMockStores([
      [
        { packagePath: "node_modules/zod", usageCount: 42, usedBy: ["src/api/users.ts", "src/core/validation.ts"] },
        { packagePath: "node_modules/express", usageCount: 28, usedBy: ["src/api/routes.ts"] },
      ],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("list_dependencies");

    const result = await tool.handler({ projectId: "test-proj", scope: "external" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalExternal).toBe(2);
    expect(parsed.externalPackages[0].name).toBe("zod");
    expect(parsed.externalPackages[0].usageCount).toBe(42);
    expect(parsed.totalInternalModules).toBe(0);
  });

  it("should return internal modules", async () => {
    stores = createMockStores([
      [
        { module: "src/utils", importCount: 15, fileCount: 3, consumerCount: 5 },
        { module: "src/api", importCount: 10, fileCount: 2, consumerCount: 3 },
      ],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", scope: "internal" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalInternalModules).toBe(2);
    expect(parsed.internalModules[0].name).toBe("src/utils");
    expect(parsed.internalModules[0].importCount).toBe(15);
    expect(parsed.totalExternal).toBe(0);
  });

  it("should return both external and internal when scope=all", async () => {
    stores = createMockStores([
      [
        { packagePath: "node_modules/zod", usageCount: 10, usedBy: ["src/a.ts"] },
      ],
      [
        { module: "src/utils", importCount: 5, fileCount: 2, consumerCount: 3 },
      ],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", scope: "all" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalExternal).toBe(1);
    expect(parsed.totalInternalModules).toBe(1);
  });

  it("should handle scoped packages (@scope/name)", async () => {
    stores = createMockStores([
      [
        { packagePath: "node_modules/@angular/core", usageCount: 15, usedBy: ["src/app.ts"] },
        { packagePath: "node_modules/@angular/common", usageCount: 10, usedBy: ["src/app.ts"] },
      ],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", scope: "external" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.externalPackages[0].name).toBe("@angular/core");
    expect(parsed.externalPackages[1].name).toBe("@angular/common");
  });

  it("should pass limit parameter to Cypher query", async () => {
    stores = createMockStores([
      [
        { packagePath: "node_modules/pkg1", usageCount: 50, usedBy: ["src/a.ts"] },
        { packagePath: "node_modules/pkg2", usageCount: 40, usedBy: ["src/b.ts"] },
      ],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    await tool.handler({ projectId: "test-proj", scope: "external", limit: 2 });
    // Verify limit was passed to the Cypher query
    expect(stores.graph.query).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ limit: 2 }));
  });

  it("should return empty when no dependencies exist", async () => {
    stores = createMockStores([
      [],
      [],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", scope: "all" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalExternal).toBe(0);
    expect(parsed.totalInternalModules).toBe(0);
    expect(parsed.externalPackages).toEqual([]);
    expect(parsed.internalModules).toEqual([]);
  });

  it("should handle error from graph query gracefully", async () => {
    const graphStore = {
      query: vi.fn().mockRejectedValue(new Error("Neo4j connection failed")),
    };
    stores = { graph: graphStore, search: {} as any, vector: {} as any, llm: {} as any } as StoreSet;
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Neo4j connection failed");
  });

  it("should default scope to all when not provided", async () => {
    stores = createMockStores([
      [
        { packagePath: "node_modules/zod", usageCount: 10, usedBy: ["src/a.ts"] },
      ],
      [
        { module: "src/utils", importCount: 5, fileCount: 2, consumerCount: 3 },
      ],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalExternal).toBe(1);
    expect(parsed.totalInternalModules).toBe(1);
  });

  it("should return empty external packages when limit=0", async () => {
    stores = createMockStores([
      [],
    ]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", scope: "external", limit: 0 });
    const parsed = JSON.parse(result.content[0].text);
    // LIMIT 0 in Cypher means no results returned
    expect(parsed.totalExternal).toBe(0);
    expect(parsed.externalPackages).toEqual([]);
  });

  it("should handle unknown scope gracefully", async () => {
    stores = createMockStores([]);
    registerListDependencies(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", scope: "unknown" as any });
    const parsed = JSON.parse(result.content[0].text);
    // Unknown scope defaults to running neither query
    expect(parsed.totalExternal).toBe(0);
    expect(parsed.totalInternalModules).toBe(0);
  });
});
