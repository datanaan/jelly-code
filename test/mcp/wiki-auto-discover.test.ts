import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWikiAutoDiscover } from "../../src/mcp/tools/wiki-auto-discover.js";
import type { WikiService } from "../../src/wiki/service.js";

/**
 * Helper: create a mock WikiService with controllable startAutoDiscover.
 */
function createMockWikiService(taskId = "auto-discover-test-123"): WikiService {
  return {
    startAutoDiscover: vi.fn().mockReturnValue(taskId),
  } as unknown as WikiService;
}

/**
 * Helper: create a mock McpServer that captures registerTool calls.
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

describe("wiki_auto_discover MCP tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let wikiService: WikiService;

  beforeEach(() => {
    server = createMockServer();
    wikiService = createMockWikiService();
  });

  it("should register the tool with correct name and schema", () => {
    registerWikiAutoDiscover(server, wikiService);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("wiki_auto_discover");
    expect(tool.config.description.toLowerCase()).toContain("auto");
    // Input schema should require projectId and repoPath
    expect(tool.config.inputSchema.projectId).toBeDefined();
    expect(tool.config.inputSchema.repoPath).toBeDefined();
  });

  it("should call wikiService.startAutoDiscover and return taskId", async () => {
    registerWikiAutoDiscover(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "test-proj",
      repoPath: "/repos/my-project",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(wikiService.startAutoDiscover).toHaveBeenCalledWith("test-proj", "/repos/my-project");
    expect(parsed.status).toBe("processing");
    expect(parsed.taskId).toBe("auto-discover-test-123");
    expect(parsed.projectId).toBe("test-proj");
    expect(parsed.repoPath).toBe("/repos/my-project");
    expect(parsed.hint).toContain("wiki_status");
  });

  it("should return error response when startAutoDiscover throws", async () => {
    const failingService = {
      startAutoDiscover: vi.fn().mockImplementation(() => {
        throw new Error("Repo path not found");
      }),
    } as unknown as WikiService;

    registerWikiAutoDiscover(server, failingService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "test-proj",
      repoPath: "/bad/path",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain("Repo path not found");
  });

  it("should have optional dir and pattern in the response from auto-discovery", async () => {
    registerWikiAutoDiscover(server, wikiService);

    const tool = server.getTools()[0];
    const result = await tool.handler({
      projectId: "proj-xyz",
      repoPath: "/repos/another",
    });
    const parsed = JSON.parse(result.content[0].text);

    // Auto-discover determines dir/pattern internally via deriveBatchParams.
    // The MCP tool response should indicate auto-discovery mode.
    expect(parsed.mode).toBe("auto-discover");
  });
});
