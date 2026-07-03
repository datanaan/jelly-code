import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerApiStability } from "../../src/mcp/tools/api-stability.js";
import type { StoreSet } from "../../src/store/interfaces.js";

/**
 * Helper: create a mock StoreSet with a controllable graphStore.query response.
 * The new calculateApiStability uses a single batch query.
 */
function createMockStores(queryResult: Record<string, unknown>[]) {
  const graphStore = {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockResolvedValue(queryResult),
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

describe("api_stability MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return stability scores for routes with change data", async () => {
    // Single batch query result: route + handler + change stats
    stores = createMockStores([
      {
        handlerId: "handler-1", routeName: "/api/search", routeFile: "routes/search.ts",
        changeCount: 3, lastChangedAt: "2026-05-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
      {
        handlerId: "handler-2", routeName: "/api/health", routeFile: "routes/health.ts",
        changeCount: 1, lastChangedAt: "2026-04-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    registerApiStability(server, stores);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("api_stability");

    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.scores).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(parsed.totalRoutes).toBe(2);
    expect(parsed.filteredBy.apiPath).toBeNull();
    expect(parsed.filteredBy.stabilityBelow).toBeNull();

    // handler-1: 3 changes → stability max(0, 1 - 3*0.1) = 0.7 → moderate
    const search = parsed.scores.find((s: any) => s.apiPath === "/api/search");
    expect(search).toBeDefined();
    expect(search.stability).toBeCloseTo(0.7);
    expect(search.stabilityLevel).toBe("moderate");

    // handler-2: 1 change → stability max(0, 1 - 1*0.1) = 0.9 → stable
    const health = parsed.scores.find((s: any) => s.apiPath === "/api/health");
    expect(health).toBeDefined();
    expect(health.stability).toBeCloseTo(0.9);
    expect(health.stabilityLevel).toBe("stable");
  });

  it("should return empty array with message when no temporal data", async () => {
    stores = createMockStores([]);

    registerApiStability(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.scores).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.message).toContain("No API route stability data");
  });

  it("should filter by apiPath", async () => {
    stores = createMockStores([
      {
        handlerId: "h1", routeName: "/api/search", routeFile: "search.ts",
        changeCount: 2, lastChangedAt: "2026-04-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
      {
        handlerId: "h2", routeName: "/api/users", routeFile: "users.ts",
        changeCount: 5, lastChangedAt: "2026-05-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
      {
        handlerId: "h3", routeName: "/admin/dashboard", routeFile: "admin.ts",
        changeCount: 1, lastChangedAt: "2026-03-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    registerApiStability(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "test-proj", apiPath: "/api/" });
    const parsed = JSON.parse(result.content[0].text);

    // Only /api/search and /api/users match "/api/"
    expect(parsed.scores).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(parsed.totalRoutes).toBe(3);
    expect(parsed.filteredBy.apiPath).toBe("/api/");

    for (const s of parsed.scores) {
      expect(s.apiPath).toContain("/api/");
    }
  });
});
