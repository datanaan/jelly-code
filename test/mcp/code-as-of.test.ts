import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCodeAsOf } from "../../src/mcp/tools/code-as-of.js";
import type { BitemporalQueries, NodeAsOfResult } from "../../src/store/neo4j/bitemporal-queries.js";

/**
 * P1-T7: MCP tool code_as_of tests.
 *
 * This tool wraps BitemporalQueries.findNodeAsOf(projectId, nodeId, time)
 * to expose point-in-time code state queries via MCP.
 *
 * Tests follow the anti-theatrical-fix protocol:
 * - Mock McpServer captures registrations
 * - Mock BitemporalQueries with vi.fn() to verify call args
 * - Verifies exact tool name "code_as_of"
 * - Verifies error handling (isError: true)
 * - All tests should complete in <100ms
 */

/**
 * Helper: create a mock McpServer that captures registerTool calls.
 * Pattern from wiki-entity-freshness.test.ts (P0c-T7).
 */
function createMockServer() {
  const tools: Array<{ name: string; config: any; handler: Function }> = [];
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.push({ name, config, handler });
    }),
    getTools: () => tools,
  } as any;
}

/**
 * Helper: create a mock BitemporalQueries with controllable findNodeAsOf.
 */
function createMockBitemporalQueries(result?: NodeAsOfResult): BitemporalQueries {
  const defaultResult: NodeAsOfResult = {
    node: {
      id: "node-1",
      type: "Function",
      projectId: "proj-1",
      name: "myFunction",
      filePath: "src/main.ts",
      startLine: 10,
      endLine: 20,
      isExported: true,
    },
    relations: [
      {
        sourceId: "node-1",
        targetId: "node-2",
        type: "CALLS",
        confidence: 0.95,
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: null,
        txn_from: "2026-01-01T00:00:00Z",
        txn_to: null,
      },
    ],
  };
  return {
    findNodeAsOf: vi.fn().mockResolvedValue(result ?? defaultResult),
    findRelationsAsOf: vi.fn().mockResolvedValue([]),
    findChangesBetween: vi.fn().mockResolvedValue([]),
    supersedeRelation: vi.fn().mockResolvedValue({ superseded: true }),
  } as unknown as BitemporalQueries;
}

describe("code_as_of MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register the tool with correct name and schema", () => {
    const queries = createMockBitemporalQueries();
    registerCodeAsOf(server, queries);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];

    // Tool name is exactly "code_as_of"
    expect(tool.name).toBe("code_as_of");

    // Input schema: projectId, nodeId, time required; format optional
    expect(tool.config.inputSchema.projectId).toBeDefined();
    expect(tool.config.inputSchema.nodeId).toBeDefined();
    expect(tool.config.inputSchema.time).toBeDefined();
    expect(tool.config.inputSchema.format).toBeDefined();

    // Description should mention point-in-time or as-of
    const desc = tool.config.description.toLowerCase();
    expect(desc.includes("as-of") || desc.includes("point-in-time") || desc.includes("as of")).toBe(true);
  });

  it("should call findNodeAsOf with correct args and return result", async () => {
    const queries = createMockBitemporalQueries();
    registerCodeAsOf(server, queries);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-abc",
      nodeId: "node-42",
      time: "2026-06-01T00:00:00Z",
    });

    // Verify findNodeAsOf was called with exact args
    expect(queries.findNodeAsOf).toHaveBeenCalledTimes(1);
    expect(queries.findNodeAsOf).toHaveBeenCalledWith(
      "proj-abc",
      "node-42",
      "2026-06-01T00:00:00Z",
    );

    // Verify response structure
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.projectId).toBe("proj-abc");
    expect(parsed.nodeId).toBe("node-42");
    expect(parsed.time).toBe("2026-06-01T00:00:00Z");
    expect(parsed.node).not.toBeNull();
    expect(parsed.node.id).toBe("node-1");
    expect(parsed.relations).toHaveLength(1);
    expect(parsed.relations[0].type).toBe("CALLS");
    expect(result.isError).toBeUndefined();
  });

  it("should return error response when findNodeAsOf throws", async () => {
    const failingQueries = {
      findNodeAsOf: vi.fn().mockRejectedValue(new Error("Neo4j connection refused")),
      findRelationsAsOf: vi.fn(),
      findChangesBetween: vi.fn(),
      supersedeRelation: vi.fn(),
    } as unknown as BitemporalQueries;

    registerCodeAsOf(server, failingQueries);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-fail",
      nodeId: "node-x",
      time: "2026-01-01T00:00:00Z",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Neo4j connection refused");
  });

  it("should handle null node (not found) gracefully", async () => {
    const queries = createMockBitemporalQueries({
      node: null,
      relations: [],
    });

    registerCodeAsOf(server, queries);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-missing",
      nodeId: "ghost-node",
      time: "2026-03-01T00:00:00Z",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.node).toBeNull();
    expect(parsed.relations).toHaveLength(0);
    // Should NOT be an error — null node is a valid result
    expect(result.isError).toBeUndefined();
  });

  it("should pass format=diff and include diff representation in response", async () => {
    const queries = createMockBitemporalQueries();
    registerCodeAsOf(server, queries);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-diff",
      nodeId: "node-1",
      time: "2026-06-01T00:00:00Z",
      format: "diff",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.format).toBe("diff");
    expect(parsed.diff).toBeDefined();
    expect(parsed.diff.added).toBeDefined();
    expect(parsed.diff.removed).toBeDefined();
  });
});
