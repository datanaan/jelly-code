/**
 * v1.3.0 Phase 2 T2-1: MCP tool changes_between tests.
 *
 * Tests:
 * - Tool registration with correct name and schema
 * - ISO time passthrough
 * - Natural language time parsing ("last week", "3 days ago")
 * - nodeId provided → calls findChangesBetween
 * - nodeId omitted → calls projectChangesBetween
 * - activeOnly=true filters out superseded edges
 * - activeOnly=false includes superseded edges with valid_to
 * - limit parameter truncates + sets truncated=true
 * - Response format matches ChangesBetweenResult JSON Schema
 * - Error handling (isError: true)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerChangesBetween } from "../../src/mcp/tools/changes-between.js";
import type { BitemporalQueries, ProjectChangeRecord } from "../../src/store/neo4j/bitemporal-queries.js";

// ─── Mock Factories ──────────────────────────────────────────────

function createMockServer() {
  const tools: Array<{ name: string; config: any; handler: Function }> = [];
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.push({ name, config, handler });
    }),
    getTools: () => tools,
  } as any;
}

function createMockBitemporalQueries(
  changesResult?: ProjectChangeRecord[],
): BitemporalQueries {
  const defaultChanges: ProjectChangeRecord[] = [
    {
      sourceNode: { id: "node-a", name: "FunctionA", type: "Function" },
      targetNode: { id: "node-b", name: "FunctionB", type: "Function" },
      relationType: "CALLS",
      valid_from: "2026-07-15T00:00:00Z",
      valid_to: null,
      commitId: "abc123",
    },
    {
      sourceNode: { id: "node-c", name: "ClassC", type: "Class" },
      targetNode: { id: "node-d", name: "ClassD", type: "Class" },
      relationType: "EXTENDS",
      valid_from: "2026-07-10T00:00:00Z",
      valid_to: "2026-07-20T00:00:00Z",
      commitId: "def456",
    },
  ];
  return {
    findNodeAsOf: vi.fn().mockResolvedValue({ node: null, relations: [] }),
    findRelationsAsOf: vi.fn().mockResolvedValue([]),
    findChangesBetween: vi.fn().mockResolvedValue([
      {
        sourceId: "node-a",
        targetId: "node-b",
        type: "CALLS",
        confidence: 0.9,
        valid_from: "2026-07-15T00:00:00Z",
        valid_to: null,
        txn_from: "2026-07-15T00:00:00Z",
        txn_to: null,
      },
    ]),
    supersedeRelation: vi.fn().mockResolvedValue({ superseded: true }),
    closeCrossDomainEdgesForNode: vi.fn().mockResolvedValue(0),
    projectChangesBetween: vi
      .fn()
      .mockResolvedValue(changesResult ?? defaultChanges),
  } as unknown as BitemporalQueries;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("changes_between MCP tool (v1.3.0 T2-1)", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  it("registers tool with correct name and schema", () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("changes_between");

    // CK-6: Schema includes projectId, fromTime, and optional nodeId/limit
    expect(tool.config.inputSchema.projectId).toBeDefined();
    expect(tool.config.inputSchema.fromTime).toBeDefined();
    expect(tool.config.inputSchema.nodeId).toBeDefined();
    expect(tool.config.inputSchema.limit).toBeDefined();
    expect(tool.config.inputSchema.activeOnly).toBeDefined();
    expect(tool.config.inputSchema.relationTypes).toBeDefined();
  });

  it("accepts ISO 8601 timestamps directly", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      toTime: "2026-07-31T00:00:00Z",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeRange.from).toBe("2026-07-01T00:00:00Z");
    expect(data.timeRange.to).toBe("2026-07-31T00:00:00Z");
    expect(queries.projectChangesBetween).toHaveBeenCalledWith(
      "proj-1",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
      expect.objectContaining({
        activeOnly: true,
        limit: 51,
      }),
    );
  });

  it("CK-2: parses natural language time 'last week' to ISO", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "last week",
    });

    const data = JSON.parse(result.content[0].text);
    // Should be a valid ISO timestamp (not the literal string "last week")
    expect(data.timeRange.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(data.timeRange.from).not.toBe("last week");

    // projectChangesBetween was called with parsed ISO, not "last week"
    const callArgs = queries.projectChangesBetween.mock.calls[0];
    expect(callArgs[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("parses '3 days ago' to ISO timestamp", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "3 days ago",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeRange.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults toTime to current time when omitted", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeRange.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls projectChangesBetween when nodeId omitted", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
    });

    expect(queries.projectChangesBetween).toHaveBeenCalled();
    expect(queries.findChangesBetween).not.toHaveBeenCalled();
  });

  it("calls projectChangesBetween with nodeId when nodeId provided", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    await handler({
      projectId: "proj-1",
      nodeId: "node-42",
      fromTime: "2026-07-01T00:00:00Z",
    });

    // v1.3.0 self-audit fix: node-scoped queries now use projectChangesBetween
    // with nodeId option (not findChangesBetween which only returned CODE_RELATION)
    expect(queries.projectChangesBetween).toHaveBeenCalledWith(
      "proj-1",
      "2026-07-01T00:00:00Z",
      expect.any(String),
      expect.objectContaining({
        nodeId: "node-42",
      }),
    );
  });

  it("CK-6: returns structured response with sourceNode/targetNode", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
    });

    const data = JSON.parse(result.content[0].text);
    // CK-6: changes include full node objects, not bare ids
    expect(data.changes[0].sourceNode).toHaveProperty("id");
    expect(data.changes[0].sourceNode).toHaveProperty("name");
    expect(data.changes[0].sourceNode).toHaveProperty("type");
    expect(data.changes[0].targetNode).toHaveProperty("id");
    expect(data.changes[0].targetNode).toHaveProperty("name");
    expect(data.changes[0].targetNode).toHaveProperty("type");
    expect(data.changes[0]).toHaveProperty("relationType");
    expect(data.changes[0]).toHaveProperty("action");
    expect(data.changes[0]).toHaveProperty("valid_from");
    expect(data.changes[0]).toHaveProperty("valid_to");
    expect(data).toHaveProperty("totalCount");
    expect(data).toHaveProperty("timeRange");
  });

  it("activeOnly=true filters out superseded edges", async () => {
    const queries = createMockBitemporalQueries([
      {
        sourceNode: { id: "a", name: "A", type: "Function" },
        targetNode: { id: "b", name: "B", type: "Function" },
        relationType: "CALLS",
        valid_from: "2026-07-15T00:00:00Z",
        valid_to: null, // active
      },
      {
        sourceNode: { id: "c", name: "C", type: "Class" },
        targetNode: { id: "d", name: "D", type: "Class" },
        relationType: "EXTENDS",
        valid_from: "2026-07-10T00:00:00Z",
        valid_to: "2026-07-20T00:00:00Z", // superseded
      },
    ]);
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      activeOnly: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.changes).toHaveLength(1);
    expect(data.changes[0].sourceNode.id).toBe("a");
    expect(data.changes[0].valid_to).toBeNull();
  });

  it("activeOnly=false includes superseded edges", async () => {
    const queries = createMockBitemporalQueries([
      {
        sourceNode: { id: "a", name: "A", type: "Function" },
        targetNode: { id: "b", name: "B", type: "Function" },
        relationType: "CALLS",
        valid_from: "2026-07-15T00:00:00Z",
        valid_to: null,
      },
      {
        sourceNode: { id: "c", name: "C", type: "Class" },
        targetNode: { id: "d", name: "D", type: "Class" },
        relationType: "EXTENDS",
        valid_from: "2026-07-10T00:00:00Z",
        valid_to: "2026-07-20T00:00:00Z",
      },
    ]);
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      activeOnly: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.changes).toHaveLength(2);
    // Second change should have action 'superseded'
    const supersededChange = data.changes.find(
      (c: any) => c.valid_to !== null,
    );
    expect(supersededChange.action).toBe("superseded");
  });

  it("CK-7: limit truncates results and sets truncated=true", async () => {
    const manyChanges: ProjectChangeRecord[] = Array.from({ length: 10 }, (_, i) => ({
      sourceNode: { id: `src-${i}`, name: `Source${i}`, type: "Function" },
      targetNode: { id: `tgt-${i}`, name: `Target${i}`, type: "Function" },
      relationType: "CALLS",
      valid_from: `2026-07-${10 + i}T00:00:00Z`,
      valid_to: null,
    }));
    const queries = createMockBitemporalQueries(manyChanges);
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      limit: 5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.changes).toHaveLength(5);
    expect(data.truncated).toBe(true);
  });

  it("does not set truncated when under limit", async () => {
    const queries = createMockBitemporalQueries([
      {
        sourceNode: { id: "a", name: "A", type: "Function" },
        targetNode: { id: "b", name: "B", type: "Function" },
        relationType: "CALLS",
        valid_from: "2026-07-15T00:00:00Z",
        valid_to: null,
      },
    ]);
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      limit: 50,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.changes).toHaveLength(1);
    expect(data.truncated).toBeUndefined();
  });

  it("limit=1 returns single change + truncated=true", async () => {
    const queries = createMockBitemporalQueries([
      {
        sourceNode: { id: "a", name: "A", type: "Function" },
        targetNode: { id: "b", name: "B", type: "Function" },
        relationType: "CALLS",
        valid_from: "2026-07-15T00:00:00Z",
        valid_to: null,
      },
      {
        sourceNode: { id: "c", name: "C", type: "Class" },
        targetNode: { id: "d", name: "D", type: "Class" },
        relationType: "EXTENDS",
        valid_from: "2026-07-10T00:00:00Z",
        valid_to: null,
      },
    ]);
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      limit: 1,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.changes).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });

  it("returns empty list (not crash) when no data", async () => {
    const queries = createMockBitemporalQueries([]);
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.changes).toEqual([]);
    expect(data.totalCount).toBe(0);
  });

  it("CK-9: passes relationTypes filter to projectChangesBetween", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    await handler({
      projectId: "proj-1",
      fromTime: "2026-07-01T00:00:00Z",
      relationTypes: ["DESCRIBES", "DOCUMENTED_BY"],
    });

    expect(queries.projectChangesBetween).toHaveBeenCalledWith(
      "proj-1",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        relationTypes: ["DESCRIBES", "DOCUMENTED_BY"],
      }),
    );
  });

  it("returns isError on invalid time format", async () => {
    const queries = createMockBitemporalQueries();
    registerChangesBetween(server, queries);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "proj-1",
      fromTime: "not-a-valid-time-format!!!",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeDefined();
  });
});
