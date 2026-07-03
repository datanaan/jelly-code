/**
 * Code REST API routes.
 *
 * Provides HTTP endpoints for code-level operations including
 * bi-temporal point-in-time queries.
 *
 * All routes are mounted under /api/code with auth and quota middleware
 * (applied at the server level in index.ts).
 */

import { Router } from 'express';
import type { BitemporalQueries, TemporalRelation } from '../store/neo4j/bitemporal-queries.js';

export function createCodeRoutes(queries: BitemporalQueries): Router {
  const router = Router();

  // GET /api/code/as-of?projectId=X&nodeId=Y&time=T[&format=diff]
  // P1-T6: Point-in-time query for code node state.
  //
  // Returns the node and its valid relations at time T, enabling
  // "what did this code look like on date X?" queries.
  //
  // Query params:
  // - projectId (required): project identifier
  // - nodeId (required): node identifier
  // - time (required): ISO 8601 timestamp for point-in-time query
  // - format (optional): "diff" to include change diff representation
  //
  // Response shape:
  //   {
  //     projectId, nodeId, time,
  //     node: CodeNode | null,
  //     relations: TemporalRelation[],
  //     format?: "diff",
  //     diff?: { added: TemporalRelation[], removed: TemporalRelation[] }
  //   }
  router.get('/as-of', async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId query parameter is required' });
      }

      const nodeId = req.query.nodeId as string | undefined;
      if (!nodeId || typeof nodeId !== 'string') {
        return res.status(400).json({ error: 'nodeId query parameter is required' });
      }

      const time = req.query.time as string | undefined;
      if (!time || typeof time !== 'string') {
        return res.status(400).json({ error: 'time query parameter is required' });
      }

      // Validate time is a parseable ISO 8601 timestamp
      const parsedTime = new Date(time);
      if (isNaN(parsedTime.getTime())) {
        return res.status(400).json({ error: `Invalid time format: "${time}". Must be a valid ISO 8601 timestamp.` });
      }

      const format = req.query.format as string | undefined;
      if (format && format !== 'diff') {
        return res.status(400).json({ error: `Invalid format: "${format}". Supported: "diff".` });
      }

      const result = await queries.findNodeAsOf(projectId, nodeId, time);

      // Node not found → 404
      if (result.node === null) {
        return res.status(404).json({
          error: `Node "${nodeId}" not found in project "${projectId}" at time ${time}`,
          projectId,
          nodeId,
          time,
        });
      }

      // Build response
      const response: Record<string, unknown> = {
        projectId,
        nodeId,
        time,
        node: result.node,
        relations: result.relations,
      };

      // format=diff: compute diff representation
      // For a point-in-time query, the "diff" view shows which relations
      // are present vs absent at time T (compared to the current state).
      // This is useful for "what changed since T?" analysis.
      if (format === 'diff') {
        response.format = 'diff';
        // At point-in-time T, the diff is:
        // - added: relations valid at T (these are what was present at T)
        // - removed: relations NOT valid at T (superseded or not-yet-created)
        // For a simple as-of diff, we present current relations as "added"
        // since the query returns only valid-at-T relations.
        const added: TemporalRelation[] = result.relations;
        const removed: TemporalRelation[] = [];
        response.diff = { added, removed };
      }

      res.json(response);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
