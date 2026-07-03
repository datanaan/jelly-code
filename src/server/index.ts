/**
 * jelly_code_project HTTP Server
 *
 * Provides both REST API and MCP endpoints.
 * Authentication is handled via middleware that adapts to
 * the configured deployment mode (jelly/standalone).
 */

import express from 'express';
import cors from 'cors';
import { loadConfig } from '../config/index.js';
import { createStoreSet } from '../store/factory.js';
import { createAuthProvider } from '../auth/factory.js';
import { createAuthMiddleware, createQuotaMiddleware } from '../auth/middleware.js';
import { runAnalyze } from '../core/run-analyze.js';
import { runIncrementalAnalyze } from '../core/run-incremental.js';
import { createTaskManager } from '../task/index.js';
import type { TaskManager } from '../task/index.js';
import { createMcpServer } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WikiService } from '../wiki/service.js';
import { RepoCacheManager } from '../core/repo-cache.js';
import { createWikiRoutes } from '../wiki/routes.js';
import { createBitemporalQueries } from '../store/neo4j/bitemporal-queries.js';
import { createCodeRoutes } from './code-routes.js';
import { IncrementalScheduler } from './scheduler.js';
import type { StoreSet } from '../store/interfaces.js';
import type { IAuthProvider } from '../store/interfaces.js';

