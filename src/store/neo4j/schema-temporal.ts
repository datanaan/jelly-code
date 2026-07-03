/**
 * Temporal schema — indexes and constraints for Commit and Author nodes.
 *
 * Called during initialization alongside the main schema.
 * Uses idempotent syntax (IF NOT EXISTS) so it is safe to run on every startup.
 */

/**
 * Create temporal indexes and constraints for Commit and Author nodes.
 *
 * @param executeCypher - A function that executes a single Cypher statement.
 */
export async function ensureTemporalSchema(
  executeCypher: (cypher: string) => Promise<void>,
): Promise<void> {
  // ---- Commit node indexes ----
  await executeCypher(
    `CREATE INDEX IF NOT EXISTS FOR (c:Commit) ON (c.id)`,
  );
  await executeCypher(
    `CREATE INDEX IF NOT EXISTS FOR (c:Commit) ON (c.projectId)`,
  );
  await executeCypher(
    `CREATE INDEX IF NOT EXISTS FOR (c:Commit) ON (c.authoredAt)`,
  );

  // ---- Author node indexes ----
  await executeCypher(
    `CREATE INDEX IF NOT EXISTS FOR (a:Author) ON (a.email)`,
  );

  // ---- Unique constraints ----
  await executeCypher(
    `CREATE CONSTRAINT IF NOT EXISTS FOR (c:Commit) REQUIRE c.id IS UNIQUE`,
  );
  await executeCypher(
    `CREATE CONSTRAINT IF NOT EXISTS FOR (a:Author) REQUIRE a.id IS UNIQUE`,
  );
}
