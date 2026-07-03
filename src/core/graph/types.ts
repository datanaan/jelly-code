/**
 * Graph types — re-export from the actual implementation.
 *
 * Ingestion code imports from ../graph/types.js but the actual
 * implementation is in ./graph/types.ts (one directory deeper).
 */
export type { KnowledgeGraph } from './graph/types.js';
