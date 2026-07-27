/**
 * v1.3.0 Phase 3 T3-2: CodeEntitySelector
 *
 * Selects CodeNodes from the Neo4j graph that should be auto-derived
 * into WikiEntity objects, based on configurable rules.
 *
 * Rules are applied in priority order (lowest priority number first).
 * Nodes are deduplicated across rules (highest-priority match wins).
 * Nodes already having a WikiEntity (via active DESCRIBES edge) are excluded.
 */

import type { IGraphStore } from '../store/interfaces.js';
import type { DerivationRules, DerivationRule } from './derivation-rules.js';
import neo4j from 'neo4j-driver';

// ─── Types ───────────────────────────────────────────────────────

export interface SelectedNode {
  id: string;
  name: string;
  type: string;
  filePath: string;
  /** Which rule matched this node. */
  matchedRule: string;
  /** Node content/source for signature generation. */
  content?: string;
}

// ─── Public API ──────────────────────────────────────────────────

export class CodeEntitySelector {
  constructor(
    private rules: DerivationRules,
    private graphStore: IGraphStore,
  ) {}

  /**
   * Select nodes for auto-derivation by applying rules in priority order.
   *
   * @param projectId - Project scope
   * @returns Deduplicated SelectedNode[] capped at maxEntitiesPerProject
   */
  async selectNodes(projectId: string): Promise<SelectedNode[]> {
    const maxTotal = this.rules.maxEntitiesPerProject ?? 200;
    const selected = new Map<string, SelectedNode>();

    // Apply rules in priority order (rules should already be sorted by loadRules)
    const sortedRules = [...this.rules.rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sortedRules) {
      if (selected.size >= maxTotal) break;

      const maxPerRule = rule.maxPerProject ?? maxTotal;
      const remaining = maxTotal - selected.size;
      const limit = Math.min(maxPerRule, remaining);

      const nodes = await this.queryRule(projectId, rule, limit);
      for (const node of nodes) {
        if (!selected.has(node.id)) {
          selected.set(node.id, node);
          if (selected.size >= maxTotal) break;
        }
      }
    }

    return Array.from(selected.values());
  }

  /**
   * Select nodes only from changed files (incremental mode).
   * Used by run-incremental.ts to avoid full-project scanning.
   */
  async selectNodesForChanges(
    projectId: string,
    changedFiles: string[],
  ): Promise<SelectedNode[]> {
    if (changedFiles.length === 0) return [];

    const maxTotal = this.rules.maxEntitiesPerProject ?? 200;
    const selected = new Map<string, SelectedNode>();

    // Query exported nodes in changed files
    const rows = await this.graphStore.query(
      `MATCH (n {projectId: $projectId})
       WHERE n.filePath IN $changedFiles
         AND (n:Function OR n:Class OR n:Interface)
         AND n.isExported = true
         AND NOT EXISTS {
           MATCH (:WikiEntity)-[d:DESCRIBES {projectId: $projectId}]->(n)
           WHERE d.valid_to IS NULL
         }
       RETURN n.id AS id, n.name AS name, n.type AS type,
              n.filePath AS filePath, n.content AS content
       LIMIT $maxTotal`,
      { projectId, changedFiles, maxTotal: neo4j.int(Math.floor(maxTotal)) },
    );

    for (const row of rows) {
      const id = row.id as string;
      if (!selected.has(id)) {
        selected.set(id, {
          id,
          name: (row.name as string) ?? '',
          type: (row.type as string) ?? '',
          filePath: (row.filePath as string) ?? '',
          content: (row.content as string) ?? undefined,
          matchedRule: 'incremental-exported',
        });
      }
    }

    return Array.from(selected.values());
  }

  // ─── Private: Rule Queries ────────────────────────────────────

  private async queryRule(
    projectId: string,
    rule: DerivationRule,
    limit: number,
  ): Promise<SelectedNode[]> {
    const filter = rule.filter;

    // Rule: exported_api
    if (filter.has_exportModifier) {
      const types = filter.type ?? ['Function', 'Class', 'Interface'];
      const rows = await this.graphStore.query(
        `MATCH (n {projectId: $projectId})
         WHERE n.type IN $types
           AND n.isExported = true
           AND NOT EXISTS {
             MATCH (:WikiEntity)-[d:DESCRIBES {projectId: $projectId}]->(n)
             WHERE d.valid_to IS NULL
           }
         RETURN n.id AS id, n.name AS name, n.type AS type,
                n.filePath AS filePath, n.content AS content
         LIMIT $limit`,
        { projectId, types, limit: neo4j.int(Math.floor(limit)) },
      );
      return rows.map(r => this.mapRow(r, rule.name));
    }

    // Rule: high_indegree
    if (filter.minInDegree !== undefined) {
      const rows = await this.graphStore.query(
        `MATCH (n {projectId: $projectId})
         WHERE (n:Function OR n:Class OR n:Interface)
           AND NOT EXISTS {
             MATCH (:WikiEntity)-[d:DESCRIBES {projectId: $projectId}]->(n)
             WHERE d.valid_to IS NULL
           }
         OPTIONAL MATCH (n)<-[r:CODE_RELATION]-()
         WITH n, count(r) AS inDegree
         WHERE inDegree >= $minInDegree
         RETURN n.id AS id, n.name AS name, n.type AS type,
                n.filePath AS filePath, n.content AS content, inDegree
         ORDER BY inDegree DESC
         LIMIT $limit`,
        { projectId, minInDegree: filter.minInDegree, limit: neo4j.int(Math.floor(limit)) },
      );
      return rows.map(r => this.mapRow(r, rule.name));
    }

    // Rule: community_top
    if (filter.communityRank !== undefined) {
      // Approximate: select high-degree nodes as community representatives
      // Full Leiden community ranking requires community detection query
      const rank = filter.communityRank;
      const rows = await this.graphStore.query(
        `MATCH (n {projectId: $projectId})
         WHERE (n:Function OR n:Class OR n:Interface)
           AND NOT EXISTS {
             MATCH (:WikiEntity)-[d:DESCRIBES {projectId: $projectId}]->(n)
             WHERE d.valid_to IS NULL
           }
         OPTIONAL MATCH (n)-[r:CODE_RELATION]-()
         WITH n, count(r) AS degree
         ORDER BY degree DESC
         LIMIT $rank
         RETURN n.id AS id, n.name AS name, n.type AS type,
                n.filePath AS filePath, n.content AS content`,
        { projectId, rank: neo4j.int(Math.floor(rank)), limit: neo4j.int(Math.floor(limit)) },
      );
      return rows.map(r => this.mapRow(r, rule.name));
    }

    return [];
  }

  private mapRow(row: Record<string, unknown>, ruleName: string): SelectedNode {
    return {
      id: row.id as string,
      name: (row.name as string) ?? '',
      type: (row.type as string) ?? '',
      filePath: (row.filePath as string) ?? '',
      content: (row.content as string) ?? undefined,
      matchedRule: ruleName,
    };
  }
}
