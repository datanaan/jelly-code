import neo4j from 'neo4j-driver';
import type {
  IGraphStore,
  CodeNode,
  Relation,
  BFSResult,
  ProcessInfo,
  CommunityInfo,
} from '../interfaces.js';
import type { Neo4jConfig } from '../../config/index.js';
import { initializeSchema, quoteLabel } from './schema.js';

/**
 * Neo4j implementation of IGraphStore.
 *
 * Design decisions:
 * - All relations use a single `CODE_RELATION` type with a `type` property
 *   for the semantic relation (CALLS, IMPORTS, ...)
 * - Every node carries `projectId` and every query filters on it for
 *   multi-tenant isolation.
 * - Labels that collide with Cypher reserved words are backtick-quoted.
 * - Batch writes use UNWIND parameterised queries for performance.
 * - BFS traversal is iterative: one query per depth level.
 */
export class Neo4jAdapter implements IGraphStore {
  private driver: neo4j.Driver;

  constructor(private config: Neo4jConfig) {
    this.driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.user, config.password),
      { maxConnectionPoolSize: 50 },
    );
  }

  /** Execute a write query in a managed transaction */
  private async writeQuery<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      const result = await session.executeWrite(tx => tx.run(cypher, params));
      return result.records.map(r => r.toObject() as T);
    } finally {
      await session.close();
    }
  }

  /** Execute a read query in a managed transaction */
  private async readQuery<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.executeRead(tx => tx.run(cypher, params));
      return result.records.map(r => r.toObject() as T);
    } finally {
      await session.close();
    }
  }

  /** Convert a Neo4j integer to a JS number */
  private toNumber(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && 'toNumber' in (val as object)) {
      return (val as { toNumber: () => number }).toNumber();
    }
    return Number(val);
  }

  // ==========================================
  // Schema
  // ==========================================

  async initializeSchema(): Promise<void> {
    await initializeSchema(async (cypher: string, readOnly?: boolean) => {
      if (readOnly) {
        return this.readQuery(cypher);
      }
      await this.writeQuery(cypher);
    });
  }

  // ==========================================
  // Symbol queries
  // ==========================================

  async findSymbol(projectId: string, name: string, types?: string[]): Promise<CodeNode[]> {
    const typeFilter = types?.length ? ' AND n.type IN $types' : '';
    const results = await this.readQuery(
      `MATCH (n)
       WHERE n.projectId = $projectId AND n.name = $name${typeFilter}
       RETURN n`,
      { projectId, name, types },
    );
    return results.map(r => this.nodeToCodeNode(r.n as Record<string, unknown>));
  }

  async findSymbolByFile(projectId: string, filePath: string): Promise<CodeNode[]> {
    const results = await this.readQuery(
      `MATCH (n)
       WHERE n.projectId = $projectId AND n.filePath CONTAINS $filePath
       AND (n:Function OR n:Class OR n:Method OR n:File OR n:Section OR n:CodeElement)
       RETURN n`,
      { projectId, filePath },
    );
    return results.map(r => this.nodeToCodeNode(r.n as Record<string, unknown>));
  }

  async getNode(projectId: string, nodeId: string): Promise<CodeNode | null> {
    const results = await this.readQuery(
      `MATCH (n:CodeElement {id: $nodeId, projectId: $projectId})
       RETURN n`,
      { projectId, nodeId },
    );
    if (results.length === 0) return null;
    return this.nodeToCodeNode(results[0].n as Record<string, unknown>);
  }

  // ==========================================
  // Relation queries
  // ==========================================

  async getInboundRelations(projectId: string, nodeId: string, types?: string[]): Promise<Relation[]> {
    const typeFilter = types?.length ? ' AND r.type IN $types' : '';
    const results = await this.readQuery(
      `MATCH (a)-[r:CODE_RELATION]->(b {id: $nodeId, projectId: $projectId})
       WHERE b.projectId = $projectId${typeFilter}
       RETURN a.id AS sourceId, b.id AS targetId, r.type AS type,
              r.confidence AS confidence, r.reason AS reason, r.step AS step`,
      { projectId, nodeId, types },
    );
    return results.map(r => ({
      id: `${r.sourceId}-${r.type}-${r.targetId}`,
      type: r.type as string,
      projectId,
      sourceId: r.sourceId as string,
      targetId: r.targetId as string,
      confidence: this.toNumber(r.confidence),
      reason: r.reason as string | undefined,
      step: r.step != null ? this.toNumber(r.step) : undefined,
    }));
  }

  async getOutboundRelations(projectId: string, nodeId: string, types?: string[]): Promise<Relation[]> {
    const typeFilter = types?.length ? ' AND r.type IN $types' : '';
    const results = await this.readQuery(
      `MATCH (a {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION]->(b)
       WHERE a.projectId = $projectId${typeFilter}
       RETURN a.id AS sourceId, b.id AS targetId, r.type AS type,
              r.confidence AS confidence, r.reason AS reason, r.step AS step`,
      { projectId, nodeId, types },
    );
    return results.map(r => ({
      id: `${r.sourceId}-${r.type}-${r.targetId}`,
      type: r.type as string,
      projectId,
      sourceId: r.sourceId as string,
      targetId: r.targetId as string,
      confidence: this.toNumber(r.confidence),
      reason: r.reason as string | undefined,
      step: r.step != null ? this.toNumber(r.step) : undefined,
    }));
  }

  // ==========================================
  // BFS traversal
  // ==========================================

  async bfsTraverse(projectId: string, seedIds: string[], relTypes: string[], maxDepth: number): Promise<BFSResult> {
    const visited: CodeNode[] = [];
    const edges: Relation[] = [];
    const depths = new Map<string, number>();
    const seen = new Set<string>(seedIds);
    let frontier = seedIds;

    // Add seeds to visited
    if (seedIds.length > 0) {
      const seedNodes = await this.readQuery(
        `MATCH (n) WHERE n.id IN $ids AND n.projectId = $projectId RETURN n`,
        { ids: seedIds, projectId },
      );
      for (const r of seedNodes) {
        const node = this.nodeToCodeNode(r.n as Record<string, unknown>);
        visited.push(node);
        depths.set(node.id, 0);
      }
    }

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const results = await this.readQuery(
        `MATCH (caller)-[r:CODE_RELATION]->(n)
         WHERE n.projectId = $projectId
           AND n.id IN $frontier
           AND r.type IN $relTypes
           AND caller.projectId = $projectId
         RETURN caller, r, n, r.type AS relType, r.confidence AS confidence,
                r.reason AS reason, r.step AS step`,
        { projectId, frontier, relTypes },
      );

      const nextFrontier: string[] = [];
      for (const r of results) {
        const caller = this.nodeToCodeNode(r.caller as Record<string, unknown>);
        const target = this.nodeToCodeNode(r.n as Record<string, unknown>);
        const relType = r.relType as string;
        const confidence = this.toNumber(r.confidence);

        if (!seen.has(caller.id)) {
          seen.add(caller.id);
          visited.push(caller);
          depths.set(caller.id, depth);
          nextFrontier.push(caller.id);
        }

        edges.push({
          id: `${caller.id}-${relType}-${target.id}`,
          type: relType,
          projectId,
          sourceId: caller.id,
          targetId: target.id,
          confidence,
          reason: r.reason as string | undefined,
          step: r.step != null ? this.toNumber(r.step) : undefined,
        });
      }
      frontier = nextFrontier;
    }

    return { visited, edges, depths };
  }

  // ==========================================
  // Execution flow
  // ==========================================

  async findProcessesByNode(projectId: string, nodeId: string): Promise<ProcessInfo[]> {
    const results = await this.readQuery(
      `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'STEP_IN_PROCESS'}]->(p:Process)
       WHERE p.projectId = $projectId
       RETURN p`,
      { projectId, nodeId },
    );
    return results.map(r => {
      const p = r.p as Record<string, unknown>;
      return {
        id: p.id as string,
        label: p.label as string,
        processType: p.processType as string,
        stepCount: this.toNumber(p.stepCount),
        communities: (p.communities as string[]) || [],
        entryPointId: p.entryPointId as string | undefined,
      };
    });
  }

  async findEntryPoint(projectId: string, processId: string): Promise<CodeNode | null> {
    const results = await this.readQuery(
      `MATCH (ep)-[r:CODE_RELATION {type: 'ENTRY_POINT_OF'}]->(p:Process {id: $processId, projectId: $projectId})
       WHERE ep.projectId = $projectId
       RETURN ep`,
      { projectId, processId },
    );
    if (results.length === 0) return null;
    return this.nodeToCodeNode(results[0].ep as Record<string, unknown>);
  }

  // ==========================================
  // Community
  // ==========================================

  async findCommunityByNode(projectId: string, nodeId: string): Promise<CommunityInfo | null> {
    const results = await this.readQuery(
      `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'MEMBER_OF'}]->(c:Community)
       WHERE c.projectId = $projectId
       RETURN c`,
      { projectId, nodeId },
    );
    if (results.length === 0) return null;
    const c = results[0].c as Record<string, unknown>;
    return {
      id: c.id as string,
      label: c.label as string,
      heuristicLabel: c.heuristicLabel as string,
      keywords: (c.keywords as string[]) || [],
      description: c.description as string,
      cohesion: this.toNumber(c.cohesion),
      symbolCount: this.toNumber(c.symbolCount),
    };
  }

  // ==========================================
  // Batch writes
  // ==========================================

  async batchCreateNodes(nodes: CodeNode[]): Promise<void> {
    if (nodes.length === 0) return;

    // Group by type for label-specific UNWIND
    const groups = new Map<string, CodeNode[]>();
    for (const node of nodes) {
      const type = node.type || 'CodeElement';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push(node);
    }

    for (const [type, group] of groups) {
      const qLabel = quoteLabel(type);
      // Clean properties: remove internal fields, handle arrays
      const rows = group.map(n => {
        const clean: Record<string, unknown> = { ...n };
        // Remove undefined values (Neo4j doesn't accept them)
        for (const key of Object.keys(clean)) {
          if (clean[key] === undefined) delete clean[key];
        }
        return clean;
      });

      // Process in batches of 500
      const batchSize = 500;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await this.writeQuery(
          `UNWIND $rows AS row
           MERGE (n:${qLabel} {id: row.id, projectId: row.projectId})
           SET n += row`,
          { rows: batch },
        );
      }
    }
  }

  async batchCreateRelations(relations: Relation[]): Promise<void> {
    if (relations.length === 0) return;

    const rows = relations.map(r => ({ ...r }));

    // Batch-resolve node labels for all source/target IDs to avoid label-less MATCH (full table scan).
    // We query in chunks to stay within UNWIND performance bounds.
    const allIds = new Set<string>();
    for (const r of rows) {
      allIds.add(r.sourceId as string);
      allIds.add(r.targetId as string);
    }
    const idArray = Array.from(allIds);
    const projectId = (rows[0] as Record<string, unknown>).projectId as string;

    const idToLabel = new Map<string, string>();
    const labelBatchSize = 2000;
    for (let i = 0; i < idArray.length; i += labelBatchSize) {
      const batch = idArray.slice(i, i + labelBatchSize);
      const results = await this.readQuery(
        `MATCH (n) WHERE n.projectId = $projectId AND n.id IN $ids
         RETURN n.id AS id, labels(n)[0] AS label`,
        { projectId, ids: batch },
      );
      for (const row of results) {
        idToLabel.set(row.id as string, row.label as string);
      }
    }

    // Group relations by (sourceLabel, targetLabel) so each batch uses label-specific MATCH
    // which can leverage the per-label unique id indexes.
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const srcLabel = idToLabel.get(row.sourceId as string) || 'CodeElement';
      const tgtLabel = idToLabel.get(row.targetId as string) || 'CodeElement';
      const key = `${srcLabel}|${tgtLabel}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const batchSize = 500;
    for (const [key, groupRows] of groups) {
      const [srcLabel, tgtLabel] = key.split('|');
      const qSrc = quoteLabel(srcLabel!);
      const qTgt = quoteLabel(tgtLabel!);

      for (let i = 0; i < groupRows.length; i += batchSize) {
        const batch = groupRows.slice(i, i + batchSize);
        await this.writeQuery(
          `UNWIND $rows AS row
           MATCH (a:${qSrc} {id: row.sourceId, projectId: row.projectId})
           MATCH (b:${qTgt} {id: row.targetId, projectId: row.projectId})
           MERGE (a)-[r:CODE_RELATION {sourceId: row.sourceId, targetId: row.targetId, type: row.type}]->(b)
           SET r += row`,
          { rows: batch },
        );
      }
    }
  }

  async findNodeIdsByFilePath(projectId: string, filePath: string): Promise<string[]> {
    // Use filePath indexes on high-frequency labels for indexed lookup.
    // Falls back to general CodeElement label.
    const results = await this.readQuery(
      `MATCH (n) WHERE n.projectId = $projectId AND n.filePath = $filePath
       AND (n:Function OR n:Class OR n:Method OR n:File OR n:Section OR n:CodeElement)
       RETURN n.id AS id`,
      { projectId, filePath },
    );
    return results.map(r => r.id as string);
  }

  /**
   * Batch version of findNodeIdsByFilePath.
   * Returns a Map from filePath → nodeIds for all given paths in a single query.
   * Avoids N sequential queries when mapping many file changes to nodes.
   */
  async findNodeIdsByFilePaths(projectId: string, filePaths: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (filePaths.length === 0) return result;

    // Deduplicate
    const uniquePaths = [...new Set(filePaths)];

    // Process in batches of 500
    const batchSize = 500;
    for (let i = 0; i < uniquePaths.length; i += batchSize) {
      const batch = uniquePaths.slice(i, i + batchSize);
      const rows = await this.readQuery(
        `MATCH (n) WHERE n.projectId = $projectId AND n.filePath IN $paths
         AND (n:Function OR n:Class OR n:Method OR n:File OR n:Section OR n:CodeElement)
         RETURN n.filePath AS filePath, collect(n.id) AS ids`,
        { projectId, paths: batch },
      );
      for (const row of rows) {
        const fp = row.filePath as string;
        const ids = row.ids as string[];
        if (ids.length > 0) {
          result.set(fp, ids);
        }
      }
    }
    return result;
  }

  async deleteNodesByFilePath(projectId: string, filePath: string): Promise<string[]> {
    // First get IDs, then DETACH DELETE
    const ids = await this.findNodeIdsByFilePath(projectId, filePath);
    if (ids.length === 0) return [];

    await this.writeQuery(
      `MATCH (n) WHERE n.projectId = $projectId AND n.filePath = $filePath
       AND (n:Function OR n:Class OR n:Method OR n:File OR n:Section OR n:Property OR n:Route OR n:Process OR n:CodeElement)
       DETACH DELETE n`,
      { projectId, filePath },
    );
    return ids;
  }

  async deleteNodesByIds(projectId: string, nodeIds: string[]): Promise<number> {
    if (nodeIds.length === 0) return 0;

    let deleted = 0;
    const batchSize = 500;
    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      // Resolve labels for efficient MATCH
      const labelMap = await this.resolveLabelsForIds(projectId, batch);
      for (const [label, ids] of labelMap) {
        const qLabel = quoteLabel(label);
        await this.writeQuery(
          `MATCH (n:${qLabel}) WHERE n.projectId = $projectId AND n.id IN $ids DETACH DELETE n`,
          { projectId, ids },
        );
        deleted += ids.length;
      }
    }
    return deleted;
  }

  /**
   * Resolve the primary label for a set of node IDs.
   * Returns a Map from label → array of IDs with that label.
   */
  private async resolveLabelsForIds(projectId: string, ids: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const rows = await this.readQuery(
      `MATCH (n) WHERE n.projectId = $projectId AND n.id IN $ids
       RETURN n.id AS id, labels(n)[0] AS label`,
      { projectId, ids },
    );
    for (const row of rows) {
      const label = (row.label as string) || 'CodeElement';
      const id = row.id as string;
      if (!result.has(label)) result.set(label, []);
      result.get(label)!.push(id);
    }
    return result;
  }

  // ==========================================
  // Raw query
  // ==========================================

  async query(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    // Auto-detect write queries: MERGE, CREATE, SET, DELETE, DETACH, REMOVE
    const isWrite = /\b(MERGE|CREATE|SET|DELETE|DETACH|REMOVE)\b/i.test(cypher);
    return isWrite
      ? this.writeQuery(cypher, params)
      : this.readQuery(cypher, params);
  }

  // ==========================================
  // Project management
  // ==========================================

  async clearProject(projectId: string): Promise<void> {
    // Delete all nodes with projectId (Commit, CodeNode, Project, etc.)
    await this.writeQuery(
      `MATCH (n)
       WHERE n.projectId = $projectId
       DETACH DELETE n`,
      { projectId },
    );
    // Clean up orphan Author nodes (no remaining AUTHORED_BY relations)
    await this.writeQuery(
      `MATCH (a:Author)
       WHERE NOT (a)--()
       DELETE a`,
      {},
    );
  }

  async listProjects(): Promise<string[]> {
    const results = await this.readQuery(
      `MATCH (p:Project) RETURN p.id AS id`,
    );
    return results.map(r => r.id as string);
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async close(): Promise<void> {
    await this.driver.close();
  }

  // ==========================================
  // Helpers
  // ==========================================

  private nodeToCodeNode(nodeOrProps: Record<string, unknown>): CodeNode {
    // Unwrap Neo4j Node objects — RETURN n yields {identity, labels, properties, elementId}
    const props = (nodeOrProps.properties != null && typeof nodeOrProps.properties === 'object'
      ? nodeOrProps.properties as Record<string, unknown>
      : nodeOrProps);
    return {
      id: props.id as string,
      type: props.type as string,
      projectId: props.projectId as string,
      name: props.name as string,
      filePath: props.filePath as string,
      startLine: props.startLine != null ? this.toNumber(props.startLine) : undefined,
      endLine: props.endLine != null ? this.toNumber(props.endLine) : undefined,
      isExported: props.isExported as boolean | undefined,
      content: props.content as string | undefined,
      description: props.description as string | undefined,
      parameterCount: props.parameterCount != null ? this.toNumber(props.parameterCount) : undefined,
      returnType: props.returnType as string | undefined,
      keywords: props.keywords as string[] | undefined,
      heuristicLabel: props.heuristicLabel as string | undefined,
      label: props.label as string | undefined,
      processType: props.processType as string | undefined,
      stepCount: props.stepCount != null ? this.toNumber(props.stepCount) : undefined,
      communities: props.communities as string[] | undefined,
      entryPointId: props.entryPointId as string | undefined,
      cohesion: props.cohesion != null ? this.toNumber(props.cohesion) : undefined,
      symbolCount: props.symbolCount != null ? this.toNumber(props.symbolCount) : undefined,
    };
  }
}
