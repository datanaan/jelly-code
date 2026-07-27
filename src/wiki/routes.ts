/**
 * Wiki REST API routes.
 *
 * Provides HTTP endpoints for the Wiki feature.
 * All routes are mounted under /api/wiki with auth and quota middleware.
 *
 * ISSUE-002 FIX: All routes now require projectId in request body/query
 * for multi-tenant isolation.
 */

import { Router } from 'express';
import type { WikiService } from './service.js';
import { discoverDocs } from './doc-discovery.js';

export function createWikiRoutes(wikiService: WikiService): Router {
  const router = Router();

  // POST /api/wiki/ingest
  router.post('/ingest', async (req, res) => {
    try {
      const { projectId, source_path, content } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      if (!source_path || typeof source_path !== 'string') {
        return res.status(400).json({ error: 'source_path is required and must be a string' });
      }
      const taskId = wikiService.startIngest(projectId, source_path, typeof content === 'string' ? content : undefined);
      if (taskId === null) {
        return res.json({
          status: 'already_running',
          projectId,
          sourcePath: source_path,
          hint: 'Ingestion for this file is already in progress. Use GET /api/wiki/status to check progress.',
        });
      }
      res.json({
        status: 'processing',
        taskId,
        projectId,
        sourcePath: source_path,
        hint: 'Ingestion started in background. Use GET /api/wiki/status to check progress.',
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/batch-ingest
  router.post('/batch-ingest', async (req, res) => {
    try {
      const { projectId, dir, pattern, files } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      if (files && Array.isArray(files)) {
        // Content-based batch ingest — no filesystem needed
        const taskId = wikiService.startBatchIngestContent(projectId, files);
        res.json({
          status: 'processing',
          taskId,
          projectId,
          hint: 'Batch ingestion started in background. Use GET /api/wiki/status to check progress.',
        });
      } else if (dir && typeof dir === 'string') {
        // Filesystem-based batch ingest
        const taskId = wikiService.startBatchIngest(projectId, dir, pattern);
        if (taskId === null) {
          return res.json({
            status: 'already_running',
            projectId,
            dir,
            hint: 'Batch ingestion for this directory is already in progress. Use GET /api/wiki/status to check progress.',
          });
        }
        res.json({
          status: 'processing',
          taskId,
          projectId,
          dir,
          hint: 'Batch ingestion started in background. Use GET /api/wiki/status to check progress.',
        });
      } else {
        return res.status(400).json({ error: 'Either dir (string) or files (array of {source_path, content}) is required' });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/query
  router.post('/query', async (req, res) => {
    try {
      const { projectId, question, write_back } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'question is required and must be a string' });
      }
      const answer = await wikiService.query(projectId, question, write_back);
      res.json({ answer, projectId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/wiki/index?projectId=xxx
  router.get('/index', async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      if (!projectId) {
        return res.status(400).json({ error: 'projectId query parameter is required' });
      }
      const result = await wikiService.getIndex(projectId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/wiki/status?projectId=xxx&dir=xxx
  router.get('/status', async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      if (!projectId) {
        return res.status(400).json({ error: 'projectId query parameter is required' });
      }
      const dir = req.query.dir as string | undefined;
      const result = await wikiService.status(projectId, dir);

      // Include active tasks (filtered by projectId)
      const tasks: Record<string, unknown> = {};
      for (const [id, task] of wikiService.getActiveTasks(projectId)) {
        tasks[id] = task;
      }

      res.json({ ...result, projectId, activeTasks: tasks });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/lint
  router.post('/lint', async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      const issues = await wikiService.lint(projectId);
      res.json({ projectId, issues, count: issues.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/sync
  router.post('/sync', async (req, res) => {
    try {
      const { projectId, kb_id } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      if (!kb_id || typeof kb_id !== 'string') {
        return res.status(400).json({ error: 'kb_id is required and must be a string' });
      }
      const result = await wikiService.syncToJelly(projectId, kb_id);
      res.json({ ...result, projectId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/wiki/entity/:id?projectId=xxx
  router.get('/entity/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const projectId = req.query.projectId as string | undefined;
      if (!projectId) {
        return res.status(400).json({ error: 'projectId query parameter is required' });
      }
      const entity = await wikiService.getEntity(projectId, id);
      if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
      }
      res.json(entity);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/reindex
  router.post('/reindex', async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      const result = await wikiService.reindex(projectId);
      res.json({ ...result, projectId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/wiki/freshness?projectId=xxx[&entityId=yyy][&status=stale]
  // P0c-T5: Query entity freshness (code signature staleness) for a project.
  //
  // Returns a { items, summary } structure with 4-state classification:
  // - fresh: code signature matches current source code
  // - stale: code has changed since last compile
  // - orphaned: referenced code symbol no longer exists
  // - unbound: entity has no code signature binding
  //
  // Optional filters:
  // - entityId: return only the freshness of this entity
  // - status: filter to a specific state (fresh|stale|orphaned|unbound)
  router.get('/freshness', async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId query parameter is required' });
      }

      const validStatuses = ['fresh', 'stale', 'orphaned', 'unbound'] as const;
      const statusFilter = req.query.status as string | undefined;
      if (statusFilter && !validStatuses.includes(statusFilter as typeof validStatuses[number])) {
        return res.status(400).json({
          error: `Invalid status filter "${statusFilter}". Must be one of: ${validStatuses.join(', ')}`,
        });
      }

      const entityIdFilter = req.query.entityId as string | undefined;

      const report = await wikiService.getFreshness(projectId);

      // Apply filters
      let items = report.items;
      if (entityIdFilter) {
        items = items.filter((item) => item.entityId === entityIdFilter);
      }
      if (statusFilter) {
        items = items.filter((item) => item.status === statusFilter);
      }

      // Recompute summary for filtered results (entityId filter narrows items,
      // so summary should reflect only the filtered set)
      const summary = {
        fresh: 0,
        stale: 0,
        orphaned: 0,
        unbound: 0,
      };
      for (const item of items) {
        summary[item.status]++;
      }

      res.json({ items, summary });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/auto-discover
  // P0b-T3: Discover document files in a repository for Wiki ingestion.
  //
  // Synchronously walks the repository using discoverDocs (which combines
  // P0a's filesystem-walker with T1's document classifier) and returns
  // the list of discovered documents with classification metadata.
  //
  // The caller can then choose to ingest specific files via /ingest or
  // /batch-ingest. Async ingest (T4) will add an optional auto-ingest
  // step triggered after discovery.
  router.post('/auto-discover', async (req, res) => {
    try {
      const { projectId, repoPath } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      if (!repoPath || typeof repoPath !== 'string') {
        return res.status(400).json({ error: 'repoPath is required and must be a string' });
      }

      const discovered = await discoverDocs(repoPath);

      res.json({
        projectId,
        repoPath,
        discovered,
        count: discovered.length,
        hint: discovered.length > 0
          ? `Discovered ${discovered.length} document(s). Use POST /api/wiki/batch-ingest to ingest them.`
          : 'No documents discovered in the repository.',
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/wiki/evolution-story
  // P2-T5: Start async generation of a code evolution story for a given node.
  //
  // Accepts { projectId, nodeId }, kicks off fire-and-forget generation
  // via wikiService.startEvolutionStoryGeneration(), and returns { taskId }
  // immediately. The caller can poll GET /api/wiki/status for progress,
  // then use GET /api/wiki/evolution-story/:topicId to retrieve the result.
  router.post('/evolution-story', async (req, res) => {
    try {
      const { projectId, nodeId } = req.body;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required and must be a string' });
      }
      if (!nodeId || typeof nodeId !== 'string') {
        return res.status(400).json({ error: 'nodeId is required and must be a string' });
      }

      const taskId = wikiService.startEvolutionStoryGeneration(projectId, nodeId);
      if (taskId === null) {
        return res.json({
          status: 'already_running',
          projectId,
          nodeId,
          hint: 'Evolution story generation for this symbol is already in progress. Use GET /api/wiki/status to check progress.',
        });
      }
      res.json({
        status: 'processing',
        taskId,
        projectId,
        nodeId,
        hint: 'Evolution story generation started in background. Use GET /api/wiki/status to check progress, then GET /api/wiki/evolution-story/:topicId to retrieve the result.',
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/wiki/evolution-story/:topicId?projectId=xxx
  // P2-T5: Retrieve a stored evolution story topic by ID.
  //
  // Returns the WikiTopic with content (markdown narrative), title,
  // compiledAt, and topicType='evolution'. Returns 404 if the topic
  // does not exist or does not belong to the specified projectId.
  router.get('/evolution-story/:topicId', async (req, res) => {
    try {
      const { topicId } = req.params;
      const projectId = req.query.projectId as string | undefined;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: 'projectId query parameter is required' });
      }

      const topic = await wikiService.getTopic(projectId, topicId);
      if (!topic) {
        return res.status(404).json({ error: 'Evolution story not found' });
      }
      res.json(topic);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
