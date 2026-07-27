/**
 * jelly_code_project HTTP Server
 *
 * Provides both REST API and MCP endpoints.
 * Authentication is handled via middleware that adapts to
 * the configured deployment mode (jelly/standalone).
 */

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { loadConfig } from '../config/index.js';
import { createStoreSet } from '../store/factory.js';
import { createAuthProvider } from '../auth/factory.js';
import { createAuthMiddleware, createQuotaMiddleware } from '../auth/middleware.js';
import { validateRepoPath } from '../core/run-analyze.js';

// Read version from package.json at build time
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
const APP_VERSION: string = pkg.version;
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
import { logger } from '../core/logger.js';
import { analyzeQueue, cleanupQueue, closeQueues, closeResilienceQueues } from '../core/queue-setup.js';
import { closeRedisConnection } from '../core/redis-connection.js';
import rateLimit from 'express-rate-limit';
import { metricsHandler } from '../core/metrics.js';
import { createHealthRouter } from './health-routes.js';
import { LLMService } from '../llm/llm-service.js';
import path from 'path';

const config = loadConfig();
const stores = createStoreSet(config);
const authProvider = createAuthProvider(config);
const authMiddleware = createAuthMiddleware(authProvider);
const quotaMiddleware = createQuotaMiddleware(authProvider);
const wikiService = new WikiService(stores, config.wiki);
const repoCache = new RepoCacheManager(config.repo);
const taskManager = createTaskManager();

const app = express();
// CORS whitelist: allow specific origins, default to localhost for dev
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn({ origin }, 'CORS blocked request from unauthorized origin');
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Global rate limit: 100 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GLOBAL || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — rate limit exceeded' },
});
app.use(globalLimiter);
app.use(express.json({ limit: '10mb' }));

// ========================================
// Health check (no auth required)
// Checks all three backends: Neo4j, Typesense, Qdrant
// Returns HTTP 200 if all healthy, 503 if any backend is down
// ========================================
// Prometheus metrics endpoint (no auth required, no rate limit)
app.get('/metrics', metricsHandler);

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

  // Check Typesense health
  let tsStatus = 'unknown';
  try {
    if (stores.search.healthCheck) {
      tsStatus = (await stores.search.healthCheck()) ? 'ok' : 'error';
    } else {
      tsStatus = 'unknown';
    }
  } catch (e) {
    tsStatus = 'error';
  }

  // Check Qdrant health
  let qdStatus = 'unknown';
  try {
    if (stores.vector.healthCheck) {
      qdStatus = (await stores.vector.healthCheck()) ? 'ok' : 'error';
    } else {
      qdStatus = 'unknown';
    }
  } catch (e) {
    qdStatus = 'error';
  }

  // m2: 'unknown' status counts as degraded — triggers 503 so monitoring knows
  // a backend exists but hasn't been verified. All three must be 'ok' for 200.
  const allOk = neo4jStatus === 'ok' && tsStatus === 'ok' && qdStatus === 'ok';
  const anyError = neo4jStatus === 'error' || tsStatus === 'error' || qdStatus === 'error';
  const anyUnknown = neo4jStatus === 'unknown' || tsStatus === 'unknown' || qdStatus === 'unknown';
  const overallStatus = allOk ? 'ok' : 'degraded';
  const httpStatus = allOk ? 200 : 503;

  if (anyError || anyUnknown) {
    logger.warn({ neo4j: neo4jStatus, typesense: tsStatus, qdrant: qdStatus }, 'Health check: backend degraded');
  }

  res.status(httpStatus).json({
    status: overallStatus,
    mode: config.deployMode,
    version: APP_VERSION,
    neo4j: {
      status: neo4jStatus,
      constraints: constraintWarnings.length === 0 ? 'valid' : constraintWarnings,
    },
    typesense: { status: tsStatus },
    qdrant: { status: qdStatus },
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
// v1.4.0 Resilience layer health endpoints
// Mounted before auth so k8s/docker probes can reach them.
// ========================================
const llmService = stores.llm instanceof LLMService ? stores.llm as LLMService : undefined;
app.use(createHealthRouter({ llmService }));

// ========================================
// Authenticated API routes
// ========================================
app.use('/api/*', authMiddleware, quotaMiddleware);

// Analyze-specific rate limit: 10 requests per minute
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_ANALYZE || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many analysis requests — limit is 10 per minute' },
});

