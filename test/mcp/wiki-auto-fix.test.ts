/**
 * v1.3.0 Phase 2 T2-3: MCP tool wiki_auto_fix tests.
 *
 * Tests:
 * - Tool registration with correct name and schema
 * - scan: returns stale + orphaned entity lists
 * - fix: dryRun doesn't modify, actual fix updates codeSignature
 * - fix with no cross-domain edge → warning (CK-5)
 * - delete-orphaned: only removes auto-derived (CK-8)
 * - delete-orphaned dryRun: no modification (CK-4)
 * - undo-auto-derived: deletes all auto-derived, preserves manual (CK-11)
 * - undo-auto-derived dryRun: returns list without executing (CK-4)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWikiAutoFix } from "../../src/mcp/tools/wiki-auto-fix.js";
import type { WikiService } from "../../src/wiki/service.js";
import type { WikiGraph } from "../../src/wiki/graph.js";
import type { StoreSet, IGraphStore, ISearchStore, IVectorStore } from "../../src/store/interfaces.js";
import type { ILLMClient } from "../../src/llm/interface.js";
import type { CodeSignature } from "../../src/wiki/code-signature.js";
import type { LintIssue } from "../../src/wiki/models.js";

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

function createMockWikiGraph(): WikiGraph {
  return {
    findDocumentedCodeNodes: vi.fn().mockResolvedValue([]),
    findDocumentingEntities: vi.fn().mockResolvedValue([]),
    createCrossDomainEdges: vi.fn().mockResolvedValue(undefined),
    closeCrossDomainEdgesForCodeNode: vi.fn().mockResolvedValue(0),
    listEntitiesByProvenance: vi.fn().mockResolvedValue([]),
    findOrphanedEntities: vi.fn().mockResolvedValue([]),
    deleteEntity: vi.fn().mockResolvedValue(undefined),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    getEntity: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
  } as unknown as WikiGraph;
}

function createMockStores(): StoreSet {
  return {
    graph: {
      findSymbol: vi.fn().mockResolvedValue([]),
      getNode: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue([]),
    } as unknown as IGraphStore,
    search: {} as unknown as ISearchStore,
    vector: {} as unknown as IVectorStore,
    llm: {} as unknown as ILLMClient,
  };
}

function createMockWikiService(
  graph?: WikiGraph,
  lintIssues?: LintIssue[],
): WikiService {
  const mockGraph = graph ?? createMockWikiGraph();
  return {
    getGraph: vi.fn().mockReturnValue(mockGraph),
    lint: vi.fn().mockResolvedValue(lintIssues ?? []),
    getEntity: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    indexEntity: vi.fn().mockResolvedValue(undefined),
    deleteEntityFromIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as WikiService;
}

const SIG: CodeSignature = {
  entityName: "greet",
  entityType: "function",
  paramTypes: ["string"],
  returnType: "string",
  signatureHash: "abc123",
  astHash: "def456",
};

// ─── Tests ───────────────────────────────────────────────────────

describe("wiki_auto_fix MCP tool (v1.3.0 T2-3)", () => {
  let server: ReturnType<typeof createMockServer>;
  let stores: StoreSet;

  beforeEach(() => {
    server = createMockServer();
    stores = createMockStores();
  });

  it("registers tool with correct name and schema", () => {
    const wikiService = createMockWikiService();
    registerWikiAutoFix(server, wikiService, stores);

    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server.getTools()[0];
    expect(tool.name).toBe("wiki_auto_fix");

    expect(tool.config.inputSchema.projectId).toBeDefined();
    expect(tool.config.inputSchema.action).toBeDefined();
    expect(tool.config.inputSchema.entityId).toBeDefined();
    expect(tool.config.inputSchema.dryRun).toBeDefined();
  });

  // ─── scan action ─────────────────────────────────────────

  it("scan: returns stale + orphaned entity lists", async () => {
    const lintIssues: LintIssue[] = [
      { type: "stale", entityId: "e1", entityName: "Func", description: "Signature changed", severity: "warning" },
      { type: "orphan", entityId: "e2", entityName: "Old", description: "No references", severity: "warning" },
    ];
    const graph = createMockWikiGraph();
    graph.findOrphanedEntities = vi.fn().mockResolvedValue([
      { id: "e3", name: "AutoOld", provenance: "auto-derived", reason: "no-active-edge" },
    ]);
    const wikiService = createMockWikiService(graph, lintIssues);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({ projectId: "p1", action: "scan" });
    const data = JSON.parse(result.content[0].text);

    expect(data.action).toBe("scan");
    expect(data.staleEntities).toHaveLength(1);
    expect(data.staleEntities[0].entityId).toBe("e1");
    expect(data.orphanedEntities).toHaveLength(1);
    expect(data.summary.stale).toBe(1);
  });

  // ─── fix action ──────────────────────────────────────────

  it("CK-4: dryRun fix does not modify data", async () => {
    const graph = createMockWikiGraph();
    graph.findDocumentedCodeNodes = vi.fn().mockResolvedValue([
      { id: "code-1", name: "greet", type: "Function", filePath: "src/greet.ts" },
    ]);
    (stores.graph.getNode as any).mockResolvedValue({
      id: "code-1",
      content: "function greet(name: string): string { return name; }",
    });
    const wikiService = createMockWikiService(graph);
    wikiService.getEntity = vi.fn().mockResolvedValue({
      id: "e1", name: "GreetFunc", codeSignature: SIG,
    }) as any;

    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "fix", entityId: "e1", dryRun: true,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.dryRun).toBe(true);
    expect(data.results[0].status).toBe("would-fix");
    expect(graph.updateEntity).not.toHaveBeenCalled();
  });

  it("actual fix updates codeSignature", async () => {
    const graph = createMockWikiGraph();
    graph.findDocumentedCodeNodes = vi.fn().mockResolvedValue([
      { id: "code-1", name: "greet", type: "Function", filePath: "src/greet.ts" },
    ]);
    (stores.graph.getNode as any).mockResolvedValue({
      id: "code-1",
      content: "function greet(name: string): string { return 'Hello ' + name; }",
    });
    const wikiService = createMockWikiService(graph);
    wikiService.getEntity = vi.fn().mockResolvedValue({
      id: "e1", name: "GreetFunc", codeSignature: SIG,
    }) as any;

    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "fix", entityId: "e1", dryRun: false,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.results[0].status).toBe("fixed");
    expect(graph.updateEntity).toHaveBeenCalledWith(
      "p1", "e1",
      expect.objectContaining({
        codeSignature: expect.objectContaining({
          entityName: "greet",
        }),
      }),
    );
  });

  it("CK-5: fix without cross-domain edge returns warning", async () => {
    const graph = createMockWikiGraph();
    graph.findDocumentedCodeNodes = vi.fn().mockResolvedValue([]);
    (stores.graph.findSymbol as any).mockResolvedValue([]); // no fallback either
    const wikiService = createMockWikiService(graph);
    wikiService.getEntity = vi.fn().mockResolvedValue({
      id: "e1", name: "OldFunc", codeSignature: SIG,
    }) as any;

    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "fix", entityId: "e1",
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.results[0].status).toBe("warning");
    expect(data.results[0].message).toContain("No code binding");
  });

  // ─── delete-orphaned action ──────────────────────────────

  it("CK-8: delete-orphaned only removes auto-derived entities", async () => {
    const graph = createMockWikiGraph();
    graph.findOrphanedEntities = vi.fn().mockResolvedValue([
      { id: "auto-1", name: "Auto1", provenance: "auto-derived", reason: "no-active-edge" },
      { id: "manual-1", name: "Manual1", provenance: "manual", reason: "dangling-edge" },
    ]);
    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "delete-orphaned", dryRun: false,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.deleted).toEqual(["auto-1"]);
    expect(data.deleted).not.toContain("manual-1");
    expect(graph.deleteEntity).toHaveBeenCalledTimes(1);
    expect(graph.deleteEntity).toHaveBeenCalledWith("p1", "auto-1");
  });

  it("CK-4: dryRun delete-orphaned does not execute", async () => {
    const graph = createMockWikiGraph();
    graph.findOrphanedEntities = vi.fn().mockResolvedValue([
      { id: "auto-1", name: "Auto1", provenance: "auto-derived", reason: "no-active-edge" },
    ]);
    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "delete-orphaned", dryRun: true,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.dryRun).toBe(true);
    expect(data.wouldDelete).toHaveLength(1);
    expect(graph.deleteEntity).not.toHaveBeenCalled();
  });

  // ─── undo-auto-derived action ────────────────────────────

  it("CK-11: undo-auto-derived deletes all auto-derived, preserves manual", async () => {
    const graph = createMockWikiGraph();
    graph.listEntitiesByProvenance = vi.fn()
      .mockResolvedValueOnce([
        { id: "auto-1", name: "Auto1", provenance: "auto-derived" },
        { id: "auto-2", name: "Auto2", provenance: "auto-derived" },
      ]) // first call for auto-derived
      .mockResolvedValueOnce([
        { id: "manual-1", name: "Manual1", provenance: "manual" },
      ]); // second call for manual verification

    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "undo-auto-derived", dryRun: false,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.deleted).toEqual(["auto-1", "auto-2"]);
    expect(data.summary.manualEntitiesPreserved).toBe(1);
    expect(graph.deleteEntity).toHaveBeenCalledTimes(2);
  });

  it("P0-1: undo-auto-derived also cleans search index (TS + Qdrant)", async () => {
    const graph = createMockWikiGraph();
    graph.listEntitiesByProvenance = vi.fn()
      .mockResolvedValueOnce([
        { id: "auto-1", name: "Auto1", provenance: "auto-derived" },
      ])
      .mockResolvedValueOnce([]);

    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    await handler({ projectId: "p1", action: "undo-auto-derived", dryRun: false });

    // deleteEntityFromIndex called for each deleted entity
    expect(wikiService.deleteEntityFromIndex).toHaveBeenCalledTimes(1);
    expect(wikiService.deleteEntityFromIndex).toHaveBeenCalledWith("auto-1");
  });

  it("P0-1: delete-orphaned also cleans search index", async () => {
    const graph = createMockWikiGraph();
    graph.findOrphanedEntities = vi.fn().mockResolvedValue([
      { id: "auto-1", name: "Auto1", provenance: "auto-derived", reason: "no-active-edge" },
    ]);
    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    await handler({ projectId: "p1", action: "delete-orphaned", dryRun: false });

    expect(wikiService.deleteEntityFromIndex).toHaveBeenCalledWith("auto-1");
  });

  it("CK-4: dryRun undo-auto-derived returns list without executing", async () => {
    const graph = createMockWikiGraph();
    graph.listEntitiesByProvenance = vi.fn().mockResolvedValue([
      { id: "auto-1", name: "Auto1", provenance: "auto-derived" },
    ]);
    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "undo-auto-derived", dryRun: true,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.dryRun).toBe(true);
    expect(data.wouldDelete).toHaveLength(1);
    expect(graph.deleteEntity).not.toHaveBeenCalled();
  });

  it("undo-auto-derived with no auto-derived entities returns empty deleted", async () => {
    const graph = createMockWikiGraph();
    graph.listEntitiesByProvenance = vi.fn().mockResolvedValue([]);
    const wikiService = createMockWikiService(graph);
    registerWikiAutoFix(server, wikiService, stores);
    const handler = server.getTools()[0].handler;

    const result = await handler({
      projectId: "p1", action: "undo-auto-derived",
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.deleted).toEqual([]);
    expect(data.summary.deleted).toBe(0);
  });
});
