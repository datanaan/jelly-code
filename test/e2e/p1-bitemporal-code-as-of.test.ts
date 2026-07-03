/**
 * E2E Test: P1 Bi-temporal Upgrade + code_as_of Time Travel
 *
 * Validates the bi-temporal time-travel flow end-to-end against a real
 * Neo4j database. Instead of running runAnalyze (which needs LLM),
 * we create CodeNodes + CODE_RELATION edges directly in Neo4j with
 * bi-temporal attributes, isolating the bi-temporal query logic.
 *
 * Test scenarios (10 tests, 20+ assertions):
 *
 *  1. Create nodes + bi-temporal relation — verify properties persisted
 *  2. findNodeAsOf(T_current) returns current state
 *  3. findNodeAsOf(T_past) returns historical state (time range filtering)
 *  4. supersedeRelation closes old, opens new
 *  5. Time travel after supersede: before vs after
 *  6. Backward compat with legacy edges (no bi-temporal attrs)
 *  7. NL time parser: "3 days ago" → ISO timestamp
 *  8. HTTP GET /api/code/as-of returns { node, relations } / 404
 *  9. HTTP rejects missing params (400)
 * 10. findChangesBetween range query
 *
 * Approach:
 * - Real Neo4j (required for bi-temporal Cypher queries)
 * - No LLM / no runAnalyze — direct Cypher for node/edge creation
 * - Express + supertest for HTTP API tests
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p1-bitemporal-code-as-of.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { IGraphStore, CodeNode } from '../../src/store/interfaces.js';
import {
  createBitemporalQueries,
} from '../../src/store/neo4j/bitemporal-queries.js';
import {
  supersedeRelation as supersedeRelationModel,
  EPOCH,
  FAR_FUTURE,
} from '../../src/store/bitemporal-model.js';
import { parseNaturalLanguageTime } from '../../src/store/nl-time-parser.js';
import { createCodeRoutes } from '../../src/server/code-routes.js';
import express from 'express';
import request from 'supertest';

// ─── E2E gate ───────────────────────────────────────────────────────────────
const RUN_E2E = process.env.RUN_E2E === '1' || process.env.RUN_E2E === 'true';
const skipE2E = !RUN_E2E;

// ─── Test suite ─────────────────────────────────────────────────────────────

describe.skipIf(skipE2E)('P1 E2E: Bi-temporal Upgrade + code_as_of Time Travel', () => {
  let graphStore: IGraphStore;
  const projectId = `e2e-p1-${Date.now()}`;

  // Node IDs
  const funcANodeId = `${projectId}:Function:funcA`;
  const funcBNodeId = `${projectId}:Function:funcB`;
  const funcCNodeId = `${projectId}:Function:funcC`;
  const legacyNodeId = `${projectId}:Function:legacyFunc`;

  // Time constants for bi-temporal fixtures
  const T1 = '2026-01-01T00:00:00Z'; // Early time
  const T1_5 = '2026-03-01T12:00:00Z'; // Between T1 and T2
  const T2 = '2026-06-01T00:00:00Z'; // Cutoff time
  const T3 = '2026-09-01T00:00:00Z'; // After T2 (relation superseded)
  const T_NOW = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // Current time

  beforeAll(async () => {
    const config = loadConfig();
    graphStore = new Neo4jAdapter(config.neo4j);

    // Initialize schema (constraints + indexes)
    await graphStore.initializeSchema();

    // Clean up any leftover data
    await graphStore.clearProject(projectId);

    // ── Create Project node (required for relation integrity) ─────────
    await graphStore.batchCreateNodes([
      {
        id: projectId,
        type: 'Project',
        projectId,
        name: projectId,
      },
    ]);

    // ── Create CodeNodes ──────────────────────────────────────────────
    const nodes: CodeNode[] = [
      {
        id: funcANodeId,
        type: 'Function',
        projectId,
        name: 'funcA',
        filePath: 'src/funcA.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
        content: 'export function funcA() { return funcB(); }',
      },
      {
        id: funcBNodeId,
        type: 'Function',
        projectId,
        name: 'funcB',
        filePath: 'src/funcB.ts',
        startLine: 1,
        endLine: 3,
        isExported: true,
        content: 'export function funcB() { return 42; }',
      },
      {
        id: funcCNodeId,
        type: 'Function',
        projectId,
        name: 'funcC',
        filePath: 'src/funcC.ts',
        startLine: 1,
        endLine: 3,
        isExported: true,
        content: 'export function funcC() { return "hello"; }',
      },
      {
        id: legacyNodeId,
        type: 'Function',
        projectId,
        name: 'legacyFunc',
        filePath: 'src/legacy.ts',
        startLine: 1,
        endLine: 3,
        content: 'function legacyFunc() {}',
      },
    ];
    await graphStore.batchCreateNodes(nodes);
  }, 30_000);

  afterAll(async () => {
    try {
      await graphStore.clearProject(projectId);
    } catch {
      // Ignore cleanup errors
    }
    await graphStore.close();
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────
  // 1. Create bi-temporal relation — verify properties persisted
  // ─────────────────────────────────────────────────────────────────────

  it('bi-temporal relation properties persisted in Neo4j', async () => {
    // Create a CALLS relation with explicit bi-temporal attributes
    await graphStore.query(
      `MATCH (a {id: $sourceId, projectId: $projectId})
       MATCH (b {id: $targetId, projectId: $projectId})
       CREATE (a)-[r:CODE_RELATION {
         sourceId: $sourceId,
         targetId: $targetId,
         type: 'CALLS',
         confidence: 0.95,
         reason: 'funcA calls funcB',
         valid_from: $validFrom,
         valid_to: $validTo,
         txn_from: $txnFrom,
         txn_to: $txnTo
       }]->(b)`,
      {
        projectId,
        sourceId: funcANodeId,
        targetId: funcBNodeId,
        validFrom: T1,
        validTo: null, // Currently valid
        txnFrom: T1,
        txnTo: null,
      },
    );

    // Query back and verify
    const results = await graphStore.query(
      `MATCH ()-[r:CODE_RELATION {sourceId: $sourceId, targetId: $targetId, type: 'CALLS'}]->()
       RETURN r.valid_from AS vf, r.valid_to AS vt, r.txn_from AS tf, r.txn_to AS tt,
              r.confidence AS conf, r.reason AS reason`,
      { sourceId: funcANodeId, targetId: funcBNodeId },
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const row = results[0];
    expect(row.vf).toBe(T1);
    expect(row.vt).toBeNull(); // Currently valid
    expect(row.tf).toBe(T1);
    expect(row.tt).toBeNull();
    expect(row.conf).toBe(0.95);
    expect(row.reason).toBe('funcA calls funcB');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. findNodeAsOf(T_current) returns current state
  // ─────────────────────────────────────────────────────────────────────

  it('findNodeAsOf returns node + active relations at current time', async () => {
    const queries = createBitemporalQueries(graphStore);
    const result = await queries.findNodeAsOf(projectId, funcANodeId, T_NOW);

    expect(result.node).not.toBeNull();
    expect(result.node!.id).toBe(funcANodeId);
    expect(result.node!.name).toBe('funcA');

    // The CALLS relation should be present (valid_to IS NULL → currently valid)
    const callsRel = result.relations.find(r => r.type === 'CALLS');
    expect(callsRel).toBeDefined();
    expect(callsRel!.sourceId).toBe(funcANodeId);
    expect(callsRel!.targetId).toBe(funcBNodeId);
    expect(callsRel!.valid_from).toBe(T1);
    expect(callsRel!.valid_to).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. findNodeAsOf(T_past) returns historical state (time range filtering)
  // ─────────────────────────────────────────────────────────────────────

  it('findNodeAsOf filters relations by valid_time window', async () => {
    // Create a temporary relation with a bounded valid_time [T1, T2]
    await graphStore.query(
      `MATCH (a {id: $sourceId, projectId: $projectId})
       MATCH (b {id: $targetId, projectId: $projectId})
       CREATE (a)-[r:CODE_RELATION {
         sourceId: $sourceId,
         targetId: $targetId,
         type: 'CALLS_C',
         confidence: 1.0,
         valid_from: $validFrom,
         valid_to: $validTo,
         txn_from: $txnFrom,
         txn_to: null
       }]->(b)`,
      {
        projectId,
        sourceId: funcANodeId,
        targetId: funcCNodeId,
        validFrom: T1,
        validTo: T2, // Bounded — expired at T2
        txnFrom: T1,
      },
    );

    const queries = createBitemporalQueries(graphStore);

    // Query at T1.5 → relation should be included (T1 <= T1.5 < T2)
    const midResult = await queries.findNodeAsOf(projectId, funcANodeId, T1_5);
    const midCallsC = midResult.relations.find(r => r.type === 'CALLS_C');
    expect(midCallsC).toBeDefined();
    expect(midCallsC!.valid_from).toBe(T1);
    expect(midCallsC!.valid_to).toBe(T2);

    // Query at T3 → relation should be excluded (T3 >= T2)
    const afterResult = await queries.findNodeAsOf(projectId, funcANodeId, T3);
    const afterCallsC = afterResult.relations.find(r => r.type === 'CALLS_C');
    expect(afterCallsC).toBeUndefined();

    // The original CALLS relation (valid_to IS NULL) should still be present at T3
    const afterCalls = afterResult.relations.find(r => r.type === 'CALLS');
    expect(afterCalls).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. supersedeRelation closes old, opens new
  // ─────────────────────────────────────────────────────────────────────

  it('supersedeRelation atomically closes old + creates new', async () => {
    // First, verify the old CALLS relation exists and is currently valid
    const beforeRels = await graphStore.query(
      `MATCH ()-[r:CODE_RELATION {sourceId: $src, targetId: $tgt, type: 'CALLS'}]->()
       WHERE r.valid_to IS NULL
       RETURN count(r) AS count`,
      { src: funcANodeId, tgt: funcBNodeId },
    );
    // Neo4j count() returns Integer object — convert to number
    const beforeCount = Number(beforeRels[0].count);
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    // Use the model-level supersedeRelation to compute the new attrs
    const oldRel = {
      valid_from: T1,
      valid_to: null,
      txn_from: T1,
      txn_to: null,
    };
    const supersedeTime = T3;
    const { old, next } = supersedeRelationModel(oldRel, supersedeTime, T_NOW);

    // Verify the model computed correct attributes
    expect(old.valid_to).toBe(T3);
    expect(old.txn_to).toBe(T_NOW);
    expect(next.valid_from).toBe(T3);
    expect(next.valid_to).toBeNull();
    expect(next.txn_from).toBe(T_NOW);
    expect(next.txn_to).toBeNull();

    // Execute the supersede at the store level
    const queries = createBitemporalQueries(graphStore);
    const result = await queries.supersedeRelation(
      projectId,
      `${funcANodeId}-CALLS-${funcBNodeId}`,
      supersedeTime,
      {
        sourceId: funcANodeId,
        targetId: funcBNodeId,
        type: 'CALLS',
        ...next,
      },
      T_NOW,
    );

    expect(result.superseded).toBe(true);

    // Verify old relation now has valid_to set
    const oldRels = await graphStore.query(
      `MATCH ()-[r:CODE_RELATION {sourceId: $src, targetId: $tgt, type: 'CALLS'}]->()
       WHERE r.valid_to IS NOT NULL
       RETURN r.valid_from AS vf, r.valid_to AS vt, r.txn_from AS tf, r.txn_to AS tt`,
      { src: funcANodeId, tgt: funcBNodeId },
    );
    expect(oldRels.length).toBeGreaterThanOrEqual(1);
    const closedRel = oldRels[0];
    expect(closedRel.vt).toBe(T3);
    expect(closedRel.tt).toBe(T_NOW);

    // Verify new relation exists with valid_from = T3
    const newRels = await graphStore.query(
      `MATCH ()-[r:CODE_RELATION {sourceId: $src, targetId: $tgt, type: 'CALLS'}]->()
       WHERE r.valid_to IS NULL AND r.valid_from = $vf
       RETURN r.valid_from AS vf, r.valid_to AS vt`,
      { src: funcANodeId, tgt: funcBNodeId, vf: T3 },
    );
    expect(newRels.length).toBeGreaterThanOrEqual(1);
    expect(newRels[0].vf).toBe(T3);
    expect(newRels[0].vt).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Time travel after supersede: before vs after
  // ─────────────────────────────────────────────────────────────────────

  it('findNodeAsOf shows old structure before supersede, new after', async () => {
    const queries = createBitemporalQueries(graphStore);

    // Query at T1_5 (before supersede at T3)
    const beforeResult = await queries.findNodeAsOf(projectId, funcANodeId, T1_5);
    const beforeCalls = beforeResult.relations.filter(r => r.type === 'CALLS');
    // Should have exactly the old CALLS relation (valid_from=T1, valid_to=T3)
    const oldCalls = beforeCalls.find(r => r.valid_from === T1);
    expect(oldCalls).toBeDefined();
    expect(oldCalls!.valid_to).toBe(T3); // Closed at T3

    // Query at T3 (at supersede time — new relation valid_from = T3)
    const afterResult = await queries.findNodeAsOf(projectId, funcANodeId, T3);
    const afterCalls = afterResult.relations.filter(r => r.type === 'CALLS');
    // Should have the new CALLS relation (valid_from=T3, valid_to=NULL)
    const newCalls = afterCalls.find(r => r.valid_from === T3);
    expect(newCalls).toBeDefined();
    expect(newCalls!.valid_to).toBeNull();

    // The old CALLS (valid_to=T3) should NOT be returned at T3 because
    // coalesce(valid_to, FAR_FUTURE) > T3 → T3 > T3 is false
    const oldAtT3 = afterCalls.find(r => r.valid_from === T1 && r.valid_to === T3);
    expect(oldAtT3).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Backward compat with legacy edges (no bi-temporal attrs)
  // ─────────────────────────────────────────────────────────────────────

  it('findNodeAsOf returns legacy edges without bi-temporal attrs', async () => {
    // Create a legacy edge with NO valid_from/valid_to/txn_from/txn_to
    // (properties entirely absent, not just NULL)
    await graphStore.query(
      `MATCH (a {id: $sourceId, projectId: $projectId})
       MATCH (b {id: $targetId, projectId: $projectId})
       CREATE (a)-[r:CODE_RELATION {
         sourceId: $sourceId,
         targetId: $targetId,
         type: 'CALLS',
         confidence: 1.0
       }]->(b)`,
      {
        projectId,
        sourceId: legacyNodeId,
        targetId: funcBNodeId,
      },
    );

    // Verify the edge truly has NO bi-temporal properties.
    // In Neo4j, absent properties return as null (not undefined) when
    // accessed via Cypher RETURN. The key test is that findNodeAsOf
    // still returns the edge via coalesce().
    const verifyNoAttrs = await graphStore.query(
      `MATCH ()-[r:CODE_RELATION {sourceId: $src, targetId: $tgt}]->()
       RETURN r.valid_from AS vf, r.valid_to AS vt, r.txn_from AS tf, r.txn_to AS tt`,
      { src: legacyNodeId, tgt: funcBNodeId },
    );
    // Properties are absent — Neo4j returns null for missing properties
    expect(verifyNoAttrs[0].vf).toBeNull();
    expect(verifyNoAttrs[0].vt).toBeNull();
    expect(verifyNoAttrs[0].tf).toBeNull();
    expect(verifyNoAttrs[0].tt).toBeNull();

    // findNodeAsOf should still return this edge via coalesce(EPOCH/FAR_FUTURE)
    const queries = createBitemporalQueries(graphStore);
    const result = await queries.findNodeAsOf(projectId, legacyNodeId, T_NOW);

    expect(result.node).not.toBeNull();
    const callsRel = result.relations.find(r => r.type === 'CALLS');
    expect(callsRel).toBeDefined();

    // Legacy edge should be coalesced to always-valid
    // valid_from defaults to EPOCH, valid_to defaults to null
    expect(callsRel!.valid_from).toBe(EPOCH);
    expect(callsRel!.valid_to).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. NL time parser: "3 days ago" → ISO timestamp
  // ─────────────────────────────────────────────────────────────────────

  it('parseNaturalLanguageTime converts "3 days ago" to ~3 days ago ISO', async () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const parsed = parseNaturalLanguageTime('3 days ago', now);

    // Should be ~3 days before now
    const expected = '2026-06-12T12:00:00Z';
    expect(parsed).toBe(expected);

    // Verify it's a valid ISO 8601 timestamp
    const parsedDate = new Date(parsed);
    expect(parsedDate.getTime()).not.toBeNaN();

    // Difference should be exactly 3 days (259200000 ms)
    const diffMs = now.getTime() - parsedDate.getTime();
    expect(diffMs).toBe(3 * 24 * 60 * 60 * 1000);

    // Use the parsed time to query findNodeAsOf
    // T_NOW is after T3 (supersede), so "3 days ago" should still
    // be within the valid range of the new CALLS edge (valid_from=T3)
    // T3 = 2026-09-01, and "3 days ago" from now (2026-06-22) = ~2026-06-19
    // This is BEFORE T3, so the new edge should NOT appear, old edge SHOULD (if not closed)
    // Actually the old edge (valid_to=T3) would be valid at 2026-06-19 since
    // T1 <= 2026-06-19 < T3
    const queries = createBitemporalQueries(graphStore);
    const result = await queries.findNodeAsOf(projectId, funcANodeId, parsed);
    const callsRels = result.relations.filter(r => r.type === 'CALLS');

    // At ~3 days ago (before T3 supersede), the old CALLS edge should be valid
    // But wait — we need to think about what edges exist for funcANodeId → funcBNodeId:
    // 1. Original: valid_from=T1, valid_to=T3 (closed)
    // 2. New: valid_from=T3, valid_to=NULL
    // At ~2026-06-19: T1 <= 2026-06-19 < T3 → original edge is valid
    //                 2026-06-19 < T3 → new edge is NOT valid yet
    // However, since the dates are: T3 = 2026-09-01 and "now" ~ 2026-06-22,
    // 3 days ago = ~2026-06-19, which is before T3.
    // So the original CALLS (valid_from=T1, valid_to=T3) should be returned.
    const oldCallAtParsed = callsRels.find(r => r.valid_from === T1);
    // This edge has valid_to=T3, and coalesce(T3, FAR_FUTURE) > parsed → T3 > parsed
    // parsed ≈ 2026-06-19 < T3 (2026-09-01) → true, so it IS included
    expect(oldCallAtParsed).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. HTTP GET /api/code/as-of returns { node, relations } / 404
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/code/as-of returns node + relations for valid query', async () => {
    const queries = createBitemporalQueries(graphStore);
    const app = express();
    app.use(express.json());
    app.use('/api/code', createCodeRoutes(queries));

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId, nodeId: funcANodeId, time: T_NOW });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('node');
    expect(res.body).toHaveProperty('relations');
    expect(res.body.node).not.toBeNull();
    expect(res.body.node.id).toBe(funcANodeId);
    expect(Array.isArray(res.body.relations)).toBe(true);
    expect(res.body.relations.length).toBeGreaterThanOrEqual(1);

    // Response should echo query params
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.nodeId).toBe(funcANodeId);
    expect(res.body.time).toBe(T_NOW);
  });

  it('GET /api/code/as-of returns 404 for non-existent node', async () => {
    const queries = createBitemporalQueries(graphStore);
    const app = express();
    app.use(express.json());
    app.use('/api/code', createCodeRoutes(queries));

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId, nodeId: 'non-existent-node', time: T_NOW });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. HTTP rejects missing params (400)
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/code/as-of rejects missing projectId with 400', async () => {
    const queries = createBitemporalQueries(graphStore);
    const app = express();
    app.use(express.json());
    app.use('/api/code', createCodeRoutes(queries));

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ nodeId: funcANodeId, time: T_NOW });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('projectId');
  });

  it('GET /api/code/as-of rejects missing nodeId with 400', async () => {
    const queries = createBitemporalQueries(graphStore);
    const app = express();
    app.use(express.json());
    app.use('/api/code', createCodeRoutes(queries));

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId, time: T_NOW });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('nodeId');
  });

  it('GET /api/code/as-of rejects missing time with 400', async () => {
    const queries = createBitemporalQueries(graphStore);
    const app = express();
    app.use(express.json());
    app.use('/api/code', createCodeRoutes(queries));

    const res = await request(app)
      .get('/api/code/as-of')
      .query({ projectId, nodeId: funcANodeId });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('time');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. findChangesBetween range query
  // ─────────────────────────────────────────────────────────────────────

  it('findChangesBetween returns relations with valid_from in range', async () => {
    const queries = createBitemporalQueries(graphStore);

    // We have relations with valid_from at T1 and T3 for funcANodeId.
    // Query range (T1, T3] should find relations with valid_from in that window.
    // T3 (2026-09-01) is the valid_from of the new supersede CALLS relation.
    const justBeforeT1 = '2025-12-31T23:59:59Z';
    const justAfterT3 = '2026-09-02T00:00:00Z';

    // Range [justBeforeT1, T3] should capture both T1 and T3 valid_from
    const changes = await queries.findChangesBetween(
      projectId,
      funcANodeId,
      justBeforeT1,
      T3,
    );

    // Should include relations with valid_from = T1 and T3
    const froms = changes.map(r => r.valid_from);
    expect(froms).toContain(T1);
    expect(froms).toContain(T3);

    // Range [T1_5, justAfterT3] should only capture T3
    const recentChanges = await queries.findChangesBetween(
      projectId,
      funcANodeId,
      T1_5,
      justAfterT3,
    );
    const recentFroms = recentChanges.map(r => r.valid_from);
    // T1 should NOT be in this range (T1 < T1_5)
    expect(recentFroms).not.toContain(T1);
    // T3 should be in this range
    expect(recentFroms).toContain(T3);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Bonus: findRelationsAsOf with type filter
  // ─────────────────────────────────────────────────────────────────────

  it('findRelationsAsOf supports optional relation type filter', async () => {
    const queries = createBitemporalQueries(graphStore);

    // Without filter — all relations
    const allRels = await queries.findRelationsAsOf(projectId, funcANodeId, T_NOW);
    expect(allRels.length).toBeGreaterThanOrEqual(1);

    // With type filter — only CALLS
    const callsRels = await queries.findRelationsAsOf(projectId, funcANodeId, T_NOW, 'CALLS');
    expect(callsRels.length).toBeGreaterThanOrEqual(1);
    for (const r of callsRels) {
      expect(r.type).toBe('CALLS');
    }

    // With non-existent type — empty
    const noneRels = await queries.findRelationsAsOf(projectId, funcANodeId, T_NOW, 'NONEXISTENT');
    expect(noneRels.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: supersedeRelation key parsing (found by E2E)
  // ─────────────────────────────────────────────────────────────────────

  it('regression: supersedeRelation works with node IDs containing dashes', async () => {
    // The E2E P1 test found that node IDs like "e2e-p1-123:Function:foo"
    // contain dashes, making split('-') unreliable for parsing oldRelKey.
    // The fix uses newRelation.sourceId/targetId/type instead.
    const queries = createBitemporalQueries(graphStore);

    const result = await queries.supersedeRelation(
      projectId,
      `${funcANodeId}-CALLS-${funcBNodeId}`,
      T3,
      {
        sourceId: funcANodeId,
        targetId: funcBNodeId,
        type: 'CALLS',
        valid_from: T3,
        valid_to: null,
        txn_from: T_NOW,
        txn_to: null,
      },
      T_NOW,
    );

    expect(result.superseded).toBe(true);
  });

  it('regression: supersedeRelation with deliberately wrong oldRelKey still works', async () => {
    // The oldRelKey parameter is ignored; the implementation matches by
    // newRelation.sourceId + targetId + type. This test passes a deliberately
    // wrong oldRelKey and expects success.
    const queries = createBitemporalQueries(graphStore);

    // Create a temporary CALLS relation between funcB and funcC
    const TEMP_T = '2026-07-01T00:00:00Z';
    await graphStore.query(
      `MATCH (a {id: $src, projectId: $pid})
       MATCH (b {id: $tgt, projectId: $pid})
       CREATE (a)-[r:CODE_RELATION {
         sourceId: $src, targetId: $tgt,
         type: 'CALLS', confidence: 1.0,
         valid_from: $tf, valid_to: null,
         txn_from: $tf, txn_to: null
       }]->(b)`,
      { pid: projectId, src: funcBNodeId, tgt: funcCNodeId, tf: TEMP_T },
    );

    // Pass a deliberately WRONG oldRelKey (garbage string)
    // The implementation ignores oldRelKey and matches by newRelation fields
    const result = await queries.supersedeRelation(
      projectId,
      'this-is-a-completely-wrong-key-with-dashes',
      '2026-08-01T00:00:00Z',
      {
        sourceId: funcBNodeId,
        targetId: funcCNodeId,
        type: 'CALLS',
        valid_from: '2026-08-01T00:00:00Z',
        valid_to: null,
        txn_from: T_NOW,
        txn_to: null,
      },
      T_NOW,
    );

    expect(result.superseded).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Boundary: edge cases
  // ─────────────────────────────────────────────────────────────────────

  it('findChangesBetween with empty time range returns empty', async () => {
    const queries = createBitemporalQueries(graphStore);
    const changes = await queries.findChangesBetween(
      projectId,
      funcANodeId,
      '2025-01-01T00:00:00Z',
      '2025-01-01T00:00:00Z', // from === to → empty range
    );
    expect(changes).toEqual([]);
  });

  it('parseNaturalLanguageTime throws for invalid input', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    // Empty string
    expect(() => parseNaturalLanguageTime('', now)).toThrow();
    // Whitespace only
    expect(() => parseNaturalLanguageTime('  ', now)).toThrow();
    // Invalid relative expression
    expect(() => parseNaturalLanguageTime('not-a-time', now)).toThrow();
    // Short number (too short for epoch)
    expect(() => parseNaturalLanguageTime('123', now)).toThrow();
    // Garbage text
    expect(() => parseNaturalLanguageTime('some random text', now)).toThrow();
  });
});
