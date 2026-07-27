/**
 * Wiki Neo4j Graph operations.
 *
 * Manages WikiEntity, WikiSource, WikiTopic, and WikiLogEntry nodes
 * and their relationships (EXTRACTS, SOURCED_FROM, LINKS_TO, COVERS).
 *
 * Uses the existing IGraphStore.query() for raw Cypher execution.
 * Schema constraints are added via initializeSchema() in schema.ts.
 *
 * ISSUE-002 FIX: All nodes now carry `projectId` for multi-tenant isolation.
 * Previously, MERGE only matched by `id`, causing cross-project data
 * contamination when two projects shared a same-named source/entity/topic.
 */

import type { IGraphStore } from '../store/interfaces.js';
import type {
  WikiSource,
  WikiEntity,
  WikiTopic,
  WikiLogEntry,
  WikiIndex,
  EntityType,
} from './models.js';
import type { CodeSignature } from './code-signature.js';

/**
 * Deserialize codeSignature from Neo4j storage.
 *
 * Neo4j cannot store structured objects (Maps) as node properties — only
 * primitives (STRING, INT, BOOLEAN, etc.). We JSON.stringify the CodeSignature
 * when writing and JSON.parse when reading.
 *
 * Handles three cases:
 * - null/undefined → undefined (no binding)
 * - string → JSON.parse to recover the CodeSignature object
 * - object (from in-memory mocks) → return as-is (backward compat for unit tests)
 */
function deserializeCodeSignature(
  raw: unknown,
): CodeSignature | null | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CodeSignature;
    } catch {
      return undefined;
    }
  }
  // Already an object (in-memory mock or pre-serialization path)
  return raw as CodeSignature;
}

export class WikiGraph {
  constructor(private graph: IGraphStore) {}

