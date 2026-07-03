/**
 * Graph factory — re-export from the actual implementation.
 *
 * Ingestion code imports from ../graph/graph.js but the actual
 * implementation is in ./graph/graph.ts (one directory deeper).
 */
export { createKnowledgeGraph } from './graph/graph.js';
