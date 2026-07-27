/**
 * Pre-defined safe Cypher query templates for Neo4j.
 *
 * All queries use parameterized inputs only — no string concatenation.
 * This prevents Cypher injection attacks while maintaining full query functionality.
 *
 * Usage:
 *   import { SAFE_CYPHER_TEMPLATES } from './safe-queries.js';
 *   const template = SAFE_CYPHER_TEMPLATES['findSymbol'];
 *   const result = await adapter.readQuery(template, { projectId, name });
 */

export const SAFE_CYPHER_TEMPLATES: Record<string, string> = {
  /** Find a symbol by projectId and id */
  findSymbol: 'MATCH (n {projectId:$projectId, id:$id}) RETURN n',

  /** Find symbols in a file by projectId and filePath */
  findSymbolByFile: 'MATCH (n {projectId:$projectId, filePath:$filePath}) RETURN n',

  /** Get a single node by id and projectId */
  getNode: 'MATCH (n {id:$id, projectId:$projectId}) RETURN n',

  /** BFS traversal from a seed node. NOTE: depth is NOT parameterized — Neo4j does not support
   *  parameterized variable-length path bounds. Use getSafeBfsTraverse() which validates
   *  depth as a 1-10 integer and string-concatenates it safely. */
  bfsTraverse: 'MATCH path=(start {projectId:$projectId, id:$id})-[*1..$depth]->(end) RETURN path',

  /** Clear all project data */
  clearProject: 'MATCH (n {projectId:$projectId}) DETACH DELETE n',

  /** Find related nodes via IMPORTS or CALLS relations */
  findRelated: 'MATCH (n {projectId:$projectId, id:$id})-[:IMPORTS|:CALLS]->(m) RETURN m',

  /** List all projects */
  listProjects: 'MATCH (p:Project) RETURN p.id AS id, p.name AS name, p.totalFiles AS totalFiles',

  /** Show Neo4j constraints */
  getConstraints: 'SHOW CONSTRAINTS',

  /** Get project by id */
  getProject: 'MATCH (p:Project {id:$projectId}) RETURN p',

  /** Find symbols by name */
  findSymbolByName: 'MATCH (n) WHERE n.projectId = $projectId AND n.name = $name RETURN n',

  /** Find all symbols in a project */
  findSymbolsByProject: 'MATCH (n {projectId:$projectId}) RETURN n LIMIT $limit',

  /** Get node labels for a set of IDs */
  resolveLabels: 'MATCH (n) WHERE n.projectId = $projectId AND n.id IN $ids RETURN n.id AS id, labels(n)[0] AS label',

  /** Mark nodes as stale */
  markStale: 'MATCH (n) WHERE n.projectId = $projectId AND n.id IN $ids SET n.stale = true, n.staleAt = datetime()',
};

/**
 * Execute a safe Cypher query by template name.
 * Throws if the template name is not in the pre-defined dictionary.
 *
 * Special handling: 'bfsTraverse' is intercepted and routed to getSafeBfsTraverse()
 * which validates depth as a 1-10 integer and constructs the query safely.
 * The caller must pass depth as a parameter (not in the params object).
 */
export function getSafeQuery(templateName: string, extra?: { depth?: number }): string {
  // Intercept bfsTraverse to use the safe version with validated depth
  if (templateName === 'bfsTraverse') {
    const depth = extra?.depth ?? 3;
    return getSafeBfsTraverse(depth);
  }
  const template = SAFE_CYPHER_TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown safe query template: "${templateName}". Available: ${Object.keys(SAFE_CYPHER_TEMPLATES).join(', ')}`);
  }
  return template;
}

/**
 * Get a BFS traversal Cypher query with depth safely string-concatenated.
 *
 * Neo4j does not support parameterized variable-length path bounds (*1..$depth).
 * This function validates depth as a 1-10 integer and constructs the query safely.
 *
 * @param depth - Traversal depth (1-10). Throws if out of range.
 * @returns Safe Cypher query string with depth baked in.
 */
export function getSafeBfsTraverse(depth: number): string {
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
    throw new Error(`BFS depth must be an integer between 1 and 10, got ${depth}`);
  }
  return `MATCH path=(start {projectId:$projectId, id:$id})-[*1..${depth}]->(end) RETURN path`;
}