const config = loadConfig();
const stores = createStoreSet(config);
const authProvider = createAuthProvider(config);
const authMiddleware = createAuthMiddleware(authProvider);
const quotaMiddleware = createQuotaMiddleware(authProvider);
const wikiService = new WikiService(stores, config.wiki);
const repoCache = new RepoCacheManager(config.repo);
const taskManager = createTaskManager();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ========================================
// Health check (no auth required)
// ========================================
app.get('/health', async (_req, res) => {
  let neo4jStatus = 'unknown';
  let constraintWarnings: string[] = [];

  try {
    // v0.1.1: Verify Neo4j constraints match expected state
    const constraintResult = await stores.graph.query(
      `SHOW CONSTRAINTS`,
    );
    const constraints = constraintResult as unknown as Array<Record<string, unknown>>;

    // Neo4j 5.x returns {name, type, entityType, labelsOrTypes, properties, status}
    // Neo4j 4.x returns different field names. Handle both.
    const isNeo4j5 = constraints.length > 0 && 'labelsOrTypes' in constraints[0];

    // Check for old-style id-only constraints that would break multi-tenant
    // NOTE: Project intentionally uses id-only uniqueness (global unique, no projectId)
    const oldConstraints = constraints.filter((c: Record<string, unknown>) => {
      if (isNeo4j5) {
        const labelsOrTypes = c.labelsOrTypes as string[] | undefined;
        // Skip Project — id-only constraint is intentional (global unique)
        if (labelsOrTypes?.includes('Project')) return false;
        return (
          String(c.type || '').includes('UNIQUE') &&
          String(c.properties || '') === 'id' &&
          !String(c.properties || '').includes('projectId')
        );
      }
      // Neo4j 4.x fallback — extract label from description like "FOR (n:Project) ..."
      const desc = String(c.description || '');
      // Skip Project — id-only constraint is intentional (global unique)
      if (desc.includes('Project')) return false;
      return desc.includes('UNIQUE') &&
        desc.includes('id') &&
        !desc.includes('projectId');
    });

    if (oldConstraints.length > 0) {
      neo4jStatus = 'degraded';
      constraintWarnings.push(
        `Found ${oldConstraints.length} old-style UNIQUE(id) constraints that conflict with multi-tenant isolation. ` +
        `Run initializeSchema() or restart the service.`
      );
    } else {
      neo4jStatus = 'ok';
    }
  } catch (e) {
    neo4jStatus = 'error';
    constraintWarnings.push(`Constraint check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  res.json({
    status: neo4jStatus === 'ok' ? 'ok' : 'degraded',
    mode: config.deployMode,
    version: '1.0.0',
    neo4j: {
      status: neo4jStatus,
      constraints: constraintWarnings.length === 0 ? 'valid' : constraintWarnings,
    },
  });
});

// Freshness consistency endpoint (no auth — for monitoring/ops)
app.get('/health/consistency', async (_req, res) => {
  try {
    const projects = await stores.graph.query(
      `MATCH (p:Project)
       RETURN p.id AS projectId,
              p.symbolsFreshness AS symbolsFreshness,
              p.communitiesFreshness AS communitiesFreshness,
              p.temporalFreshness AS temporalFreshness,
              p.lastFullRebuildAt AS lastFullRebuildAt,
              p.lastIncrementalAt AS lastIncrementalAt,
              p.lastIncrementalDuration AS lastIncrementalDuration,
              p.lastCommunityRebuildAt AS lastCommunityRebuildAt,
              p.consecutiveIncremental AS consecutiveIncremental,
              p.accumulatedChanges AS accumulatedChanges,
              p.fallbackCount AS fallbackCount,
              p.totalIncrementalAttempts AS totalIncrementalAttempts,
              p.lastFallbackReason AS lastFallbackReason,
              p.lastFallbackAt AS lastFallbackAt
       ORDER BY p.id`,
    );
    const now = Date.now();
    const projectList = (projects as Array<Record<string, unknown>>).map((p: Record<string, unknown>) => {
      const lfra = p.lastFullRebuildAt as string | undefined;
      const staleDays = lfra ? (now - new Date(lfra).getTime()) / 86400000 : undefined;
      return {
        projectId: p.projectId,
        symbolsFreshness: p.symbolsFreshness || 'unknown',
        communitiesFreshness: p.communitiesFreshness || 'unknown',
        temporalFreshness: p.temporalFreshness || 'unknown',
        lastFullRebuildAt: lfra || null,
        lastIncrementalAt: p.lastIncrementalAt || null,
        lastIncrementalDuration: p.lastIncrementalDuration || null,
        lastCommunityRebuildAt: p.lastCommunityRebuildAt || null,
        consecutiveIncremental: p.consecutiveIncremental || 0,
        accumulatedChanges: p.accumulatedChanges || 0,
        fallbackCount: p.fallbackCount || 0,
        totalIncrementalAttempts: p.totalIncrementalAttempts || 0,
        fallbackRate: (p.totalIncrementalAttempts as number) > 0
          ? Math.round(((p.fallbackCount as number || 0) / (p.totalIncrementalAttempts as number)) * 1000) / 10
          : 0,
        lastFallbackReason: p.lastFallbackReason || null,
        lastFallbackAt: p.lastFallbackAt || null,
        staleDays: staleDays !== undefined ? Math.round(staleDays * 10) / 10 : null,
      };
    });

    res.json({ projects: projectList });
  } catch (error) {
    res.status(500).json({ error: 'Consistency check failed', detail: error instanceof Error ? error.message : String(error) });
  }
});

// ========================================
// Authenticated API routes
// ========================================
app.use('/api/*', authMiddleware, quotaMiddleware);

app.post('/api/analyze', async (req, res) => {
  try {
    const { gitUrl, projectId, repoPath } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    if (!gitUrl && !repoPath) {
      return res.status(400).json({ error: 'gitUrl or repoPath is required' });
    }

    // Dedup check
    const currentState = taskManager.getState(projectId);
    if (currentState?.status === 'analyzing' || currentState?.status === 'queued') {
      return res.json({
        status: currentState.status,
        projectId,
        position: currentState.pendingRequests.length + 1,
        hint: `Project is already ${currentState.status}.`,
      });
    }

    // Submit to TaskManager
    await taskManager.requestAnalyze(projectId, { repoPath, gitUrl });

    setImmediate(async () => {
      taskManager.markAnalyzing(projectId);
      try {
        console.log(`[api:analyze] Starting analysis: projectId=${projectId}`);
        await runAnalyze(
          repoPath || '',
          projectId,
          stores,
          {
            gitUrl: gitUrl || undefined,
            repoCache,
            onProgress: (phase, percent) => {
              taskManager.updateProgress(projectId, { phase, percent });
            },
          },
        );
        taskManager.markReady(projectId);
        console.log(`[api:analyze] Analysis completed: ${projectId}`);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[api:analyze] Analysis FAILED for ${projectId}: ${msg}`);
        taskManager.markError(projectId, msg);
      }
    });

    res.json({ status: 'queued', projectId, hint: 'Use /api/status/:projectId to check progress.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/incremental-analyze', async (req, res) => {
  try {
    const { projectId } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    setImmediate(async () => {
      try {
        console.log(`[api:incremental-analyze] Starting: projectId=${projectId}`);
        const result = await runIncrementalAnalyze(projectId, stores, repoCache);
        console.log(`[api:incremental-analyze] Completed: ${projectId} — mode=${result.mode}`);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[api:incremental-analyze] FAILED for ${projectId}: ${msg}`);
      }
    });

    res.json({ status: 'started', projectId });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/projects', async (_req, res) => {
  try {
    const projects = await stores.graph.listProjects();
    res.json({ projects });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    await stores.graph.clearProject(projectId);
    await stores.search.deleteCollection(projectId);
    await stores.vector.deleteCollection(projectId);
    res.json({ status: 'deleted', projectId });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/status/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    const taskState = taskManager.getState(projectId);

    const result = await stores.graph.query(
      'MATCH (p:Project {id: $projectId}) RETURN p',
      { projectId },
    );
    const project = result[0] as Record<string, unknown> | undefined;
    const projectData = project?.p as Record<string, unknown> | undefined;

    if (!projectData && !taskState) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const response: Record<string, unknown> = {
      projectId,
      ...projectData,
    };

    if (taskState) {
      response.status = taskState.status;
      response.startedAt = taskState.startedAt?.toISOString();
      response.progress = taskState.progress;
      response.error = taskState.error;
    } else {
      response.status = 'indexed';
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// Wiki API routes (authenticated)
// ========================================
app.use('/api/wiki', createWikiRoutes(wikiService));

// ========================================
// Code API routes (authenticated)
// P1-T6: Bi-temporal code queries (as-of, diff)
// ========================================
const bitemporalQueries = createBitemporalQueries(stores.graph);
app.use('/api/code', createCodeRoutes(bitemporalQueries));

// ========================================
// MCP Streamable HTTP endpoint (stateless)
// ========================================
// Uses the SDK's stateless pattern: new McpServer + transport per request.
// This avoids the "connect() can only be called once" limitation.

// Accept header patch for MCP POST requests (no auth — GET health check needs public access)
// Claude Code's HTTP client only sends `Accept: application/json`, but the
// MCP spec requires `text/event-stream` as well.  The SDK's StreamableHTTP
// transport uses @hono/node-server which reads from req.rawHeaders (the raw
// array), NOT req.headers (the normalized object).  We must patch both.
app.use('/mcp', (req, _res, next) => {
  if (req.method === 'POST') {
    const accept = (req.headers['accept'] as string) || '';
    if (!accept.includes('text/event-stream') || !accept.includes('application/json')) {
      const fixed = [
        accept,
        accept.includes('application/json') ? '' : 'application/json',
        accept.includes('text/event-stream') ? '' : 'text/event-stream',
      ].filter(Boolean).join(', ');

      // Patch normalized object
      req.headers['accept'] = fixed;
      req.headers.accept = fixed;

      // Patch rawHeaders array (what @hono/node-server reads)
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i].toLowerCase() === 'accept') {
          raw[i + 1] = fixed;
          return next();
        }
      }
      // Accept header not in rawHeaders at all — append it
      raw.push('accept', fixed);
    }
  }
  next();
});

app.post('/mcp', authMiddleware, async (req, res) => {
  const server = createMcpServer(stores, { wikiService, repoCache, taskManager });
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] Error handling MCP request:', error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// ========================================
// Webhook endpoint for git push events (optional, requires WEBHOOK_SECRET)
// ========================================
app.post('/api/webhook/git-push', authMiddleware, async (req, res) => {
  try {
    const { repository, ref } = req.body;
    if (!repository) {
      return res.status(400).json({ error: 'Missing repository info' });
    }

    const gitUrl = repository.git_url || repository.ssh_url || repository.clone_url;
    if (!gitUrl) {
      return res.status(400).json({ error: 'Missing gitUrl in repository info' });
    }

    // Find matching project by gitUrl
    const projects = await stores.graph.query(
      'MATCH (p:Project) WHERE p.gitUrl CONTAINS $url RETURN p.id AS id',
      { url: gitUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '') },
    );

    if ((projects as Array<Record<string, unknown>>).length === 0) {
      return res.status(404).json({ error: 'No matching project found' });
    }

    // Trigger incremental analysis (fire-and-forget)
    const triggered: string[] = [];
    for (const p of projects as Array<Record<string, unknown>>) {
      const projectId = p.id as string;
      setImmediate(async () => {
        try {
          const result = await runIncrementalAnalyze(projectId, stores, repoCache);
          console.log(`[webhook] ${projectId}: ${result.mode}, ${result.nodeCount} nodes`);
        } catch (err) {
          console.error(`[webhook] ${projectId}: FAILED: ${err instanceof Error ? err.message : err}`);
        }
      });
      triggered.push(projectId);
    }

    res.json({ triggered, count: triggered.length, ref: ref || 'unknown' });
  } catch (error) {
    res.status(500).json({ error: 'Webhook handler failed', detail: error instanceof Error ? error.message : String(error) });
  }
});

// Handle GET for SSE streams (optional, for streaming responses)
app.get('/mcp', async (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

// Handle DELETE for session termination
app.delete('/mcp', async (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

// ========================================
// Start server
// ========================================
async function startServer() {
  // Initialize Neo4j schema
  try {
    await stores.graph.initializeSchema();
    console.log('[server] Neo4j schema initialized');
  } catch (error) {
    console.warn('[server] Neo4j schema init failed (will retry on next request):', error);
  }

  // Start auto-refresh scheduler (disabled by default: AUTO_REFRESH_INTERVAL_MINUTES=0)
  const AUTO_REFRESH_INTERVAL = parseInt(process.env.AUTO_REFRESH_INTERVAL_MINUTES || '0', 10);
  if (AUTO_REFRESH_INTERVAL > 0) {
    const scheduler = new IncrementalScheduler(stores, repoCache, taskManager, wikiService);
    scheduler.start(AUTO_REFRESH_INTERVAL);
    // Register weekly archive job for old bi-temporal edges
    scheduler.startArchiveJob(config.bitemporal.retentionDays);
    // Register monthly evolution story batch job
    scheduler.startEvolutionBatchJob();
    console.log(`[server] Auto-refresh enabled: every ${AUTO_REFRESH_INTERVAL} minutes`);
  } else {
    console.log('[server] Auto-refresh disabled (AUTO_REFRESH_INTERVAL_MINUTES=0)');
  }

  const server = app.listen(config.port, () => {
    console.log(
      `[server] jelly_code_project running on port ${config.port} (${config.deployMode} mode)`,
    );
    console.log(`[server] REST API: http://localhost:${config.port}/api`);
    console.log(`[server] MCP endpoint: http://localhost:${config.port}/mcp`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] Port ${config.port} is already in use. Exiting.`);
      process.exit(1);
    } else {
      throw error;
    }
  });
}

startServer().catch(console.error);

// Export for testing
export { app, stores, authProvider, wikiService };
