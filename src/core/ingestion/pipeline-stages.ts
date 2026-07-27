/**
 * Stage definitions for the ingestion pipeline.
 *
 * Defines the structure and contracts for each pipeline stage:
 * - extract: Parse source code into AST nodes and relations
 * - enrich: Add cross-file references, import resolution, call graphs
 * - merge: Combine results from parallel chunks
 * - validate: Check data integrity and completeness
 *
 * These are pure data structures describing what each stage does,
 * making them fully unit-testable.
 */

// ========================================
// Stage type definitions
// ========================================

export type PipelineStageName = 'extract' | 'enrich' | 'merge' | 'validate';

export interface PipelineStage {
  /** Unique stage identifier */
  name: PipelineStageName;
  /** Human-readable description */
  description: string;
  /** Whether this stage can run in parallel across file chunks */
  parallelizable: boolean;
  /** Expected input keys */
  inputs: string[];
  /** Produced output keys */
  outputs: string[];
}

// ========================================
// Stage definitions
// ========================================

export const EXTRACT_STAGE: PipelineStage = {
  name: 'extract',
  description: 'Parse source files using Tree-sitter, extract AST nodes, relations, and metadata',
  parallelizable: true,
  inputs: ['filePaths', 'sourceContents'],
  outputs: ['nodes', 'relations', 'imports', 'calls'],
};

export const ENRICH_STAGE: PipelineStage = {
  name: 'enrich',
  description: 'Resolve cross-file references: imports, call graphs, type inference, heritage chains',
  parallelizable: false,
  inputs: ['nodes', 'relations', 'imports'],
  outputs: ['enrichedNodes', 'crossFileRelations', 'resolvedImports'],
};

export const MERGE_STAGE: PipelineStage = {
  name: 'merge',
  description: 'Merge results from parallel chunks: deduplicate nodes, consolidate relations',
  parallelizable: false,
  inputs: ['nodes[]', 'relations[]'],
  outputs: ['mergedNodes', 'mergedRelations'],
};

export const VALIDATE_STAGE: PipelineStage = {
  name: 'validate',
  description: 'Validate pipeline output: check for missing references, dangling relations, data integrity',
  parallelizable: false,
  inputs: ['mergedNodes', 'mergedRelations'],
  outputs: ['validationReport'],
};

/** All pipeline stages in execution order */
export const PIPELINE_STAGES: PipelineStage[] = [
  EXTRACT_STAGE,
  ENRICH_STAGE,
  MERGE_STAGE,
  VALIDATE_STAGE,
];

/** Get a stage definition by name */
export function getStage(name: PipelineStageName): PipelineStage {
  const stage = PIPELINE_STAGES.find(s => s.name === name);
  if (!stage) throw new Error(`Unknown pipeline stage: ${name}`);
  return stage;
}
