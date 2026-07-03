import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCodeEvolutionStory } from "../../src/mcp/tools/code-evolution-story.js";
import type { WikiService } from "../../src/wiki/service.js";

/**
 * P2-T6: MCP tool code_evolution_story tests.
 *
 * This tool wraps WikiService.startEvolutionStoryGeneration(projectId, nodeId),
 * kicking off asynchronous narrative generation (P2-T3) and returning a taskId
 * the caller can poll via GET /api/wiki/evolution-story/:topicId.
 *
 * Tests follow the anti-theatrical-fix protocol:
 * - Mock McpServer captures registrations
 * - Verifies exact tool name "code_evolution_story"
 * - Verifies handler invokes startEvolutionStoryGeneration with correct args
 * - Verifies error handling (isError)
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
 * Helper: create a mock WikiService with controllable startEvolutionStoryGeneration.
 */
function createMockWikiService(taskId = "evo-story-test-123"): WikiService {
  return {
    startEvolutionStoryGeneration: vi.fn().mockReturnValue(taskId),
  } as unknown as WikiService;
}

describe("code_evolution_story MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register the tool with correct name and schema", () => {
    const wikiService = createMockWikiService();
    registerCodeEvolutionStory(server, wikiService);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];

    // Tool name is exactly "code_evolution_story"
    expect(tool.name).toBe("code_evolution_story");

    // Input schema: projectId and nodeId required, refresh optional
    expect(tool.config.inputSchema.projectId).toBeDefined();
    expect(tool.config.inputSchema.nodeId).toBeDefined();
    expect(tool.config.inputSchema.refresh).toBeDefined();

    // Description should mention evolution
    expect(tool.config.description.toLowerCase()).toContain("evolution");
  });

  it("should call startEvolutionStoryGeneration with correct projectId and nodeId", async () => {
    const wikiService = createMockWikiService();
    registerCodeEvolutionStory(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-abc",
      nodeId: "node-xyz",
    });

    // Verify the service was called with the correct args
    expect(wikiService.startEvolutionStoryGeneration).toHaveBeenCalledTimes(1);
    expect(wikiService.startEvolutionStoryGeneration).toHaveBeenCalledWith(
      "proj-abc",
      "node-xyz",
    );

    // Verify response structure: taskId + status
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.taskId).toBe("evo-story-test-123");
    expect(parsed.status).toBe("compiling");
  });

  it("should return error response when startEvolutionStoryGeneration throws", async () => {
    const failingService = {
      startEvolutionStoryGeneration: vi
        .fn()
        .mockImplementation(() => {
          throw new Error("Project not found");
        }),
    } as unknown as WikiService;

    registerCodeEvolutionStory(server, failingService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-missing",
      nodeId: "node-1",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Project not found");
  });

  it("should accept optional refresh parameter without breaking", async () => {
    const wikiService = createMockWikiService();
    registerCodeEvolutionStory(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-abc",
      nodeId: "node-xyz",
      refresh: true,
    });

    // Service still receives only (projectId, nodeId)
    expect(wikiService.startEvolutionStoryGeneration).toHaveBeenCalledWith(
      "proj-abc",
      "node-xyz",
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.taskId).toBe("evo-story-test-123");
  });
});
