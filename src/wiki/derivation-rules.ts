/**
 * v1.3.0 Phase 3 T3-1: Derivation rules configuration.
 *
 * Loads and validates JSON rules that control which CodeNodes are selected
 * for auto-derivation into WikiEntity objects.
 *
 * Loading priority:
 *   1. User file at `.jelly-code/derivation-rules.json` (project root)
 *   2. Built-in default at `config/derivation-rules.json`
 *   3. Hardcoded fallback (empty rules → auto-derive disabled)
 *
 * The `enabled` field defaults to `true` when absent (backward compat).
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────

export interface DerivationFilter {
  has_exportModifier?: boolean;
  type?: string[];
  minInDegree?: number;
  communityRank?: number;
}

export interface DerivationRule {
  name: string;
  description?: string;
  filter: DerivationFilter;
  priority: number;
  maxPerProject?: number;
}

export interface DerivationRules {
  /** Master switch. Defaults to true when absent (backward compat). */
  enabled?: boolean;
  rules: DerivationRule[];
  maxEntitiesPerProject?: number;
  llmFallback?: boolean;
  llmFallbackDefinition?: string;
  /** v1.4.0: async dispatch batch size (default 10). Controls how many
   * code nodes are bundled into a single llm-derivation job. */
  dispatchBatchSize?: number;
}

// ─── Default Rules ───────────────────────────────────────────────

/**
 * Built-in default rules, matching config/derivation-rules.json.
 * Used when no user file is present.
 */
export const DEFAULT_DERIVATION_RULES: DerivationRules = {
  enabled: true,
  rules: [
    {
      name: 'exported_api',
      description: 'Exported functions and classes',
      filter: { has_exportModifier: true, type: ['Function', 'Class', 'Interface'] },
      priority: 1,
      maxPerProject: 100,
    },
    {
      name: 'high_indegree',
      description: 'Nodes with ≥5 inbound relations',
      filter: { minInDegree: 5 },
      priority: 2,
      maxPerProject: 50,
    },
    {
      name: 'community_top',
      description: 'High-degree nodes as community representatives (approximate — global degree ranking, not per-Leiden-community)',
      filter: { communityRank: 3 },
      priority: 3,
      maxPerProject: 30,
    },
  ],
  maxEntitiesPerProject: 200,
  llmFallback: true,
  llmFallbackDefinition: 'Exported {type} {name} in {filePath}. Signature: {signature}.',
};

// ─── Public API ──────────────────────────────────────────────────

/**
 * Load derivation rules from a JSON file.
 *
 * @param rulesPath - Absolute path to the JSON file
 * @returns Parsed and validated DerivationRules
 * @throws Error if the file exists but contains invalid JSON
 */
export function loadRules(rulesPath: string): DerivationRules {
  const raw = fs.readFileSync(rulesPath, 'utf-8');
  const parsed = JSON.parse(raw) as DerivationRules;
  return normalizeRules(parsed);
}

/**
 * Load rules with fallback: try user file → default.
 *
 * @param projectPath - Project root directory (where `.jelly-code/` lives)
 * @param defaultRulesPath - Path to built-in default rules JSON
 * @returns DerivationRules (never throws — falls back to hardcoded defaults)
 */
export function loadRulesWithFallback(
  projectPath: string,
  defaultRulesPath?: string,
): DerivationRules {
  // 1. User file
  const userRulesPath = path.join(projectPath, '.jelly-code', 'derivation-rules.json');
  if (fs.existsSync(userRulesPath)) {
    try {
      return loadRules(userRulesPath);
    } catch {
      // Fall through to default on parse error
    }
  }

  // 2. Built-in default file
  if (defaultRulesPath && fs.existsSync(defaultRulesPath)) {
    try {
      return loadRules(defaultRulesPath);
    } catch {
      // Fall through to hardcoded default
    }
  }

  // 3. Hardcoded fallback
  return { ...DEFAULT_DERIVATION_RULES };
}

/**
 * Check if derivation is enabled.
 * Absent `enabled` field defaults to true (backward compat).
 */
export function isDerivationEnabled(rules: DerivationRules): boolean {
  return rules.enabled !== false;
}

// ─── Internal ────────────────────────────────────────────────────

/**
 * Normalize parsed rules: sort by priority, validate structure.
 */
function normalizeRules(rules: DerivationRules): DerivationRules {
  const sortedRules = [...rules.rules].sort((a, b) => a.priority - b.priority);
  return {
    ...rules,
    rules: sortedRules,
  };
}
