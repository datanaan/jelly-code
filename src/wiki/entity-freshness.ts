/**
 * Entity freshness detector (P0c-T4)
 *
 * Implements a 4-state machine for wiki entity staleness detection:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                    checkEntityFreshness                      │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │                                                              │
 *   │  entity.codeSignature?                                       │
 *   │    ├─ null/undefined  ──► UNBOUND  → LintIssue{type:'unbound'}│
 *   │    │                                                         │
 *   │    └─ CodeSignature ──► findSymbol(entityName)               │
 *   │         │                                                    │
 *   │         ├─ empty/throws ──► ORPHANED → LintIssue{type:'orphan'}│
 *   │         │                                                    │
 *   │         └─ code node ──► generateSignature(currentSource)   │
 *   │              │                                               │
 *   │              ├─ astHash same && sigHash same ──► FRESH (no issue)│
 *   │              │                                               │
 *   │              └─ either differs ──► STALE → LintIssue{type:'stale'}│
 *   │                                                              │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Design principles:
 * - Only marks, never auto-fixes (spec principle 4)
 * - Uses REAL generateSignature for current code → real comparison
 * - Graceful on lookup failures (throws → orphaned, can't verify)
 * - codeSignature.entityName is the lookup key to findSymbol
 */

import { generateSignature } from './code-signature.js';
import type { CodeSignature } from './code-signature.js';
import type { WikiEntity, LintIssue } from './models.js';
import type { IGraphStore } from '../store/interfaces.js';

/**
 * The 4 freshness states for a wiki entity.
 *
 * - `fresh`: Code signature matches current source code exactly.
 * - `stale`: Code has changed since the entity was last compiled
 *   (either the body or the signature differs).
 * - `orphaned`: The code node referenced by `codeSignature.entityName`
 *   no longer exists in the graph (was deleted, or the lookup failed).
 * - `unbound`: The entity has no `codeSignature` (null = explicitly
 *   unbound, undefined = pre-P0c legacy entity).
 */
export type EntityFreshnessState = 'fresh' | 'stale' | 'orphaned' | 'unbound';

/**
 * Result of a freshness check.
 *
 * When `state` is `'fresh'`, `issue` is undefined (no problem).
 * For all other states, `issue` is a `LintIssue` describing the problem.
 */
export interface FreshnessResult {
  state: EntityFreshnessState;
  issue?: LintIssue;
}

/**
 * Check the freshness of a wiki entity against its bound code signature.
 *
 * @param projectId - The project scope for the entity and code lookup
 * @param entity - The wiki entity to check (must have codeSignature field)
 * @param graphStore - The graph store to use for code node lookups
 * @returns FreshnessResult with state and optional LintIssue
 */
export async function checkEntityFreshness(
  projectId: string,
  entity: WikiEntity,
  graphStore: IGraphStore,
): Promise<FreshnessResult> {
  // ─── State 1: UNBOUND ────────────────────────────────────────
  // entity.codeSignature is null (explicitly unbound) or undefined (pre-P0c)
  if (entity.codeSignature == null) {
    return {
      state: 'unbound',
      issue: {
        type: 'unbound',
        entityId: entity.id,
        entityName: entity.name,
        description: `Entity "${entity.name}" has no code signature binding${
          entity.codeSignature === null
            ? ' (explicitly unbound)'
            : ' (pre-P0c, not yet bound)'
        }`,
        severity: 'warning',
      },
    };
  }

  const storedSig: CodeSignature = entity.codeSignature;
  const symbolName = storedSig.entityName;

  // ─── Lookup current code node ────────────────────────────────
  let codeNodes;
  try {
    codeNodes = await graphStore.findSymbol(projectId, symbolName);
  } catch {
    // findSymbol threw — can't verify code existence, treat as orphaned.
    // This is the safe choice: if we can't see the code, we can't confirm
    // it still exists, so we flag it for human review.
    return {
      state: 'orphaned',
      issue: {
        type: 'orphan',
        entityId: entity.id,
        entityName: entity.name,
        description: `Code symbol "${symbolName}" could not be looked up (store error) — entity "${entity.name}" may be orphaned`,
        severity: 'warning',
      },
    };
  }

  // ─── State 3: ORPHANED ───────────────────────────────────────
  // Code node not found in graph (empty result or no content)
  const codeNode = codeNodes.find((n) => n.content);
  if (!codeNode || !codeNode.content) {
    return {
      state: 'orphaned',
      issue: {
        type: 'orphan',
        entityId: entity.id,
        entityName: entity.name,
        description: `Code symbol "${symbolName}" no longer exists or has no content — entity "${entity.name}" is orphaned`,
        severity: 'warning',
      },
    };
  }

  // ─── Generate current signature from live code ──────────────
  let currentSig: CodeSignature;
  try {
    currentSig = generateSignature(codeNode.content, codeNode.name ?? symbolName);
  } catch {
    // Source code can't be parsed — can't verify freshness.
    // Treat as orphaned (the code is effectively unusable).
    return {
      state: 'orphaned',
      issue: {
        type: 'orphan',
        entityId: entity.id,
        entityName: entity.name,
        description: `Code for symbol "${symbolName}" could not be parsed — entity "${entity.name}" may reference invalid code`,
        severity: 'warning',
      },
    };
  }

  // ─── State 2: STALE ──────────────────────────────────────────
  // Compare signatureHash (interface stability) and astHash (implementation)
  const sigChanged = currentSig.signatureHash !== storedSig.signatureHash;
  const astChanged = currentSig.astHash !== storedSig.astHash;

  if (sigChanged || astChanged) {
    const changes: string[] = [];
    if (sigChanged) changes.push('signature changed');
    if (astChanged) changes.push('implementation changed');

    return {
      state: 'stale',
      issue: {
        type: 'stale',
        entityId: entity.id,
        entityName: entity.name,
        description: `Entity "${entity.name}" is stale — code "${symbolName}" ${changes.join(' and ')} since last compile`,
        severity: 'warning',
      },
    };
  }

  // ─── State 4: FRESH ──────────────────────────────────────────
  // Both hashes match — entity's description still accurately reflects the code
  return { state: 'fresh' };
}
