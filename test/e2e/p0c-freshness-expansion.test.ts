/**
 * E2E Test: P0c Freshness Expansion — Multi-Entity Concurrency + Cross-Project
 *
 * Extends the baseline freshness tests with:
 *  1. Three Function nodes with corresponding WikiEntity describes
 *  2. Change 2 of 3 functions → verify 1 fresh + 2 stale
 *  3. Cross-project isolation: separate project entities not affected
 *  4. service.getFreshness summary counts match individual states
 *  5. Lint includes stale/unbound across multiple entities
 *  6. HTTP API with status filter across entities
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p0c-freshness-expansion.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { IGraphStore, CodeNode } from '../../src/store/interfaces.js';
import { WikiGraph } from '../../src/wiki/graph.js';
import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import { generateSignature } from '../../src/wiki/code-signature.js';
import { checkEntityFreshness } from '../../src/wiki/entity-freshness.js';
import type { WikiEntity, CompileOutput } from '../../src/wiki/models.js';
import { skipE2E, createMockLLM, buildStoreSet } from './helpers.js';

// ─── Mock embedder ────────────────────────────────────────────────────────────
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
  embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
}));

const ORIGINAL_A = `export function fnA(x: number): number { return x * 2; }`;
const ORIGINAL_B = `export function fnB(s: string): string { return s.toUpperCase(); }`;
const ORIGINAL_C = `export function fnC(): boolean { return true; }`;
const CHANGED_A = `export function fnA(x: number): number { return x * 3; }`; // body change
const CHANGED_B = `export function fnB(s: string, n: number): string { return s.repeat(n); }`; // sig change

describe.skipIf(skipE2E)('P0c E2E Expansion: Multi-Entity Freshness + Cross-Project', () => {
  let graphStore: IGraphStore;
  let wikiGraph: WikiGraph;
  const projectId = `e2e-p0c-exp-${Date.now()}`;
  const otherProjectId = `e2e-p0c-other-${Date.now()}`;

  const nodeA = `${projectId}:Function:fnA`;
  const nodeB = `${projectId}:Function:fnB`;
  const nodeC = `${projectId}:Function:fnC`;
  // Other project node (should never be stale in main project)
  const otherNode = `${otherProjectId}:Function:fnOther`;

  const entityA = 'fna';
  const entityB = 'fnb';
  const entityC = 'fnc';
  const entityOther = 'fnother';

  beforeAll(async () => {
    const config = loadConfig();
    graphStore = new Neo4jAdapter(config.neo4j);
    wikiGraph = new WikiGraph(graphStore);

    await graphStore.initializeSchema();
    await graphStore.clearProject(projectId);
    await graphStore.clearProject(otherProjectId);

    // Create Project nodes
    await graphStore.batchCreateNodes([
      { id: projectId, type: 'Project', projectId, name: projectId },
      { id: otherProjectId, type: 'Project', projectId: otherProjectId, name: otherProjectId },
    ]);

    // Create CodeNodes (3 in main project, 1 in other)
    await graphStore.batchCreateNodes([
      { id: nodeA, type: 'Function', projectId, name: 'fnA', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true, content: ORIGINAL_A },
      { id: nodeB, type: 'Function', projectId, name: 'fnB', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true, content: ORIGINAL_B },
      { id: nodeC, type: 'Function', projectId, name: 'fnC', filePath: 'src/c.ts', startLine: 1, endLine: 1, isExported: true, content: ORIGINAL_C },
      { id: otherNode, type: 'Function', projectId: otherProjectId, name: 'fnOther', filePath: 'src/other.ts', startLine: 1, endLine: 1, isExported: true, content: 'export function fnOther() { return 0; }' },
    ] as CodeNode[]);

    // Ingest all 4 entities via WikiService (this creates describes links)
    const compileOutput: CompileOutput = {
      title: 'Multi Entity Test',
      summary: 'Testing multi-entity freshness',
      keyPoints: [],
      entities: [
        { name: 'FnA', type: 'api', definition: 'Multiplies by 2', details: '', links: [{ target: 'fnA', relationship: 'describes' }] },
        { name: 'FnB', type: 'api', definition: 'Uppercases string', details: '', links: [{ target: 'fnB', relationship: 'describes' }] },
        { name: 'FnC', type: 'api', definition: 'Returns true', details: '', links: [{ target: 'fnC', relationship: 'describes' }] },
      ],
      existingUpdates: [],
      contradictions: [],
    };
    const compileOutputOther: CompileOutput = {
      title: 'Other Project',
      summary: '',
      keyPoints: [],
      entities: [
        { name: 'FnOther', type: 'api', definition: 'Other project', details: '', links: [{ target: 'fnOther', relationship: 'describes' }] },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM({ generateJSONResponse: compileOutput });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    // Ingest main project
    await service.ingest(projectId, 'docs/multi.md', '# Multi Entity\n\nDocs for all three.\n');

    // Ingest other project
    const llmOther = createMockLLM({ generateJSONResponse: compileOutputOther });
    const storesOther = buildStoreSet(graphStore, llmOther);
    const serviceOther = new WikiService(storesOther, wikiConfig);
    await serviceOther.ingest(otherProjectId, 'docs/other.md', '# Other\n\nOther project doc.\n');
  }, 30_000);

  afterAll(async () => {
    try {
      await graphStore.clearProject(projectId);
      await graphStore.clearProject(otherProjectId);
    } catch { /* ignore */ }
    await graphStore.close();
  }, 15_000);

  // ── 1. All 4 entities have codeSignature ───────────────────────────
  it('all entities have codeSignature bound via describes', async () => {
    for (const eId of [entityA, entityB, entityC, entityOther]) {
      const entity = await wikiGraph.getEntity(
        eId === entityOther ? otherProjectId : projectId, eId,
      );
      expect(entity).not.toBeNull();
      expect(entity!.codeSignature).toBeDefined();
      expect(entity!.codeSignature!.entityName).toBeDefined();
    }
  });

  // ── 2. All fresh initially ─────────────────────────────────────────
  it('all entities start fresh', async () => {
    for (const eId of [entityA, entityB, entityC]) {
      const entity = await wikiGraph.getEntity(projectId, eId);
      const result = await checkEntityFreshness(projectId, entity!, graphStore);
      expect(result.state).toBe('fresh');
    }
    const otherEntity = await wikiGraph.getEntity(otherProjectId, entityOther);
    const otherResult = await checkEntityFreshness(otherProjectId, otherEntity!, graphStore);
    expect(otherResult.state).toBe('fresh');
  });

  // ── 3. Change fnA (body) + fnB (signature) → stale, fnC stays fresh ──
  it('after changing fnA and fnB: fnA stale, fnB stale, fnC fresh', async () => {
    // Change fnA (body only)
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $pid}) SET n.content = $content`,
      { id: nodeA, pid: projectId, content: CHANGED_A },
    );
    // Change fnB (signature)
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $pid}) SET n.content = $content`,
      { id: nodeB, pid: projectId, content: CHANGED_B },
    );

    // fnA: stale (astHash differs, signatureHash same)
    const entityAobj = await wikiGraph.getEntity(projectId, entityA);
    const resultA = await checkEntityFreshness(projectId, entityAobj!, graphStore);
    expect(resultA.state).toBe('stale');
    expect(resultA.issue!.type).toBe('stale');

    // fnB: stale (both astHash and signatureHash differ)
    const entityBobj = await wikiGraph.getEntity(projectId, entityB);
    const resultB = await checkEntityFreshness(projectId, entityBobj!, graphStore);
    expect(resultB.state).toBe('stale');

    // fnC: still fresh (unchanged)
    const entityCobj = await wikiGraph.getEntity(projectId, entityC);
    const resultC = await checkEntityFreshness(projectId, entityCobj!, graphStore);
    expect(resultC.state).toBe('fresh');

    // Other project: still fresh (no cross-project pollution)
    const entityOtherObj = await wikiGraph.getEntity(otherProjectId, entityOther);
    const resultOther = await checkEntityFreshness(otherProjectId, entityOtherObj!, graphStore);
    expect(resultOther.state).toBe('fresh');
  });

  // ── 4. getFreshness() summary matches ──────────────────────────────
  it('getFreshness() summary shows 1 fresh + 2 stale', async () => {
    const llm = createMockLLM();
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const report = await service.getFreshness(projectId);
    expect(report.summary.fresh).toBeGreaterThanOrEqual(1);
    expect(report.summary.stale).toBeGreaterThanOrEqual(2);
  });

  // ── 5. Cross-project: other project still 1 fresh ──────────────────
  it('cross-project isolation: other project has 1 fresh, 0 stale', async () => {
    const llm = createMockLLM();
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const report = await service.getFreshness(otherProjectId);
    expect(report.summary.fresh).toBeGreaterThanOrEqual(1);
    // fnC in main project should NOT affect other project
    expect(report.items.every(i => i.status === 'fresh')).toBe(true);
  });

  // ── 6. Lint includes stale issues ──────────────────────────────────
  it('lint() includes stale issues for changed entities', async () => {
    const llm = createMockLLM();
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const issues = await service.lint(projectId);
    const staleIssues = issues.filter(i => i.type === 'stale');
    const staleEntityIds = staleIssues.map(i => i.entityId);
    expect(staleEntityIds).toContain(entityA);
    expect(staleEntityIds).toContain(entityB);
    expect(staleEntityIds).not.toContain(entityC);
  });

  // ── 7. HTTP freshness with status=stale filter ─────────────────────
  it('HTTP GET /api/wiki/freshness?status=stale returns only stale items', async () => {
    const llm = createMockLLM();
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);
    const { createWikiRoutes } = await import('../../src/wiki/routes.js');
    const express = await import('express');
    const request = await import('supertest');

    const app = express.default();
    app.use(express.default.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request.default(app)
      .get('/api/wiki/freshness')
      .query({ projectId, status: 'stale' });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of res.body.items) {
      expect(item.status).toBe('stale');
    }
  });

  // ── 8. Reindex pipeline ─────────────────────────────────────────
  it('reindex() processes all entities and sources', async () => {
    const mockLLM = createMockLLM();
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const result = await service.reindex(projectId);

    // Should find 3 entities from the main project
    expect(result.entities).toBeGreaterThanOrEqual(3);
    expect(result.errors).toBe(0);
  });

  it('reindex() with empty project returns zero counts', async () => {
    const emptyProjectId = `e2e-p0c-empty-${Date.now()}`;
    await graphStore.batchCreateNodes([
      { id: emptyProjectId, type: 'Project', projectId: emptyProjectId, name: emptyProjectId },
    ]);

    const mockLLM = createMockLLM();
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const result = await service.reindex(emptyProjectId);

    expect(result.entities).toBe(0);
    expect(result.sources).toBe(0);
    expect(result.topics).toBe(0);
    expect(result.errors).toBe(0);

    await graphStore.clearProject(emptyProjectId);
  });
});
