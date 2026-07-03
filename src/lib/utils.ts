/**
 * Utility functions.
 *
 * generateId creates deterministic node/relation IDs from labels and keys.
 * IDs follow the format "Label:key1:key2:..." for nodes and "Label:id1->id2" for relations.
 */

/**
 * Generate a deterministic ID from a label and key parts.
 *
 * Format: "Label:key1:key2:..." e.g. "File:src/index.ts", "CALLS:id1->id2"
 *
 * For relation IDs (type with multiple parts), joins with '->'.
 * For node IDs (single label + path), joins with ':'.
 */
export function generateId(label: string, ...keyParts: string[]): string {
  // Relation IDs use '->' separator between source and target
  if (keyParts.length >= 2 && (label === 'CALLS' || label === 'IMPORTS' || label === 'EXTENDS' || label === 'IMPLEMENTS' || label === 'OVERRIDES' || label === 'USES' || label === 'CONTAINS' || label === 'DEFINES' || label === 'ACCESSES' || label === 'MEMBER_OF' || label === 'HAS_METHOD' || label === 'HAS_PROPERTY' || label === 'STEP_IN_PROCESS' || label === 'HANDLES_ROUTE' || label === 'FETCHES' || label === 'HANDLES_TOOL' || label === 'ENTRY_POINT_OF' || label === 'WRAPS' || label === 'QUERIES' || label === 'DECORATES')) {
    return `${label}:${keyParts.join('->')}`;
  }
  return `${label}:${keyParts.join(':')}`;
}