  /**
   * Execute a raw Cypher query against the underlying graph store.
   * Used by WikiService for ad-hoc queries (log TTL cleanup, content hash checks, etc.).
   */
  async query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return this.graph.query(cypher, params ?? {});
  }

  // ==========================================
  // Source CRUD
  // ==========================================

  async createSource(source: WikiSource): Promise<void> {
    await this.graph.query(
      `MERGE (s:WikiSource {id: $id, projectId: $projectId})
       SET s.title = $title,
           s.source_path = $sourcePath,
           s.summary = $summary,
           s.key_points = $keyPoints,
           s.compiled_at = $compiledAt,
           s.projectId = $projectId,
           s.content_hash = $contentHash,
           s.llm_output_hash = $llmOutputHash`,
      {
        id: source.id,
        projectId: source.projectId,
        title: source.title,
        sourcePath: source.sourcePath,
        summary: source.summary,
        keyPoints: source.keyPoints,
        compiledAt: source.compiledAt,
        contentHash: source.contentHash ?? null,
        llmOutputHash: source.llmOutputHash ?? null,
      },
    );
  }

  async getSource(projectId: string, sourceId: string): Promise<WikiSource | null> {
    const rows = await this.graph.query(
      `MATCH (s:WikiSource) WHERE s.id = $id AND s.projectId = $projectId
       RETURN s.id AS id, s.projectId AS projectId, s.title AS title, s.source_path AS sourcePath,
              s.summary AS summary, s.key_points AS keyPoints,
              s.compiled_at AS compiledAt`,
      { id: sourceId, projectId },
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      projectId: r.projectId as string,
      title: r.title as string,
      sourcePath: r.sourcePath as string,
      summary: r.summary as string,
      keyPoints: r.keyPoints as string[],
      compiledAt: r.compiledAt as string,
    };
  }

  async listSources(projectId: string): Promise<WikiSource[]> {
    const rows = await this.graph.query(
      `MATCH (s:WikiSource) WHERE s.projectId = $projectId
       WITH s ORDER BY s.compiled_at DESC
       RETURN s.id AS id, s.projectId AS projectId, s.title AS title, s.source_path AS sourcePath,
              s.summary AS summary, s.key_points AS keyPoints,
              s.compiled_at AS compiledAt`,
      { projectId },
    );
    return rows.map(r => ({
      id: r.id as string,
      projectId: r.projectId as string,
      title: r.title as string,
      sourcePath: r.sourcePath as string,
      summary: r.summary as string,
      keyPoints: r.keyPoints as string[],
      compiledAt: r.compiledAt as string,
    }));
  }

  async listSourcePaths(projectId: string): Promise<string[]> {
    const rows = await this.graph.query(
      `MATCH (s:WikiSource) WHERE s.projectId = $projectId
       RETURN s.source_path AS path`,
      { projectId },
    );
    return rows.map(r => r.path as string);
  }

  // ==========================================
  // Entity CRUD
  // ==========================================

  async createEntity(entity: WikiEntity): Promise<void> {
    await this.graph.query(
      `MERGE (e:WikiEntity {id: $id, projectId: $projectId})
       SET e.name = $name,
           e.entity_type = $entityType,
           e.definition = $definition,
           e.details = $details,
           e.first_compiled = $firstCompiled,
           e.last_updated = $lastUpdated,
           e.codeSignature = $codeSignature,
           e.provenance = $provenance,
           e.derived_at = $derivedAt,
           e.projectId = $projectId`,
      {
        id: entity.id,
        projectId: entity.projectId,
        name: entity.name,
        entityType: entity.entityType,
        definition: entity.definition,
        details: entity.details,
        firstCompiled: entity.firstCompiled,
        lastUpdated: entity.lastUpdated,
        codeSignature: entity.codeSignature
          ? JSON.stringify(entity.codeSignature)
          : null,
        provenance: entity.provenance ?? null,
        derivedAt: entity.derivedAt ?? null,
      },
    );
  }

  async updateEntity(projectId: string, id: string, updates: Partial<WikiEntity>): Promise<void> {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id, projectId };

    if (updates.definition !== undefined) {
      setClauses.push('e.definition = $definition');
      params.definition = updates.definition;
    }
    if (updates.details !== undefined) {
      setClauses.push('e.details = $details');
      params.details = updates.details;
    }
    if (updates.lastUpdated !== undefined) {
      setClauses.push('e.last_updated = $lastUpdated');
      params.lastUpdated = updates.lastUpdated;
    }
    if (updates.name !== undefined) {
      setClauses.push('e.name = $name');
      params.name = updates.name;
    }
    if (updates.entityType !== undefined) {
      setClauses.push('e.entity_type = $entityType');
      params.entityType = updates.entityType;
    }
    if (updates.codeSignature !== undefined) {
      setClauses.push('e.codeSignature = $codeSignature');
      params.codeSignature = updates.codeSignature
        ? JSON.stringify(updates.codeSignature)
        : null;
    }
    // v1.3.0 Phase 1 T1-5: provenance/derivedAt updates
    if (updates.provenance !== undefined) {
      setClauses.push('e.provenance = $provenance');
      params.provenance = updates.provenance;
    }
    if (updates.derivedAt !== undefined) {
      setClauses.push('e.derived_at = $derivedAt');
      params.derivedAt = updates.derivedAt;
    }

    if (setClauses.length === 0) return;

    await this.graph.query(
      `MATCH (e:WikiEntity) WHERE e.id = $id AND e.projectId = $projectId
       SET ${setClauses.join(', ')}`,
      params,
    );
  }

  async getEntity(projectId: string, entityId: string): Promise<WikiEntity | null> {
    const rows = await this.graph.query(
      `MATCH (e:WikiEntity) WHERE e.id = $id AND e.projectId = $projectId
       RETURN e.id AS id, e.projectId AS projectId, e.name AS name, e.entity_type AS entityType,
              e.definition AS definition, e.details AS details,
              e.first_compiled AS firstCompiled, e.last_updated AS lastUpdated,
              e.codeSignature AS codeSignature,
              e.provenance AS provenance, e.derived_at AS derivedAt`,
      { id: entityId, projectId },
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      projectId: r.projectId as string,
      name: r.name as string,
      entityType: r.entityType as EntityType,
      definition: r.definition as string,
      details: r.details as string,
      firstCompiled: r.firstCompiled as string,
      lastUpdated: r.lastUpdated as string,
      codeSignature: deserializeCodeSignature(r.codeSignature),
      provenance: (r.provenance as WikiEntity['provenance']) ?? undefined,
      derivedAt: (r.derivedAt as string) ?? undefined,
    };
  }

  async findEntityByName(projectId: string, name: string): Promise<WikiEntity | null> {
    const rows = await this.graph.query(
      `MATCH (e:WikiEntity) WHERE e.projectId = $projectId AND (e.name = $name OR e.id = $name)
       RETURN e.id AS id, e.projectId AS projectId, e.name AS name, e.entity_type AS entityType,
              e.definition AS definition, e.details AS details,
              e.first_compiled AS firstCompiled, e.last_updated AS lastUpdated,
              e.codeSignature AS codeSignature,
              e.provenance AS provenance, e.derived_at AS derivedAt`,
      { projectId, name },
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      projectId: r.projectId as string,
      name: r.name as string,
      entityType: r.entityType as EntityType,
      definition: r.definition as string,
      details: r.details as string,
      firstCompiled: r.firstCompiled as string,
      lastUpdated: r.lastUpdated as string,
      codeSignature: deserializeCodeSignature(r.codeSignature),
      provenance: (r.provenance as WikiEntity['provenance']) ?? undefined,
      derivedAt: (r.derivedAt as string) ?? undefined,
    };
  }

  async listEntities(projectId: string, entityType?: EntityType): Promise<WikiEntity[]> {
    let cypher = `MATCH (e:WikiEntity) WHERE e.projectId = $projectId`;
    const params: Record<string, unknown> = { projectId };

    if (entityType) {
      cypher += ` AND e.entity_type = $entityType`;
      params.entityType = entityType;
    }

    cypher += ` RETURN e.id AS id, e.projectId AS projectId, e.name AS name, e.entity_type AS entityType,
                        e.definition AS definition, e.details AS details,
                        e.first_compiled AS firstCompiled, e.last_updated AS lastUpdated,
                        e.codeSignature AS codeSignature,
                        e.provenance AS provenance, e.derived_at AS derivedAt
               ORDER BY e.name`;

    const rows = await this.graph.query(cypher, params);
    return rows.map(r => ({
      id: r.id as string,
      projectId: r.projectId as string,
      name: r.name as string,
      entityType: r.entityType as EntityType,
      definition: r.definition as string,
      details: r.details as string,
      firstCompiled: r.firstCompiled as string,
      lastUpdated: r.lastUpdated as string,
      codeSignature: deserializeCodeSignature(r.codeSignature),
      provenance: (r.provenance as WikiEntity['provenance']) ?? undefined,
      derivedAt: (r.derivedAt as string) ?? undefined,
    }));
  }

  async deleteEntity(projectId: string, entityId: string): Promise<void> {
    await this.graph.query(
      `MATCH (e:WikiEntity) WHERE e.id = $id AND e.projectId = $projectId
       DETACH DELETE e`,
      { id: entityId, projectId },
    );
  }

  // ==========================================
  // v1.3.0 Phase 2: Auto-fix helpers
  // ==========================================

  /**
   * List WikiEntities filtered by provenance.
   * Used by wiki_auto_fix undo-auto-derived to find all auto-derived entities.
   */
  async listEntitiesByProvenance(
    projectId: string,
    provenance: 'auto-derived' | 'manual' | 'human-verified',
  ): Promise<Array<{ id: string; name: string; provenance?: string }>> {
    const rows = await this.graph.query(
      `MATCH (e:WikiEntity)
       WHERE e.projectId = $projectId AND e.provenance = $provenance
       RETURN e.id AS id, e.name AS name, e.provenance AS provenance
       ORDER BY e.name`,
      { projectId, provenance },
    );
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      provenance: (r.provenance as string) ?? undefined,
    }));
  }

  /**
   * Find WikiEntities whose active DESCRIBES edges point to CodeNodes
   * that no longer exist in the graph.
   *
   * An entity is "orphaned" when:
   *   1. It has an active DESCRIBES edge (valid_to IS NULL)
   *   2. The target CodeNode of that edge doesn't exist
   *      (deleted during incremental analysis)
   *
   * Also finds auto-derived entities that have NO active DESCRIBES edges
   * at all (CodeNode was fully deleted + edge was closed/superseded).
   */
  async findOrphanedEntities(
    projectId: string,
  ): Promise<Array<{ id: string; name: string; provenance?: string; reason: string }>> {
    // Strategy: find auto-derived entities that either:
    //   A) Have an active DESCRIBES edge to a node that doesn't exist as a CodeNode
    //   B) Have no active DESCRIBES edges at all (orphaned after full CodeNode deletion)

    // Part A: active DESCRIBES edges pointing to non-existent targets
    const danglingRows = await this.graph.query(
      `MATCH (e:WikiEntity {projectId: $projectId})-[d:DESCRIBES {projectId: $projectId}]->(c)
       WHERE d.valid_to IS NULL
         AND NOT EXISTS {
           MATCH (codeNode {id: c.id, projectId: $projectId})
           WHERE codeNode:Function OR codeNode:Class OR codeNode:Method
              OR codeNode:File OR codeNode:CodeElement
         }
       RETURN DISTINCT e.id AS id, e.name AS name,
              e.provenance AS provenance, 'dangling-edge' AS reason`,
      { projectId },
    );

    // Part B: auto-derived entities with no active DESCRIBES edges
    const noEdgeRows = await this.graph.query(
      `MATCH (e:WikiEntity {projectId: $projectId, provenance: 'auto-derived'})
       WHERE NOT EXISTS {
         MATCH (e)-[d:DESCRIBES {projectId: $projectId}]->()
         WHERE d.valid_to IS NULL
       }
       RETURN DISTINCT e.id AS id, e.name AS name,
              e.provenance AS provenance, 'no-active-edge' AS reason`,
      { projectId },
    );

    const dangling = danglingRows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      provenance: (r.provenance as string) ?? undefined,
      reason: r.reason as string,
    }));
    const noEdge = noEdgeRows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      provenance: (r.provenance as string) ?? undefined,
      reason: r.reason as string,
    }));

    // Deduplicate by entity id (dangling takes priority)
    const seen = new Set(dangling.map(e => e.id));
    return [...dangling, ...noEdge.filter(e => !seen.has(e.id))];
  }

  // ==========================================
  // Relations (always scoped by projectId)
  // ==========================================

  async createExtractsRelation(projectId: string, sourceId: string, entityId: string, reason: string): Promise<void> {
    await this.graph.query(
      `MATCH (s:WikiSource) WHERE s.id = $sourceId AND s.projectId = $projectId
       MATCH (e:WikiEntity) WHERE e.id = $entityId AND e.projectId = $projectId
       MERGE (s)-[r:EXTRACTS]->(e)
       SET r.reason = $reason, r.projectId = $projectId`,
      { projectId, sourceId, entityId, reason },
    );
  }

  async createSourcedFromRelation(projectId: string, entityId: string, sourceId: string, section: string): Promise<void> {
    await this.graph.query(
      `MATCH (e:WikiEntity) WHERE e.id = $entityId AND e.projectId = $projectId
       MATCH (s:WikiSource) WHERE s.id = $sourceId AND s.projectId = $projectId
       MERGE (e)-[r:SOURCED_FROM]->(s)
       SET r.section = $section, r.projectId = $projectId`,
      { projectId, entityId, sourceId, section },
    );
  }

  async createLinksToRelation(projectId: string, fromId: string, toId: string, relationship: string): Promise<void> {
    await this.graph.query(
      `MATCH (a:WikiEntity) WHERE a.id = $fromId AND a.projectId = $projectId
       MATCH (b:WikiEntity) WHERE b.id = $toId AND b.projectId = $projectId
       MERGE (a)-[r:LINKS_TO]->(b)
       SET r.relationship = $relationship, r.projectId = $projectId`,
      { projectId, fromId, toId, relationship },
    );
  }

  async getIncomingLinks(projectId: string, entityId: string): Promise<string[]> {
    const rows = await this.graph.query(
      `MATCH (other:WikiEntity)-[r:LINKS_TO]->(e:WikiEntity)
       WHERE e.id = $id AND e.projectId = $projectId AND r.projectId = $projectId
       RETURN other.id AS id`,
      { id: entityId, projectId },
    );
    return rows.map(r => r.id as string);
  }

  async getOutgoingLinks(projectId: string, entityId: string): Promise<string[]> {
    const rows = await this.graph.query(
      `MATCH (e:WikiEntity) WHERE e.id = $id AND e.projectId = $projectId
       MATCH (e)-[r:LINKS_TO]->(other:WikiEntity)
       WHERE r.projectId = $projectId
       RETURN other.id AS id`,
      { id: entityId, projectId },
    );
    return rows.map(r => r.id as string);
  }

  // ==========================================
  // Cross-domain edges (WikiEntity ↔ CodeNode) — v1.3.0 Phase 1
  // ==========================================

  /**
   * v1.3.0 Phase 1 T1-2: Create bidirectional cross-domain edges between
   * a WikiEntity and a CodeNode.
   *
   * Creates:
   *   (e:WikiEntity)-[:DESCRIBES]->(c:CodeNode)
   *   (c:CodeNode)-[:DOCUMENTED_BY]->(e:WikiEntity)
   *
   * Both edges carry bi-temporal properties aligned with CODE_RELATION:
   *   - valid_from: when this wiki↔code link became valid (set once, ON CREATE)
   *   - txn_from:   transaction time of edge creation (set once, ON CREATE)
   *   - commitId:   optional commit that triggered the binding
   *
   * MERGE + ON CREATE ensures idempotency: re-binding the same pair does NOT
   * reset valid_from — the original binding time is preserved. Subsequent
   * supersede of the CodeNode (Phase 1 T1-6) sets valid_to/txn_to, marking
   * the edge as historically superseded.
   *
   * @param projectId - Project scope for isolation
   * @param entityId  - WikiEntity.id
   * @param codeNodeId - CodeNode.id (the actual Neo4j node id, not symbol name)
   * @param commitId  - Optional commit hash that triggered this binding
   */
  async createCrossDomainEdges(
    projectId: string,
    entityId: string,
    codeNodeId: string,
    commitId?: string,
  ): Promise<void> {
    await this.graph.query(
      `MATCH (e:WikiEntity {id: $entityId, projectId: $projectId})
       MATCH (c {id: $codeNodeId, projectId: $projectId})
       MERGE (e)-[d:DESCRIBES {projectId: $projectId}]->(c)
         ON CREATE SET d.valid_from = datetime(),
                       d.txn_from   = datetime(),
                       d.commitId   = $commitId
       MERGE (c)-[db:DOCUMENTED_BY {projectId: $projectId}]->(e)
         ON CREATE SET db.valid_from = datetime(),
                       db.txn_from   = datetime(),
                       db.commitId   = $commitId`,
      { projectId, entityId, codeNodeId, commitId: commitId ?? null },
    );
  }

  /**
   * v1.3.0 Phase 1 T1-4: Find all CodeNodes documented by a WikiEntity.
   *
   * Traverses (e:WikiEntity)-[:DESCRIBES]->(c) edges.
   * Optionally filters to only currently-active edges (valid_to IS NULL),
   * excluding edges that were superseded when a CodeNode was replaced.
   *
   * @returns Array of { id, name, type, filePath } for each documented CodeNode
   */
  async findDocumentedCodeNodes(
    projectId: string,
    entityId: string,
    activeOnly: boolean = true,
  ): Promise<Array<{ id: string; name: string; type: string; filePath: string }>> {
    const validFilter = activeOnly ? 'AND d.valid_to IS NULL' : '';
    const rows = await this.graph.query(
      `MATCH (e:WikiEntity {id: $entityId, projectId: $projectId})
       MATCH (e)-[d:DESCRIBES {projectId: $projectId}]->(c)
       WHERE 1=1 ${validFilter}
       RETURN c.id AS id, c.name AS name, c.type AS type, c.filePath AS filePath`,
      { projectId, entityId },
    );
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      type: r.type as string,
      filePath: r.filePath as string,
    }));
  }

  /**
   * v1.3.0 Phase 1 T1-4: Find all WikiEntities that document a CodeNode.
   *
   * Traverses (c:CodeNode)-[:DOCUMENTED_BY]->(e:WikiEntity) edges
   * (equivalently (e)-[:DESCRIBES]->(c) in the reverse direction).
   *
   * Optionally filters to only currently-active edges (valid_to IS NULL).
   *
   * @returns Array of { id, name, entityType } for each documenting WikiEntity
   */
  async findDocumentingEntities(
    projectId: string,
    codeNodeId: string,
    activeOnly: boolean = true,
  ): Promise<Array<{ id: string; name: string; entityType: EntityType }>> {
    const validFilter = activeOnly ? 'AND db.valid_to IS NULL' : '';
    const rows = await this.graph.query(
      `MATCH (c {id: $codeNodeId, projectId: $projectId})
       MATCH (c)-[db:DOCUMENTED_BY {projectId: $projectId}]->(e:WikiEntity)
       WHERE 1=1 ${validFilter}
       RETURN e.id AS id, e.name AS name, e.entity_type AS entityType`,
      { projectId, codeNodeId },
    );
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      entityType: r.entityType as EntityType,
    }));
  }

  /**
   * v1.3.0 Phase 1 T1-6 helper: Close active DESCRIBES + DOCUMENTED_BY edges
   * pointing to a CodeNode that is being superseded.
   *
   * Sets valid_to = datetime() and txn_to = datetime() on all currently-active
   * (valid_to IS NULL) cross-domain edges incident to the given CodeNode.
   *
   * Called by supersedeRelation() in bitemporal-queries.ts when the target
   * node is a CodeNode (incremental analysis replacing an old node with a
   * new one).
   */
  async closeCrossDomainEdgesForCodeNode(
    projectId: string,
    codeNodeId: string,
  ): Promise<void> {
    await this.graph.query(
      `MATCH (e:WikiEntity)-[d:DESCRIBES {projectId: $projectId}]->(c {id: $codeNodeId, projectId: $projectId})
       WHERE d.valid_to IS NULL
       SET d.valid_to = datetime(), d.txn_to = datetime()
       WITH e
       MATCH (c2 {id: $codeNodeId, projectId: $projectId})-[db:DOCUMENTED_BY {projectId: $projectId}]->(e)
       WHERE db.valid_to IS NULL
       SET db.valid_to = datetime(), db.txn_to = datetime()`,
      { projectId, codeNodeId },
    );
  }

  // ==========================================
  // Topic
  // ==========================================

  async createTopic(topic: WikiTopic): Promise<void> {
    await this.graph.query(
      `MERGE (t:WikiTopic {id: $id, projectId: $projectId})
       SET t.title = $title,
           t.content = $content,
           t.compiled_at = $compiledAt,
           t.projectId = $projectId,
           t.topic_type = $topicType`,
      {
        id: topic.id,
        projectId: topic.projectId,
        title: topic.title,
        content: topic.content,
        compiledAt: topic.compiledAt,
        topicType: topic.topicType ?? 'general',
      },
    );
  }

  async listTopics(projectId: string): Promise<WikiTopic[]> {
    const rows = await this.graph.query(
      `MATCH (t:WikiTopic) WHERE t.projectId = $projectId
       WITH t ORDER BY t.compiled_at DESC
       RETURN t.id AS id, t.projectId AS projectId, t.title AS title,
              t.content AS content, t.compiled_at AS compiledAt,
              t.topic_type AS topicType`,
      { projectId },
    );
    return rows.map(r => ({
      id: r.id as string,
      projectId: r.projectId as string,
      title: r.title as string,
      content: r.content as string,
      compiledAt: r.compiledAt as string,
      topicType: (r.topicType as 'general' | 'evolution' | undefined) ?? 'general',
    }));
  }

  /**
   * P2-T5: Get a single topic by ID, scoped by projectId.
   *
   * Used by GET /api/wiki/evolution-story/:topicId to retrieve a
   * stored evolution narrative.
   */
  async getTopic(projectId: string, topicId: string): Promise<WikiTopic | null> {
    const rows = await this.graph.query(
      `MATCH (t:WikiTopic) WHERE t.id = $id AND t.projectId = $projectId
       RETURN t.id AS id, t.projectId AS projectId, t.title AS title,
              t.content AS content, t.compiled_at AS compiledAt,
              t.topic_type AS topicType`,
      { id: topicId, projectId },
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      projectId: r.projectId as string,
      title: r.title as string,
      content: r.content as string,
      compiledAt: r.compiledAt as string,
      topicType: (r.topicType as 'general' | 'evolution' | undefined) ?? 'general',
    };
  }

  // ==========================================
  // Log
  // ==========================================

  async appendLog(entry: WikiLogEntry): Promise<void> {
    await this.graph.query(
      `CREATE (l:WikiLogEntry {
         id: $id,
         projectId: $projectId,
         action: $action,
         description: $description,
         details: $details,
         page_count: $pageCount,
         created_at: $createdAt
       })`,
      {
        id: entry.id,
        projectId: entry.projectId,
        action: entry.action,
        description: entry.description,
        details: entry.details,
        pageCount: entry.pageCount,
        createdAt: entry.createdAt,
      },
    );
  }

  async getLogs(projectId: string, limit: number = 50): Promise<WikiLogEntry[]> {
    const rows = await this.graph.query(
      `MATCH (l:WikiLogEntry) WHERE l.projectId = $projectId
       RETURN l.id AS id, l.projectId AS projectId, l.action AS action, l.description AS description,
              l.details AS details, l.page_count AS pageCount, l.created_at AS createdAt
       ORDER BY l.created_at DESC
       LIMIT $limit`,
      { projectId, limit },
    );
    return rows.map(r => ({
      id: r.id as string,
      projectId: r.projectId as string,
      action: r.action as WikiLogEntry['action'],
      description: r.description as string,
      details: r.details as string,
      pageCount: this.toNumber(r.pageCount),
      createdAt: r.createdAt as string,
    }));
  }

  // ==========================================
  // Index (knowledge map)
  // ==========================================

  async getIndex(projectId: string): Promise<WikiIndex> {
    const [entities, sources, topics] = await Promise.all([
      this.graph.query(
        `MATCH (e:WikiEntity) WHERE e.projectId = $projectId
         OPTIONAL MATCH (other:WikiEntity)-[r:LINKS_TO]->(e)
         WHERE r.projectId = $projectId
         WITH e, count(other) AS linkCount
         ORDER BY e.name
         RETURN e.id AS id, e.name AS name, e.entity_type AS type, linkCount`,
        { projectId },
      ),
      this.graph.query(
        `MATCH (s:WikiSource) WHERE s.projectId = $projectId
         OPTIONAL MATCH (s)-[r:EXTRACTS]->(e:WikiEntity)
         WHERE r.projectId = $projectId
         WITH s, count(e) AS entityCount
         ORDER BY s.compiled_at DESC
         RETURN s.id AS id, s.title AS title, entityCount`,
        { projectId },
      ),
      this.graph.query(
        `MATCH (t:WikiTopic) WHERE t.projectId = $projectId
         WITH t ORDER BY t.compiled_at DESC
         RETURN t.id AS id, t.title AS title`,
        { projectId },
      ),
    ]);

    return {
      entities: entities.map(r => ({
        id: r.id as string,
        name: r.name as string,
        type: r.type as EntityType,
        linkCount: this.toNumber(r.linkCount),
      })),
      sources: sources.map(r => ({
        id: r.id as string,
        title: r.title as string,
        entityCount: this.toNumber(r.entityCount),
      })),
      topics: topics.map(r => ({
        id: r.id as string,
        title: r.title as string,
      })),
    };
  }

  // ==========================================
  // Project management
  // ==========================================

  /**
   * Delete all wiki nodes (Source/Entity/Topic/Log) for a given projectId.
   * Called during analyze_repo to reset wiki state before re-ingesting.
   */
  async clearProjectWiki(projectId: string): Promise<void> {
    await this.graph.query(
      `MATCH (n) WHERE n.projectId = $projectId
         AND (n:WikiSource OR n:WikiEntity OR n:WikiTopic OR n:WikiLogEntry)
       DETACH DELETE n`,
      { projectId },
    );
  }

  // ==========================================
  // Private helpers
  // ==========================================

  private toNumber(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && 'toNumber' in (val as object)) {
      return (val as { toNumber: () => number }).toNumber();
    }
    return Number(val);
  }
}
