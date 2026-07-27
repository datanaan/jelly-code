/**
 * v1.3.0 Phase 3 T3-3: WikiDerivationEngine
 *
 * Transforms SelectedNode[] into WikiEntity[] with auto-derive provenance.
 * Writes to Neo4j (via WikiGraph) + search index (via WikiService).
 *
 * Design decisions:
 *   D5: Entity id = "auto-{filePath}:{name}" for uniqueness
 *   D8: LLM fallback definition uses interpolated template (no "See code signature...")
 *   D9: Search index writes go through WikiService.indexEntity (not direct TS/Qdrant)
 *   T3-1b: enabled=false → skip derivation entirely
 *
 * Constraints:
 *   - Does NOT overwrite manual entities (MERGE checks by id+projectId)
 *   - provenance always set to 'auto-derived'
 *   - definition never empty (fallback template fills it)
 */

import type { WikiService } from './service.js';
import type { ILLMClient } from '../llm/interface.js';
import type { DerivationRules } from './derivation-rules.js';
import { isDerivationEnabled } from './derivation-rules.js';
import type { SelectedNode } from './code-entity-selector.js';
import { generateSignature } from './code-signature.js';

// ─── Types ───────────────────────────────────────────────────────

export interface DeriveResult {
  derived: number;
  skipped: number;
  errors: Array<{ nodeId: string; error: string }>;
  reason?: string;
}

// ─── Engine ──────────────────────────────────────────────────────

export class WikiDerivationEngine {
  constructor(
    private wikiService: WikiService,
    private llmClient: ILLMClient | undefined,
    private rules: DerivationRules,
  ) {}

  /**
   * Derive WikiEntity objects from selected code nodes.
   *
   * T3-1b: Checks rules.enabled — returns immediately with derived=0 if disabled.
   *
   * @deprecated since v1.4.0 — use llm-worker + JobDispatcher instead.
   * Kept for `options.syncDerivation=true` test paths. Production code should
   * dispatch to the `llm-derivation` queue via {@link JobDispatcher}.
   */
  async deriveEntities(
    projectId: string,
    nodes: SelectedNode[],
  ): Promise<DeriveResult> {
    // T3-1b: Safety switch — enabled=false completely skips derivation
    if (!isDerivationEnabled(this.rules)) {
      return {
        derived: 0,
        skipped: nodes.length,
        errors: [],
        reason: 'derivation disabled by config',
      };
    }

    const result: DeriveResult = { derived: 0, skipped: 0, errors: [] };

    for (const node of nodes) {
      try {
        const created = await this.deriveOne(projectId, node);
        if (created) {
          result.derived++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.errors.push({
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Alias for {@link deriveEntities} — the synchronous for-loop path.
   *
   * Provided for clarity at call sites that explicitly opt into the legacy
   * sync path (`options.syncDerivation === true`).
   *
   * @deprecated since v1.4.0 — use llm-worker + JobDispatcher instead.
   */
  async deriveEntitiesSync(
    projectId: string,
    nodes: SelectedNode[],
  ): Promise<DeriveResult> {
    return this.deriveEntities(projectId, nodes);
  }

  // ─── Private ──────────────────────────────────────────────────

  /**
   * Derive a single WikiEntity from a code node.
   * Made public in v1.4.0 for use by llm-worker (Task 6).
   * @returns true if a new entity was created, false if skipped (manual entity exists)
   */
  async deriveOne(projectId: string, node: SelectedNode): Promise<boolean> {
    const graph = this.wikiService.getGraph();
    const entityId = this.makeEntityId(node);
    const now = new Date().toISOString();

    // Check if entity already exists — don't overwrite manual entities
    const existing = await graph.getEntity(projectId, entityId);
    if (existing && existing.provenance === 'manual') {
      // Skip — human-curated entity takes priority
      return false;
    }

    // Generate code signature from node content
    let signature: ReturnType<typeof generateSignature> | undefined;
    if (node.content) {
      try {
        signature = generateSignature(node.content, node.name);
      } catch {
        // Signature generation failed — entity will still be created without signature
      }
    }

    // Generate definition: LLM or fallback template
    const { definition, llmUsed } = await this.generateDefinition(node, signature);

    // Create WikiEntity
    const entity = {
      id: entityId,
      projectId,
      name: node.name,
      entityType: 'api' as const,
      definition,
      details: '',
      firstCompiled: now,
      lastUpdated: now,
      codeSignature: signature ?? null,
      provenance: 'auto-derived' as const,
      derivedAt: now,
    };

    await graph.createEntity(entity);

    // Write DESCRIBES + DOCUMENTED_BY cross-domain edges
    try {
      await graph.createCrossDomainEdges(projectId, entityId, node.id);
    } catch {
      // Cross-domain edge write failure is non-fatal
    }

    // Write to search index via WikiService (D9 fix)
    try {
      await this.wikiService.indexEntity(projectId, entityId, node.name, definition, now);
    } catch {
      // Search index failure is non-fatal
    }

    return true;
  }

  /**
   * D5: Entity id includes filePath for uniqueness.
   * Format: "auto-{relativeFilePath}:{name}"
   *
   * P2-2 fix: If filePath is absolute (starts with /), use just the
   * trailing path segments to keep the ID manageable. Neo4j has no
   * length limit, but Typesense/Qdrant document IDs typically cap at 1024.
   */
  private makeEntityId(node: SelectedNode): string {
    const rawPath = node.filePath || 'unknown';
    // Strip leading slashes and common absolute prefixes
    const filePath = rawPath.replace(/^\/+/, '');
    return `auto-${filePath}:${node.name}`;
  }

  /**
   * D8: Generate definition via LLM or fallback template.
   * Template does NOT contain "See code signature for details".
   */
  private async generateDefinition(
    node: SelectedNode,
    signature: ReturnType<typeof generateSignature> | undefined,
  ): Promise<{ definition: string; llmUsed: boolean }> {
    // Try LLM first
    if (this.llmClient && this.rules.llmFallback !== false) {
      try {
        const prompt = `Write a brief one-sentence description for the ${node.type} "${node.name}" in ${node.filePath}.`;
        const llmDef = await this.llmClient.generate(prompt);
        if (llmDef && llmDef.trim().length > 0) {
          return { definition: llmDef.trim(), llmUsed: true };
        }
      } catch {
        // Fall through to template
      }
    }

    // Fallback: interpolate template
    const template = this.rules.llmFallbackDefinition
      ?? 'Exported {type} {name} in {filePath}. Signature: {signature}.';

    const signatureStr = signature
      ? `${signature.entityName}(${signature.paramTypes.join(', ')}): ${signature.returnType}`
      : 'N/A';

    const definition = template
      .replace('{type}', node.type)
      .replace('{name}', node.name)
      .replace('{filePath}', node.filePath || 'unknown')
      .replace('{signature}', signatureStr);

    // CK-8: Verify definition is substantive (>20 chars) and doesn't contain forbidden phrase
    if (definition.length <= 20) {
      return {
        definition: `Auto-derived ${node.type} ${node.name} from ${node.filePath}.`,
        llmUsed: false,
      };
    }

    return { definition, llmUsed: false };
  }
}
