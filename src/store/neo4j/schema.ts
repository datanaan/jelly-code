/**
 * Neo4j schema initialization for jelly_code_project.
 *
 * Creates UNIQUE constraints for all node labels and indexes
 * for commonly queried fields. Uses idempotent syntax so it can
 * be run safely on every startup.
 */

// All node labels used in the code knowledge graph (30+ labels)
export const NODE_LABELS = [
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Section',
  'Route',
  'Tool',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
] as const;

// Labels that are Cypher reserved words and must be backtick-quoted
export const RESERVED_LABELS = new Set([
  'Struct',
  'Union',
  'Const',
  'Static',
  'Enum',
  'Interface',
  'Module',
  'Annotation',
]);

/**
 * Safely quote a label for use in Cypher.
 * Reserved words are wrapped in backticks; others pass through unchanged.
 */
export function quoteLabel(label: string): string {
  if (RESERVED_LABELS.has(label)) {
    return '`' + label + '`';
  }
  return label;
}

/**
 * Build composite UNIQUE constraint Cypher for (id, projectId).
 * v0.1.1: Multi-tenant isolation requires that the same symbol `id`
 * can exist across different projects. The old `id`-only constraint
 * would prevent analyzing a second project that shares any symbol
 * name with the first.
 */
function compositeUniqueConstraintCypher(label: string): string {
  const qLabel = quoteLabel(label);
  return (
    `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${qLabel}) ` +
    `REQUIRE (n.id, n.projectId) IS UNIQUE`
  );
}

/**
 * Build index Cypher for a given label + property pair.
 */
function indexCypher(label: string, property: string): string {
  const qLabel = quoteLabel(label);
  return `CREATE INDEX IF NOT EXISTS FOR (n:${qLabel}) ON (n.${property})`;
}

/**
 * Initialize the full Neo4j schema: constraints + indexes.
 *
 * @param runCypher - A function that executes a single Cypher statement.
 *   Must also support `runCypher(query, true)` for read-only queries that
 *   return results (specifically SHOW CONSTRAINTS).
 */
export async function initializeSchema(
  runCypher: (cypher: string, readOnly?: boolean) => Promise<unknown>,
): Promise<void> {
  // ---- v0.1.1: Drop old `id`-only constraints, create (id, projectId) composite ----
  // Old constraint:  REQUIRE n.id IS UNIQUE
  // New constraint:  REQUIRE (n.id, n.projectId) IS UNIQUE
  // Order matters: DROP first, then CREATE (constraint name collision otherwise)

  // Neo4j 5.x: DROP CONSTRAINT IF EXISTS FOR (n:Label) REQUIRE n.id IS UNIQUE
  // is NOT supported in community edition. Use SHOW CONSTRAINTS to discover
  // old constraint names, then drop by name.
  const constraints = (await runCypher('SHOW CONSTRAINTS', true)) as
    Array<{ name: string; type: string; labelsOrTypes: string[]; properties: string[] }> | undefined;

  // Skip Project — id-only constraint is intentional (global unique, no projectId)
  const oldConstraints = (constraints || []).filter(
    (c: { type: string; properties: string[]; labelsOrTypes: string[] }) =>
      !c.labelsOrTypes?.includes('Project') &&
      c.type === 'UNIQUE' &&
      c.properties?.length === 1 &&
      c.properties[0] === 'id',
  );

  for (const c of oldConstraints) {
    await runCypher(`DROP CONSTRAINT ${c.name} IF EXISTS`);
  }

  for (const label of NODE_LABELS) {
    await runCypher(compositeUniqueConstraintCypher(label));
  }

  // Project label constraint (id is globally unique, no projectId needed)
  await runCypher(
    `CREATE CONSTRAINT IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE`,
  );

  // ---- Indexes for commonly queried fields ----
  await runCypher(indexCypher('Function', 'name'));
  await runCypher(indexCypher('Function', 'filePath'));
  await runCypher(indexCypher('Class', 'name'));
  await runCypher(indexCypher('Class', 'filePath'));
  await runCypher(indexCypher('Method', 'name'));
  await runCypher(indexCypher('Method', 'filePath'));
  await runCypher(indexCypher('Project', 'id'));

  // General filePath index for incremental delete-by-filepath queries
  await runCypher(indexCypher('CodeElement', 'filePath'));

  // ---- Wiki node labels (WikiEntity, WikiSource, WikiTopic, WikiLogEntry) ----
  // ISSUE-002: Wiki nodes now use composite (id, projectId) MERGE,
  // so we drop the unique-on-id constraint (which would conflict with
  // same-named nodes across projects) and add projectId indexes instead.
  const wikiLabels = ['WikiEntity', 'WikiSource', 'WikiTopic', 'WikiLogEntry'];
  for (const label of wikiLabels) {
    // Composite uniqueness on (id, projectId) — replaces the old id-only constraint
    await runCypher(
      `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE (n.id, n.projectId) IS UNIQUE`,
    );
    // projectId index for fast project-scoped queries
    await runCypher(indexCypher(label, 'projectId'));
  }
  await runCypher(indexCypher('WikiEntity', 'name'));
  await runCypher(indexCypher('WikiEntity', 'entity_type'));
  await runCypher(indexCypher('WikiSource', 'source_path'));
}
