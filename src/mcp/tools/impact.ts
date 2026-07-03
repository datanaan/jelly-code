/**
 * MCP Tool: impact
 *
 * Blast radius / impact analysis using BFS traversal.
 * Supports direction (upstream/downstream) and target name lookup.
 * When includeHistorical is true, augments with combined structural + historical analysis.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { predictCombinedImpact } from '../../prediction/combined-impact.js';
import { addFreshnessWarnings } from './freshness.js';

export function registerImpact(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'impact',
    {
      description: 'Analyze the blast radius / impact of a code change. Supports upstream (what depends on this) and downstream (what this depends on) direction. Accepts nodeIds or target symbol name. Set includeHistorical=true to augment with co-change coupling predictions. Note: community and temporal data may be stale in incremental mode — use project_status to check freshness.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        nodeIds: z.array(z.string()).optional().describe('Node IDs of the changed symbols'),
        target: z.string().optional().describe('Symbol name to analyze (alternative to nodeIds)'),
        direction: z.enum(['upstream', 'downstream']).optional().default('upstream').describe('upstream = what depends on this, downstream = what this depends on'),
        depth: z.number().optional().default(3).describe('Maximum traversal depth'),
        relTypes: z.array(z.string()).optional().describe('Relationship types to follow'),
        file_path: z.string().optional().describe('File path to disambiguate target name'),
        includeHistorical: z.boolean().optional().default(true).describe('Include historical co-change coupling predictions (requires temporal data)'),
      },
    },
    async ({ projectId, nodeIds, target, direction, depth, relTypes, file_path, includeHistorical }) => {
      try {
        // Resolve target name to nodeIds
        let seedIds = nodeIds ?? [];
        if (seedIds.length === 0 && target) {
          const candidates = await stores.graph.findSymbol(projectId, target);
          if (candidates.length === 0) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Symbol not found: ${target}` }) }],
              isError: true,
            };
          }
          let matched = candidates;
          if (file_path) {
            const filtered = candidates.filter(c => c.filePath.includes(file_path));
            if (filtered.length > 0) matched = filtered;
          }
          const preferred = matched.find(c => c.type === 'Class' || c.type === 'Interface');
          seedIds = [(preferred ?? matched[0]).id];
        }

        if (seedIds.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either nodeIds or target is required' }) }],
            isError: true,
          };
        }

        const defaultRelTypes = ['CALLS', 'IMPORTS', 'USES', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES'];
        const useRelTypes = relTypes ?? defaultRelTypes;
        const dir = direction ?? 'upstream';
        const useHistorical = includeHistorical ?? true;

        // For upstream: we want nodes that DEPEND ON the seeds (inbound relations)
        // For downstream: we want nodes that the seeds DEPEND ON (outbound relations)
        const impactedNodes: Array<{ id: string; name: string; type: string; filePath: string; depth: number }> = [];
        const impactEdges: Array<{ source: string; target: string; type: string }> = [];
        const visited = new Set<string>(seedIds);

        if (dir === 'upstream') {
          // BFS through inbound relations: who calls/imports the seeds
          let frontier = [...seedIds];
          for (let d = 1; d <= (depth ?? 3); d++) {
            const nextFrontier: string[] = [];
            for (const nid of frontier) {
              const inbound = await stores.graph.getInboundRelations(projectId, nid);
              for (const rel of inbound) {
                if (!useRelTypes.includes(rel.type)) continue;
                if (visited.has(rel.sourceId)) continue;
                visited.add(rel.sourceId);
                const node = await stores.graph.getNode(projectId, rel.sourceId);
                if (node) {
                  impactedNodes.push({ id: node.id, name: node.name, type: node.type, filePath: node.filePath, depth: d });
                  impactEdges.push({ source: rel.sourceId, target: rel.targetId, type: rel.type });
                  nextFrontier.push(rel.sourceId);
                }
              }
            }
            frontier = nextFrontier;
          }
        } else {
          // downstream: BFS through outbound relations
          let frontier = [...seedIds];
          for (let d = 1; d <= (depth ?? 3); d++) {
            const nextFrontier: string[] = [];
            for (const nid of frontier) {
              const outbound = await stores.graph.getOutboundRelations(projectId, nid);
              for (const rel of outbound) {
                if (!useRelTypes.includes(rel.type)) continue;
                if (visited.has(rel.targetId)) continue;
                visited.add(rel.targetId);
                const node = await stores.graph.getNode(projectId, rel.targetId);
                if (node) {
                  impactedNodes.push({ id: node.id, name: node.name, type: node.type, filePath: node.filePath, depth: d });
                  impactEdges.push({ source: rel.sourceId, target: rel.targetId, type: rel.type });
                  nextFrontier.push(rel.targetId);
                }
              }
            }
            frontier = nextFrontier;
          }
        }

        // Risk assessment
        let risk = 'LOW';
        if (impactedNodes.length >= 10) risk = 'CRITICAL';
        else if (impactedNodes.length >= 5) risk = 'HIGH';
        else if (impactedNodes.length >= 3) risk = 'MEDIUM';

        const baseResult: Record<string, unknown> = {
          target: target ?? seedIds,
          direction: dir,
          risk,
          summary: `${impactedNodes.length} ${dir} dependents found`,
          seedNodes: seedIds,
          impactedNodes,
          impactEdges,
          totalImpacted: impactedNodes.length,
          maxDepth: depth ?? 3,
          byDepth: groupByDepth(impactedNodes),
        };

        // Augment with historical data if requested
        if (useHistorical) {
          try {
            const prediction = await predictCombinedImpact(
              projectId,
              seedIds,
              stores.graph,
              { maxBfsDepth: depth ?? 3 },
            );

            // Only add historical fields if there is actual historical data
            if (prediction.historicalCoupling.length > 0) {
              baseResult.highRisk = prediction.highRisk;
              baseResult.hidden = prediction.hidden;
              baseResult.combined = prediction.combined;
              baseResult.historicalNote = `${prediction.highRisk.length} high-risk (structural+historical), ${prediction.hidden.length} hidden (historical only)`;
            } else {
              baseResult.highRisk = [];
              baseResult.hidden = [];
              baseResult.combined = prediction.combined;
              baseResult.historicalNote = 'No historical co-change data available — showing structural analysis only';
            }
          } catch {
            // Graceful degradation: if combined impact fails, just use structural results
            baseResult.highRisk = [];
            baseResult.hidden = [];
            baseResult.combined = impactedNodes.map(n => n.id);
            baseResult.historicalNote = 'Historical analysis unavailable — showing structural analysis only';
          }
        }

        await addFreshnessWarnings(projectId, stores.graph, baseResult);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(baseResult, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

function groupByDepth(nodes: Array<{ depth: number; [k: string]: unknown }>): Record<string, unknown[]> {
  const groups: Record<string, unknown[]> = {};
  for (const n of nodes) {
    const key = String(n.depth);
    if (!groups[key]) groups[key] = [];
    groups[key].push(n);
  }
  return groups;
}
