import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWikiEntityFreshness } from "../../src/mcp/tools/wiki-entity-freshness.js";
import type { WikiService } from "../../src/wiki/service.js";

/**
 * P0c-T7: MCP tool wiki_entity_freshness tests.
 *
 * This tool calls WikiService.getFreshness(projectId) and returns a
 * structured report with 4-state classification (fresh|stale|orphaned|unbound).
 *
 * Tests follow the anti-theatrical-fix protocol:
 * - Mock McpServer captures registrations
 * - Verifies exact tool name (no collision with existing "freshness")
 * - Verifies handler invokes getFreshness
 * - All tests should complete in <100ms
 */

/**
 * Helper: create a mock McpServer that captures registerTool calls.
 * Pattern from wiki-auto-discover.test.ts (P0b-T5).
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
 * Helper: create a mock WikiService with controllable getFreshness.
 */
function createMockWikiService(report?: {
  items: Array<{
    entityId: string;
    entityName: string;
    status: "fresh" | "stale" | "orphaned" | "unbound";
    issue: any;
  }>;
  summary: Record<string, number>;
}): WikiService {
  const defaultReport = {
    items: [
      {
        entityId: "entity-alpha",
        entityName: "Alpha",
        status: "fresh" as const,
        issue: null,
      },
      {
        entityId: "entity-beta",
        entityName: "Beta",
        status: "stale" as const,
        issue: {
          type: "stale",
          entityId: "entity-beta",
          entityName: "Beta",
          description: "Beta is stale",
          severity: "warning",
        },
      },
      {
        entityId: "entity-gamma",
        entityName: "Gamma",
        status: "unbound" as const,
        issue: {
          type: "unbound",
          entityId: "entity-gamma",
          entityName: "Gamma",
          description: "Gamma has no binding",
          severity: "warning",
        },
      },
    ],
    summary: { fresh: 1, stale: 1, orphaned: 0, unbound: 1 },
  };
  return {
    getFreshness: vi.fn().mockResolvedValue(report ?? defaultReport),
  } as unknown as WikiService;
}

describe("wiki_entity_freshness MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register the tool with correct name and schema", () => {
    const wikiService = createMockWikiService();
    registerWikiEntityFreshness(server, wikiService);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];

    // Tool name is exactly "wiki_entity_freshness" (no collision with "freshness")
    expect(tool.name).toBe("wiki_entity_freshness");
    expect(tool.name).not.toBe("freshness");

    // Input schema: projectId required
    expect(tool.config.inputSchema.projectId).toBeDefined();
    // Optional filters: status (enum), entityId (string)
    expect(tool.config.inputSchema.status).toBeDefined();
    expect(tool.config.inputSchema.entityId).toBeDefined();

    // Description should mention freshness
    expect(tool.config.description.toLowerCase()).toContain("freshness");
  });

  it("should call wikiService.getFreshness with correct projectId and return report", async () => {
    const wikiService = createMockWikiService();
    registerWikiEntityFreshness(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "proj-abc" });

    // Verify getFreshness was called with the correct projectId
    expect(wikiService.getFreshness).toHaveBeenCalledTimes(1);
    expect(wikiService.getFreshness).toHaveBeenCalledWith("proj-abc");

    // Verify response structure
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.summary).toEqual({
      fresh: 1,
      stale: 1,
      orphaned: 0,
      unbound: 1,
    });
  });

  it("should return error response when getFreshness throws", async () => {
    const failingService = {
      getFreshness: vi.fn().mockRejectedValue(new Error("Database connection lost")),
    } as unknown as WikiService;

    registerWikiEntityFreshness(server, failingService);

    const tool = server.getTools()[0];
    const result = await tool.handler({ projectId: "proj-fail" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Database connection lost");
  });

  it("should apply status filter and recompute summary for filtered items", async () => {
    const wikiService = createMockWikiService();
    registerWikiEntityFreshness(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-filter",
      status: "stale",
    });

    // getFreshness is called with projectId (filters applied at tool level)
    expect(wikiService.getFreshness).toHaveBeenCalledWith("proj-filter");

    const parsed = JSON.parse(result.content[0].text);
    // Only the stale item should be in the response
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].status).toBe("stale");
    // Summary should reflect only the filtered set
    expect(parsed.summary).toEqual({
      fresh: 0,
      stale: 1,
      orphaned: 0,
      unbound: 0,
    });
  });

  it("should apply entityId filter to narrow results", async () => {
    const wikiService = createMockWikiService();
    registerWikiEntityFreshness(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-ef",
      entityId: "entity-gamma",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].entityId).toBe("entity-gamma");
    expect(parsed.summary).toEqual({
      fresh: 0,
      stale: 0,
      orphaned: 0,
      unbound: 1,
    });
  });
});