app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { gitUrl, projectId, repoPath } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    if (!gitUrl && !repoPath) {
      return res.status(400).json({ error: 'gitUrl or repoPath is required' });
    }

    // Path traversal protection: validate repoPath if provided
    if (repoPath) {
      try {
        validateRepoPath(repoPath);
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid repoPath' });
      }
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

    // Submit to BullMQ queue (persistent, with retry and timeout)
    // M3: REST now uses analyzeQueue (same path as MCP analyze_repo)
    await analyzeQueue.add('analyze', {
      projectId,
      gitUrl: gitUrl || undefined,
      repoPath: repoPath || undefined,
      canAutoIncremental: false,
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

    // Enqueue incremental analysis via BullMQ (consistent with MCP path)
    await analyzeQueue.add('analyze', {
      projectId,
      canAutoIncremental: true,
    });

    res.json({ status: 'queued', projectId, hint: 'Incremental analysis queued. Use /api/status/:projectId to check.' });
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

    // Mark project as deleting in Neo4j (lightweight, always succeeds)
    try {
      await stores.graph.query(
        'MATCH (p:Project {id: $id}) SET p.status = "deleting"',
        { id: projectId },
      );
      logger.info({ projectId }, 'Project marked as deleting');
    } catch (e) {
      // Project may not exist — non-fatal
      logger.warn({ projectId, error: e instanceof Error ? e.message : String(e) },
        'Project mark as deleting failed');
    }

    // Enqueue cleanup job (async: Neo4j + Typesense + Qdrant)
    await cleanupQueue.add('cleanup', { projectId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    logger.info({ projectId }, 'Cleanup job queued');

    res.json({ status: 'deleting', projectId, hint: 'Cleanup is running in the background.' });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) },
      'Project deletion queuing failed');
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
    logger.error({ error: error instanceof Error ? error.message : String(error) },
      'MCP request handling failed');

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

    // Trigger incremental analysis via BullMQ queue (consistent with MCP path)
    const triggered: string[] = [];
    for (const p of projects as Array<Record<string, unknown>>) {
      const projectId = p.id as string;
      await analyzeQueue.add('analyze', {
        projectId,
        canAutoIncremental: true,
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
    logger.info('Neo4j schema initialized');
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) },
      'Neo4j schema init failed (will retry on next request)');
  }

  // Start BullMQ workers in-process
  // 1. analysis-worker — processes 'analyze' queue jobs
  // 2. search-sync-worker — async TS/QD index sync after analysis
  // 3. cleanup-worker — project deletion and stale node cleanup
  // 4. llm-worker — v1.4.0: consumes llm-derivation + llm-enrichment queues
  const repoCacheForWorkers = repoCache;
  const { createAnalysisWorker } = await import('../worker/analysis-worker.js');
  const { createSearchSyncWorker } = await import('../worker/search-sync-worker.js');
  const { createCleanupWorker } = await import('../worker/cleanup-worker.js');
  const { createLLMWorker } = await import('../worker/llm-worker.js');
  const { loadRules } = await import('../wiki/derivation-rules.js');

  const analysisWorker = createAnalysisWorker(stores, repoCacheForWorkers, taskManager, wikiService);
  const searchSyncWorker = createSearchSyncWorker(stores);
  const cleanupWorker = createCleanupWorker(stores);

  // Start llm-worker with default derivation rules (enabled unless user config says otherwise).
  // Rules are loaded from the built-in default; per-project overrides are resolved at dispatch time.
  const defaultRulesPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'derivation-rules.json',
  );
  let llmRules: import('../wiki/derivation-rules.js').DerivationRules = { enabled: true, rules: [], maxEntitiesPerProject: 100 };
  try {
    llmRules = loadRules(defaultRulesPath);
  } catch {
    logger.warn({ path: defaultRulesPath }, 'Failed to load default derivation rules, using minimal defaults');
  }
  const llmWorkers = createLLMWorker({
    stores, wikiService, pool: stores.llm, rules: llmRules,
  });
  const [llmDerivationWorker, llmEnrichmentWorker] = llmWorkers;

  logger.info('BullMQ workers started: analysis, search-sync, cleanup, llm');

  // Start auto-refresh scheduler (disabled by default: AUTO_REFRESH_INTERVAL_MINUTES=0)
  const AUTO_REFRESH_INTERVAL = parseInt(process.env.AUTO_REFRESH_INTERVAL_MINUTES || '0', 10);
  if (AUTO_REFRESH_INTERVAL > 0) {
    const scheduler = new IncrementalScheduler(stores, repoCache, taskManager, wikiService);
    scheduler.start(AUTO_REFRESH_INTERVAL);
    // Register weekly archive job for old bi-temporal edges
    scheduler.startArchiveJob(config.bitemporal.retentionDays);
    // Register monthly evolution story batch job
    scheduler.startEvolutionBatchJob();
    logger.info({ interval: AUTO_REFRESH_INTERVAL }, 'Auto-refresh enabled');
  } else {
    logger.info('Auto-refresh disabled (AUTO_REFRESH_INTERVAL_MINUTES=0)');
  }

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, mode: config.deployMode },
      `jelly_code_project running on port ${config.port} (${config.deployMode} mode)`,
    );
    logger.info({ port: config.port }, `REST API: http://localhost:${config.port}/api`);
    logger.info({ port: config.port }, `MCP endpoint: http://localhost:${config.port}/mcp`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error({ port: config.port }, 'Port already in use. Exiting.');
      process.exit(1);
    } else {
      throw error;
    }
  });

  // Graceful shutdown: close workers, queues, Redis
  // v1.4.0: also close resilience-layer queues (llm-derivation, llm-enrichment, embedding-batch).
  //         Resilience workers (llmDerivationWorker etc.) will be added by Task 10-12;
  //         until then they are undefined and skipped via optional chaining.
  const shutdown = async (signal?: string) => {
    logger.info({ signal }, 'Shutdown received, draining workers');
    // 1. Stop accepting new HTTP requests
    server.close();
    // 2. Close BullMQ workers (stop pulling new jobs, wait for in-flight)
    await Promise.allSettled([
      analysisWorker.close(),
      searchSyncWorker.close(),
      cleanupWorker.close(),
      llmDerivationWorker.close(),
      llmEnrichmentWorker.close(),
    ]);
    // 3. Close resilience-layer queues
    await closeResilienceQueues();
    // 4. Close core queues + stores + Redis
    await Promise.allSettled([
      closeQueues(),
      closeRedisConnection(),
    ]);
    await stores.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Server startup failed');
  process.exit(1);
});

// Export for testing
export { app, stores, authProvider, wikiService };
