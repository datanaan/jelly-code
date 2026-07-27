/**
 * MCP Tool: wiki_auto_fix
 *
 * v1.3.0 Phase 2 T2-3 — Wiki stale detection + auto-fix + orphan cleanup.
 *
 * Actions:
 *   scan             — list stale WikiEntities (from lint)
 *   fix              — refresh stale entity's codeSignature from current code
 *   delete-orphaned  — remove auto-derived entities pointing to deleted CodeNodes
 *   undo-auto-derived — remove ALL auto-derived entities (rollback a derive batch)
 *
 * All destructive actions support dryRun=true to preview without executing.
 *
 * Design constraints:
 *   - delete-orphaned only removes provenance='auto-derived' entities
 *     (manual entities are preserved even when orphaned)
 *   - undo-auto-derived preserves provenance='manual' entities
 *   - fix updates codeSignature always; definition only when LLM is available
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WikiService } from "../../wiki/service.js";
import type { StoreSet } from "../../store/interfaces.js";

export function registerWikiAutoFix(
  server: McpServer,
  wikiService: WikiService,
  stores: StoreSet,
): void {
  server.registerTool(
    "wiki_auto_fix",
    {
      description:
        "Detect and fix stale Wiki entities, clean up orphaned auto-derived " +
        "entities, or undo an entire auto-derive batch. Actions: " +
        "'scan' (list stale entities), 'fix' (refresh code signature), " +
        "'delete-orphaned' (remove auto-derived entities pointing to deleted code), " +
        "'undo-auto-derived' (remove ALL auto-derived entities). " +
        "Use dryRun=true to preview without executing. " +
        "Manual entities are preserved by all cleanup actions.",
      inputSchema: {
        projectId: z.string().describe("Project ID to scope the operation"),
        action: z
          .enum(["scan", "fix", "delete-orphaned", "undo-auto-derived"])
          .describe("Operation to perform"),
        entityId: z
          .string()
          .optional()
          .describe("Specific entity ID for fix/delete-orphaned. Omit for project-wide."),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, only preview — no modifications (default false)"),
      },
    },
    async (params) => {
      try {
        const graph = wikiService.getGraph();
        const dryRun = params.dryRun ?? false;

        switch (params.action) {
          case "scan":
            return await handleScan(wikiService, params.projectId);

          case "fix":
            return await handleFix(
              wikiService,
              stores,
              params.projectId,
              params.entityId,
              dryRun,
            );

          case "delete-orphaned":
            return await handleDeleteOrphaned(
              graph,
              wikiService,
              params.projectId,
              dryRun,
            );

          case "undo-auto-derived":
            return await handleUndoAutoDerived(
              graph,
              wikiService,
              params.projectId,
              dryRun,
            );

          default:
            return errorResult(`Unknown action: ${params.action as string}`);
        }
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );
}

// ─── Action Handlers ─────────────────────────────────────────────

async function handleScan(
  wikiService: WikiService,
  projectId: string,
) {
  const issues = await wikiService.lint(projectId);
  const staleIssues = issues.filter((i) => i.type === "stale");
  const orphanIssues = issues.filter((i) => i.type === "orphan");

  const graph = wikiService.getGraph();
  const orphanedEntities = await graph.findOrphanedEntities(projectId);

  return okResult({
    action: "scan",
    projectId,
    staleEntities: staleIssues.map((i) => ({
      entityId: i.entityId,
      entityName: i.entityName,
      description: i.description,
      severity: i.severity,
    })),
    orphanedEntities,
    summary: {
      stale: staleIssues.length,
      orphaned: orphanedEntities.length,
      lintIssuesTotal: issues.length,
    },
  });
}

async function handleFix(
  wikiService: WikiService,
  stores: StoreSet,
  projectId: string,
  entityId: string | undefined,
  dryRun: boolean,
) {
  // Determine which entities to fix
  let staleEntityIds: string[];
  if (entityId) {
    staleEntityIds = [entityId];
  } else {
    // Auto-discover stale entities via lint
    const issues = await wikiService.lint(projectId);
    staleEntityIds = issues
      .filter((i) => i.type === "stale")
      .map((i) => i.entityId);
  }

  const graph = wikiService.getGraph();
  const results: Array<Record<string, unknown>> = [];

  for (const id of staleEntityIds) {
    const entity = await wikiService.getEntity(projectId, id);
    if (!entity) {
      results.push({ entityId: id, status: "not-found" });
      continue;
    }

    // Find the CodeNode via cross-domain edges or codeSignature fallback
    const documentedNodes = await graph.findDocumentedCodeNodes(projectId, id);
    let codeNodeId: string | undefined;
    let codeSource: string | undefined;

    if (documentedNodes.length > 0) {
      codeNodeId = documentedNodes[0].id;
      const codeNode = await stores.graph.getNode(projectId, codeNodeId);
      if (codeNode?.content) {
        codeSource = codeNode.content;
      }
    } else if (entity.codeSignature?.entityName) {
      // CK-5: fallback to findSymbol when no cross-domain edge
      const nodes = await stores.graph.findSymbol(
        projectId,
        entity.codeSignature.entityName,
      );
      const found = nodes.find((n) => n.content);
      if (found) {
        codeNodeId = found.id;
        codeSource = found.content;
      }
    }

    if (!codeSource || !codeNodeId) {
      results.push({
        entityId: id,
        entityName: entity.name,
        status: "warning",
        message: "No code binding found — cannot auto-fix. Cross-domain edge missing and findSymbol returned no results.",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        entityId: id,
        entityName: entity.name,
        status: "would-fix",
        codeNodeId,
      });
      continue;
    }

    // Regenerate signature from current source
    try {
      const { generateSignature } = await import("../../wiki/code-signature.js");
      const newSignature = generateSignature(codeSource, entity.codeSignature?.entityName ?? entity.name);

      await graph.updateEntity(projectId, id, {
        codeSignature: newSignature,
        lastUpdated: new Date().toISOString(),
      });

      results.push({
        entityId: id,
        entityName: entity.name,
        status: "fixed",
        codeNodeId,
        signatureHash: newSignature.signatureHash,
      });
    } catch {
      results.push({
        entityId: id,
        entityName: entity.name,
        status: "error",
        message: "Failed to generate signature from code source",
      });
    }
  }

  return okResult({
    action: "fix",
    projectId,
    dryRun,
    results,
    summary: {
      processed: results.length,
      fixed: results.filter((r) => r.status === "fixed").length,
      warnings: results.filter((r) => r.status === "warning").length,
      errors: results.filter((r) => r.status === "error").length,
    },
  });
}

async function handleDeleteOrphaned(
  graph: import("../../wiki/graph.js").WikiGraph,
  wikiService: WikiService,
  projectId: string,
  dryRun: boolean,
) {
  const orphaned = await graph.findOrphanedEntities(projectId);

  // CK-8: Only delete auto-derived entities — preserve manual
  const autoDerived = orphaned.filter((e) => e.provenance === "auto-derived");
  const preserved = orphaned.filter((e) => e.provenance !== "auto-derived");

  if (dryRun) {
    return okResult({
      action: "delete-orphaned",
      projectId,
      dryRun: true,
      wouldDelete: autoDerived,
      wouldPreserve: preserved,
      summary: {
        orphanedTotal: orphaned.length,
        wouldDelete: autoDerived.length,
        wouldPreserve: preserved.length,
      },
    });
  }

  const deleted: string[] = [];
  for (const entity of autoDerived) {
    try {
      await graph.deleteEntity(projectId, entity.id);
      // P0-1 fix: symmetric cleanup of search index (TS + Qdrant)
      await wikiService.deleteEntityFromIndex(entity.id);
      deleted.push(entity.id);
    } catch {
      // Continue with other entities even if one fails
    }
  }

  return okResult({
    action: "delete-orphaned",
    projectId,
    dryRun: false,
    deleted,
    preserved,
    summary: {
      deleted: deleted.length,
      preserved: preserved.length,
    },
  });
}

async function handleUndoAutoDerived(
  graph: import("../../wiki/graph.js").WikiGraph,
  wikiService: WikiService,
  projectId: string,
  dryRun: boolean,
) {
  const autoDerived = await graph.listEntitiesByProvenance(projectId, "auto-derived");

  if (dryRun) {
    return okResult({
      action: "undo-auto-derived",
      projectId,
      dryRun: true,
      wouldDelete: autoDerived,
      summary: {
        wouldDelete: autoDerived.length,
      },
    });
  }

  const deleted: string[] = [];
  for (const entity of autoDerived) {
    try {
      await graph.deleteEntity(projectId, entity.id);
      // P0-1 fix: symmetric cleanup of search index (TS + Qdrant)
      await wikiService.deleteEntityFromIndex(entity.id);
      deleted.push(entity.id);
    } catch {
      // Continue even if one fails
    }
  }

  // Verify manual entities are preserved
  const remainingManual = await graph.listEntitiesByProvenance(projectId, "manual");

  return okResult({
    action: "undo-auto-derived",
    projectId,
    dryRun: false,
    deleted,
    summary: {
      deleted: deleted.length,
      manualEntitiesPreserved: remainingManual.length,
    },
  });
}

// ─── Response Helpers ────────────────────────────────────────────

function okResult(data: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}
