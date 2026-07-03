/**
 * Shared types and utilities — single source of truth.
 *
 * Re-exports all common types used across the code analysis pipeline,
 * CLI, and MCP tools. Everything imported elsewhere comes from here.
 */

// Graph types
export type {
  NodeLabel,
  NodeProperties,
  RelationshipType,
  GraphNode,
  GraphRelationship,
} from './graph/types.js';

// Language support
export { SupportedLanguages } from './languages.js';
export { getLanguageFromFilename, getSyntaxLanguageFromFilename } from './language-detection.js';

// Pipeline progress
export type { PipelinePhase, PipelineProgress } from './pipeline.js';
