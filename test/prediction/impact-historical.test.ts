import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerImpact } from "../../src/mcp/tools/impact.js";
import type { StoreSet } from "../../src/store/interfaces.js";

/**
 * Helper: create a mock StoreSet with controllable graphStore methods.
 */
function createMockStores(options: {
  findSymbolResults?: Record<string, any[]>;
  getInboundResults?: Record<string, any[]>;
  getOutboundResults?: Record<string, any[]>;
  getNodeResults?: Record<string, any>;
  bfsResults?: Record<string, any>;
  queryResults?: Record<string, any[]>;
}) {
  return {
    graph: {
      findSymbol: vi.fn(async (_projectId: string, name: string) => {
        return options.findSymbolResults?.[name] ?? [];
      }),
      getInboundRelations: vi.fn(async (_projectId: string, nodeId: string) => {
        return options.getInboundResults?.[nodeId] ?? [];
      }),
      getOutboundRelations: vi.fn(async (_projectId: string, nodeId: string) => {
        return options.getOutboundResults?.[nodeId] ?? [];
      }),
      getNode: vi.fn(async (_projectId: string, nodeId: string) => {
        const node = options.getNodeResults?.[nodeId];
        return node ?? null;
      }),
      bfsTraverse: vi.fn(async (_projectId: string, seedIds: string[]) => {
        const key = seedIds.sort().join(",");
        return options.bfsResults?.[key] ?? { visited: [], edges: [], depths: new Map() };
      }),
      query: vi.fn(async (_cypher: string, params: Record<string, unknown>) => {
        const nodeId = params.nodeId as string;
        return options.queryResults?.[nodeId] ?? [];
      }),
    },
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

describe("impact MCP tool with historical data", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should return highRisk and hidden when includeHistorical=true with temporal data", async () => {
    const stores = createMockStores({
      findSymbolResults: {
        "myFunc": [
          { id: "seed-1", type: "Function", name: "myFunc", filePath: "src/app.ts" },
        ],
      },
      getInboundResults: {
        "seed-1": [
          { type: "CALLS", sourceId: "caller-1", targetId: "seed-1" },
        ],
        "caller-1": [],
      },
      getNodeResults: {
        "caller-1": { id: "caller-1", name: "caller", type: "Function", filePath: "src/caller.ts" },
      },
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "caller-1", type: "Function", projectId: "p1", name: "caller", filePath: "src/caller.ts" },
            { id: "coupled-a", type: "Function", projectId: "p1", name: "coupledA", filePath: "src/a.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {
        // CO_CHANGED_WITH for seed-1: coupled-a is in both structural and historical
        "seed-1": [{ nodeId: "coupled-a" }, { nodeId: "hidden-b" }],
        "caller-1": [],
        "coupled-a": [],
      },
    });

    registerImpact(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "p1", target: "myFunc", includeHistorical: true });
    const parsed = JSON.parse(result.content[0].text);

    // Structural BFS found caller-1
    expect(parsed.impactedNodes).toHaveLength(1);
    expect(parsed.impactedNodes[0].id).toBe("caller-1");

    // Historical data present → highRisk and hidden populated
    expect(parsed).toHaveProperty("highRisk");
    expect(parsed).toHaveProperty("hidden");
    expect(parsed).toHaveProperty("combined");

    // highRisk = structural ∩ historical = coupled-a (in both BFS visited and CO_CHANGED_WITH)
    expect(parsed.highRisk).toContain("coupled-a");

    // hidden = historical only, not in structural = hidden-b
    expect(parsed.hidden).toContain("hidden-b");

    // combined = union
    expect(parsed.combined).toContain("seed-1");
    expect(parsed.combined).toContain("coupled-a");
    expect(parsed.combined).toContain("hidden-b");

    expect(parsed.historicalNote).toContain("high-risk");
  });

  it("should return only structural results when includeHistorical=false", async () => {
    const stores = createMockStores({
      findSymbolResults: {
        "myFunc": [
          { id: "seed-1", type: "Function", name: "myFunc", filePath: "src/app.ts" },
        ],
      },
      getInboundResults: {
        "seed-1": [
          { type: "CALLS", sourceId: "caller-1", targetId: "seed-1" },
        ],
        "caller-1": [],
      },
      getNodeResults: {
        "caller-1": { id: "caller-1", name: "caller", type: "Function", filePath: "src/caller.ts" },
      },
    });

    registerImpact(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "p1", target: "myFunc", includeHistorical: false });
    const parsed = JSON.parse(result.content[0].text);

    // Structural BFS found caller-1
    expect(parsed.impactedNodes).toHaveLength(1);
    expect(parsed.impactedNodes[0].id).toBe("caller-1");

    // No historical fields when includeHistorical=false
    expect(parsed).not.toHaveProperty("highRisk");
    expect(parsed).not.toHaveProperty("hidden");
    expect(parsed).not.toHaveProperty("combined");
    expect(parsed).not.toHaveProperty("historicalNote");
  });

  it("should degrade gracefully when no temporal data available", async () => {
    const stores = createMockStores({
      findSymbolResults: {
        "myFunc": [
          { id: "seed-1", type: "Function", name: "myFunc", filePath: "src/app.ts" },
        ],
      },
      getInboundResults: {
        "seed-1": [
          { type: "CALLS", sourceId: "caller-1", targetId: "seed-1" },
        ],
        "caller-1": [],
      },
      getNodeResults: {
        "caller-1": { id: "caller-1", name: "caller", type: "Function", filePath: "src/caller.ts" },
      },
      bfsResults: {
        "seed-1": {
          visited: [
            { id: "caller-1", type: "Function", projectId: "p1", name: "caller", filePath: "src/caller.ts" },
          ],
          edges: [],
          depths: new Map(),
        },
      },
      queryResults: {
        // No CO_CHANGED_WITH data for any node
        "seed-1": [],
        "caller-1": [],
      },
    });

    registerImpact(server, stores);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "p1", target: "myFunc", includeHistorical: true });
    const parsed = JSON.parse(result.content[0].text);

    // Structural results still present
    expect(parsed.impactedNodes).toHaveLength(1);

    // Historical fields present but empty
    expect(parsed.highRisk).toEqual([]);
    expect(parsed.hidden).toEqual([]);
    expect(parsed).toHaveProperty("combined");
    expect(parsed.historicalNote).toContain("No historical co-change data");
  });
});
