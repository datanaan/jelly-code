import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAffectedTests } from "../../src/mcp/tools/affected-tests.js";
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

describe("affected_tests MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should find tests that directly import changed files", async () => {
    stores = createMockStores([
      [
        { testFile: "src/api/users.test.ts", changedFile: "src/api/users.ts", reason: "direct_import" },
        { testFile: "src/api/users.test.ts", changedFile: "src/core/auth.ts", reason: "direct_import" },
      ],
      [],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("affected_tests");

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/api/users.ts", "src/core/auth.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.directlyAffected).toHaveLength(2);
    expect(parsed.totalTestFiles).toBe(1);
    expect(parsed.directlyAffected[0].testFile).toBe("src/api/users.test.ts");
  });

  it("should find transitively affected tests via call chains", async () => {
    stores = createMockStores([
      [],
      [
        { testFile: "src/api/integration.test.ts", changedSymbols: ["authenticate"], changedFiles: ["src/core/auth.ts"], reason: "call_chain" },
      ],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/core/auth.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.transitivelyAffected).toHaveLength(1);
    expect(parsed.transitivelyAffected[0].testFile).toBe("src/api/integration.test.ts");
    expect(parsed.transitivelyAffected[0].changedSymbols).toContain("authenticate");
  });

  it("should find untested changed files", async () => {
    stores = createMockStores([
      [],
      [],
      [
        { untestedFile: "src/utils/migration.ts" },
        { untestedFile: "src/old/legacy.ts" },
      ],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/utils/migration.ts", "src/old/legacy.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.untestedChangedFiles).toHaveLength(2);
    expect(parsed.untestedChangedFiles).toContain("src/utils/migration.ts");
  });

  it("should return empty when no tests are affected", async () => {
    stores = createMockStores([
      [],
      [],
      [
        { untestedFile: "src/utils/new.ts" },
      ],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/utils/new.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.directlyAffected).toEqual([]);
    expect(parsed.transitivelyAffected).toEqual([]);
    expect(parsed.totalTestFiles).toBe(0);
    expect(parsed.untestedChangedFiles).toHaveLength(1);
  });

  it("should handle multiple changed files", async () => {
    stores = createMockStores([
      [
        { testFile: "src/a.test.ts", changedFile: "src/a.ts", reason: "direct_import" },
        { testFile: "src/b.test.ts", changedFile: "src/b.ts", reason: "direct_import" },
      ],
      [],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/a.ts", "src/b.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.directlyAffected).toHaveLength(2);
    expect(parsed.totalTestFiles).toBe(2);
  });

  it("should handle empty changed files list", async () => {
    stores = createMockStores([]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: [] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalTestFiles).toBe(0);
    expect(parsed.message).toContain("No changed files provided");
  });

  it("should handle spec file patterns (.spec.)", async () => {
    stores = createMockStores([
      [
        { testFile: "src/api/users.spec.ts", changedFile: "src/api/users.ts", reason: "direct_import" },
      ],
      [],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/api/users.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.directlyAffected).toHaveLength(1);
    expect(parsed.directlyAffected[0].testFile).toBe("src/api/users.spec.ts");
  });

  it("should handle error from graph query gracefully", async () => {
    const graphStore = {
      query: vi.fn().mockRejectedValue(new Error("Neo4j connection failed")),
    };
    stores = { graph: graphStore, search: {} as any, vector: {} as any, llm: {} as any } as StoreSet;
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/a.ts"] });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Neo4j connection failed");
  });

  it("should deduplicate test files across direct and transitive results", async () => {
    stores = createMockStores([
      [
        { testFile: "src/api/users.test.ts", changedFile: "src/api/users.ts", reason: "direct_import" },
      ],
      [
        { testFile: "src/api/users.test.ts", changedSymbols: ["validate"], changedFiles: ["src/api/users.ts"], reason: "call_chain" },
      ],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/api/users.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    // Same test file appears in both direct and transitive, but totalTestFiles should be 1
    expect(parsed.totalTestFiles).toBe(1);
  });

  it("should handle multiple projects with correct projectId filtering", async () => {
    stores = createMockStores([
      [],
      [],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    await tool.handler({ projectId: "proj-specific", changedFiles: ["src/a.ts"] });
    // Verify all queries were called with the correct projectId
    const calls = (stores.graph.query as any).mock.calls;
    for (const call of calls) {
      expect(call[1].projectId).toBe("proj-specific");
    }
  });

  it("should handle deep call chains with multiple hops", async () => {
    stores = createMockStores([
      [],  // DIRECT_TEST_IMPACT: no direct imports from changed files
      [
        { testFile: "src/api/integration.test.ts", changedSymbols: ["authenticate"], changedFiles: ["src/core/auth.ts"], reason: "call_chain" },
        { testFile: "src/api/e2e.test.ts", changedSymbols: ["authenticate", "login"], changedFiles: ["src/core/auth.ts", "src/api/login.ts"], reason: "call_chain" },
      ],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/core/auth.ts", "src/api/login.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.transitivelyAffected).toHaveLength(2);
    expect(parsed.totalTestFiles).toBe(2);
    // Verify transitive results contain symbol-level detail
    expect(parsed.transitivelyAffected[0].changedSymbols).toBeDefined();
    expect(Array.isArray(parsed.transitivelyAffected[0].changedSymbols)).toBe(true);
  });

  it("should deduplicate test files when same file appears via direct and transitive paths", async () => {
    stores = createMockStores([
      [
        { testFile: "src/api/users.test.ts", changedFile: "src/api/users.ts", reason: "direct_import" },
      ],
      [
        { testFile: "src/api/users.test.ts", changedSymbols: ["validate"], changedFiles: ["src/api/users.ts"], reason: "call_chain" },
      ],
      [],
    ]);
    registerAffectedTests(server, stores);
    const tool = server.getTools()[0];

    const result = await tool.handler({ projectId: "test-proj", changedFiles: ["src/api/users.ts"] });
    const parsed = JSON.parse(result.content[0].text);
    // same test file in both, but totalTestFiles should be 1
    expect(parsed.totalTestFiles).toBe(1);
    // Both paths should still be reported separately
    expect(parsed.directlyAffected).toHaveLength(1);
    expect(parsed.transitivelyAffected).toHaveLength(1);
  });
});
