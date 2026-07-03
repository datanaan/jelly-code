/**
 * E2E Test: P0c Wiki Code Signature + Staleness Detection
 *
 * Validates the full staleness flow end-to-end against a real Neo4j database:
 *
 * 1. Compile binds codeSignature via bindCodeSignature() during ingest
 * 2. Signature matches the original code (generateSignature equivalence)
 * 3. Fresh state: code unchanged → state='fresh'
 * 4. Stale state (body change): astHash differs → state='stale'
 * 5. Stale state (signature change): signatureHash differs → state='stale'
 * 6. Orphaned state: code node deleted → state='orphaned'
 * 7. Unbound state: entity without describes link → state='unbound'
 * 8. Lint integration: stale issues appear after code change
 * 9. HTTP API: GET /api/wiki/freshness returns { items, summary }
 *
 * Approach:
 * - Real Neo4j (required for findSymbol + CodeNode roundtrip)
 * - Mocked embedder + LLM (avoid Ollama dependency)
 * - Mocked search/vector stores (not needed for freshness detection)
 * - CodeNodes created directly in Neo4j via batchCreateNodes
 * - WikiEntities created via WikiGraph.createEntity with real generateSignature()
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p0c-wiki-freshness.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { IGraphStore, CodeNode } from '../../src/store/interfaces.js';
import { WikiGraph } from '../../src/wiki/graph.js';
import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import { generateSignature } from '../../src/wiki/code-signature.js';
import { checkEntityFreshness } from '../../src/wiki/entity-freshness.js';
import type { WikiEntity, CompileOutput } from '../../src/wiki/models.js';
import express from 'express';
import request from 'supertest';
import { skipE2E, createMockLLM, buildStoreSet } from './helpers.js';

// ─── Mock the embedder BEFORE any wiki imports that use it ──────────────────
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
  embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
}));

// ─── E2E gate ───────────────────────────────────────────────────────────────
// (skipE2E imported from helpers.ts)

// ─── Test constants ─────────────────────────────────────────────────────────

/** Original greet function source code */
const ORIGINAL_CODE = `export function greet(name: string): string {
  return 'hello ' + name;
}`;

/** Body-only change: signature stable, astHash differs */
const BODY_CHANGED_CODE = `export function greet(name: string): string {
  return 'hi ' + name;
}`;

/** Signature change: extra param → signatureHash differs */
const SIGNATURE_CHANGED_CODE = `export function greet(name: string, greeting: string): string {
  return greeting + ' ' + name;
}`;

// ─── Mock LLM Factory ──────────────────────────────────────────────────────
// (createMockLLM imported from helpers.ts)

// ─── StoreSet Builder ──────────────────────────────────────────────────────
// (buildStoreSet imported from helpers.ts)

// ─── Test suite ─────────────────────────────────────────────────────────────

describe.skipIf(skipE2E)('P0c E2E: Wiki Code Signature + Staleness Detection', () => {
  let graphStore: IGraphStore;
  let wikiGraph: WikiGraph;
  const projectId = `e2e-p0c-${Date.now()}`;

  // Node/entity IDs for cleanup tracking
  const codeNodeId = `${projectId}:Function:greet`;
  // WikiService.ingest creates entityId from entity name via: name.toLowerCase().replace(/\s+/g, '-')
  // 'GreetEntity' → 'greetentity'
  const entityId = 'greetentity';
  const unboundEntityId = 'pure-concept';

  beforeAll(async () => {
    const config = loadConfig();
    graphStore = new Neo4jAdapter(config.neo4j);
    wikiGraph = new WikiGraph(graphStore);

    // Initialize schema (constraints + indexes)
    await graphStore.initializeSchema();

    // Clean up any leftover data for this project (shouldn't exist, but safe)
    await graphStore.clearProject(projectId);

    // ── Create a Project node (required for relation integrity) ─────────
    await graphStore.batchCreateNodes([
      {
        id: projectId,
        type: 'Project',
        projectId,
        name: projectId,
      },
    ]);

    // ── Create the CodeNode for greet() ────────────────────────────────
    await graphStore.batchCreateNodes([
      {
        id: codeNodeId,
        type: 'Function',
        projectId,
        name: 'greet',
        filePath: 'src/greet.ts',
        startLine: 1,
        endLine: 3,
        isExported: true,
        content: ORIGINAL_CODE,
      } as CodeNode,
    ]);
  }, 30_000);

  afterAll(async () => {
    // Cleanup: delete all data for this project
    try {
      await graphStore.clearProject(projectId);
    } catch {
      // Ignore cleanup errors
    }
    await graphStore.close();
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────
  // 1. Compile binds codeSignature during ingest
  // ─────────────────────────────────────────────────────────────────────

  it('ingest binds codeSignature via describes link', async () => {
    // LLM returns an entity with a "describes" link to the greet code symbol
    const compileOutput: CompileOutput = {
      title: 'Greet API Doc',
      summary: 'Documentation for the greet function',
      keyPoints: ['says hello'],
      entities: [
        {
          name: 'GreetEntity',
          type: 'api',
          definition: 'A function that greets a user by name',
          details: 'The greet function takes a name parameter and returns a greeting string',
          links: [{ target: 'greet', relationship: 'describes' }],
        },
      ],
      existingUpdates: [],
      contradictions: [],
    };

    const llm = createMockLLM({ generateJSONResponse: compileOutput });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    // Run ingest — this calls bindCodeSignature which calls findSymbol('greet')
    await service.ingest(projectId, 'docs/greet.wiki.md', '# Greet Doc\n\nDescribes greet.');

    // Verify the entity was created with a codeSignature
    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();
    expect(entity!.codeSignature).toBeDefined();
    expect(entity!.codeSignature).not.toBeNull();
    expect(entity!.codeSignature!.entityName).toBe('greet');
    expect(entity!.codeSignature!.entityType).toBe('function');
    expect(entity!.codeSignature!.paramTypes).toEqual(['string']);
    expect(entity!.codeSignature!.returnType).toBe('string');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Stored signature matches generateSignature(originalCode)
  // ─────────────────────────────────────────────────────────────────────

  it('stored signatureHash matches generateSignature of original code', async () => {
    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();

    const expectedSig = generateSignature(ORIGINAL_CODE, 'greet');
    expect(entity!.codeSignature!.signatureHash).toBe(expectedSig.signatureHash);
    expect(entity!.codeSignature!.astHash).toBe(expectedSig.astHash);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Fresh state: code unchanged → state='fresh'
  // ─────────────────────────────────────────────────────────────────────

  it('checkEntityFreshness returns fresh for unchanged code', async () => {
    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();

    const result = await checkEntityFreshness(projectId, entity!, graphStore);
    expect(result.state).toBe('fresh');
    expect(result.issue).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Stale state (body change): astHash differs
  // ─────────────────────────────────────────────────────────────────────

  it('checkEntityFreshness returns stale when function body changed', async () => {
    // Update the CodeNode content in Neo4j (body-only change)
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId})
       SET n.content = $newContent`,
      { id: codeNodeId, projectId, newContent: BODY_CHANGED_CODE },
    );

    // Re-read entity (its codeSignature was bound to the ORIGINAL code)
    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();

    const result = await checkEntityFreshness(projectId, entity!, graphStore);
    expect(result.state).toBe('stale');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('stale');
    expect(result.issue!.entityId).toBe(entityId);
    expect(result.issue!.severity).toBe('warning');

    // The signatureHash should be the SAME (only body changed, not the signature)
    // But astHash should DIFFER (body content is different)
    const currentSig = generateSignature(BODY_CHANGED_CODE, 'greet');
    expect(currentSig.signatureHash).toBe(entity!.codeSignature!.signatureHash);
    expect(currentSig.astHash).not.toBe(entity!.codeSignature!.astHash);

    // Restore original code for subsequent tests
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId})
       SET n.content = $originalContent`,
      { id: codeNodeId, projectId, originalContent: ORIGINAL_CODE },
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Stale state (signature change): signatureHash differs
  // ─────────────────────────────────────────────────────────────────────

  it('checkEntityFreshness returns stale when function signature changed', async () => {
    // Update the CodeNode to a different signature (added param)
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId})
       SET n.content = $newContent`,
      { id: codeNodeId, projectId, newContent: SIGNATURE_CHANGED_CODE },
    );

    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();

    const result = await checkEntityFreshness(projectId, entity!, graphStore);
    expect(result.state).toBe('stale');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('stale');

    // Both signatureHash and astHash should differ now
    const currentSig = generateSignature(SIGNATURE_CHANGED_CODE, 'greet');
    expect(currentSig.signatureHash).not.toBe(entity!.codeSignature!.signatureHash);
    expect(currentSig.paramTypes).toEqual(['string', 'string']);

    // Restore original code
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId})
       SET n.content = $originalContent`,
      { id: codeNodeId, projectId, originalContent: ORIGINAL_CODE },
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Orphaned state: code node deleted
  // ─────────────────────────────────────────────────────────────────────

  it('checkEntityFreshness returns orphaned when code node is deleted', async () => {
    // Temporarily delete the CodeNode
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId}) DETACH DELETE n`,
      { id: codeNodeId, projectId },
    );

    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();

    const result = await checkEntityFreshness(projectId, entity!, graphStore);
    expect(result.state).toBe('orphaned');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('orphan');
    expect(result.issue!.description).toContain('no longer');

    // Recreate the CodeNode for subsequent tests
    await graphStore.batchCreateNodes([
      {
        id: codeNodeId,
        type: 'Function',
        projectId,
        name: 'greet',
        filePath: 'src/greet.ts',
        startLine: 1,
        endLine: 3,
        isExported: true,
        content: ORIGINAL_CODE,
      } as CodeNode,
    ]);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. Unbound state: entity without describes link
  // ─────────────────────────────────────────────────────────────────────

  it('checkEntityFreshness returns unbound for entity without codeSignature', async () => {
    // Create an entity with codeSignature=null (no describes link)
    const now = new Date().toISOString();
    const unboundEntity: WikiEntity = {
      id: unboundEntityId,
      projectId,
      name: 'PureConcept',
      entityType: 'concept',
      definition: 'A concept with no code binding',
      details: 'This entity has no describes link to any code symbol',
      firstCompiled: now,
      lastUpdated: now,
      codeSignature: null,
    };
    await wikiGraph.createEntity(unboundEntity);

    const entity = await wikiGraph.getEntity(projectId, unboundEntityId);
    expect(entity).not.toBeNull();

    const result = await checkEntityFreshness(projectId, entity!, graphStore);
    expect(result.state).toBe('unbound');
    expect(result.issue).toBeDefined();
    expect(result.issue!.type).toBe('unbound');
    expect(result.issue!.entityName).toBe('PureConcept');
    expect(result.issue!.severity).toBe('warning');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. Lint integration: freshness issues in lint() output
  // ─────────────────────────────────────────────────────────────────────

  it('lint() includes stale issue after code body change', async () => {
    // Code is currently ORIGINAL → entity should be fresh in lint
    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const freshIssues = await service.lint(projectId);
    const freshStaleIssues = freshIssues.filter(
      (i) => i.type === 'stale' && i.entityId === entityId,
    );
    expect(freshStaleIssues.length).toBe(0);

    // Now change the code body
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId})
       SET n.content = $newContent`,
      { id: codeNodeId, projectId, newContent: BODY_CHANGED_CODE },
    );

    const staleIssues = await service.lint(projectId);
    const greetStaleIssue = staleIssues.find(
      (i) => i.type === 'stale' && i.entityId === entityId,
    );
    expect(greetStaleIssue).toBeDefined();
    expect(greetStaleIssue!.description).toContain('stale');

    // Restore original code
    await graphStore.query(
      `MATCH (n:Function {id: $id, projectId: $projectId})
       SET n.content = $originalContent`,
      { id: codeNodeId, projectId, originalContent: ORIGINAL_CODE },
    );
  });

  it('lint() includes unbound issue for entity without codeSignature', async () => {
    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const issues = await service.lint(projectId);
    const unboundIssue = issues.find(
      (i) => i.type === 'unbound' && i.entityId === unboundEntityId,
    );
    expect(unboundIssue).toBeDefined();
    expect(unboundIssue!.entityName).toBe('PureConcept');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. getFreshness() returns structured report
  // ─────────────────────────────────────────────────────────────────────

  it('getFreshness() returns { items, summary } with correct counts', async () => {
    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const report = await service.getFreshness(projectId);

    // Should have at least 2 entities: greet-entity (fresh) + pure-concept (unbound)
    expect(report.items.length).toBeGreaterThanOrEqual(2);

    // Summary should have all 4 keys
    expect(report.summary).toHaveProperty('fresh');
    expect(report.summary).toHaveProperty('stale');
    expect(report.summary).toHaveProperty('orphaned');
    expect(report.summary).toHaveProperty('unbound');

    // greet-entity should be fresh (code is back to original)
    const greetItem = report.items.find((i) => i.entityId === entityId);
    expect(greetItem).toBeDefined();
    expect(greetItem!.status).toBe('fresh');
    expect(greetItem!.issue).toBeNull();

    // pure-concept should be unbound
    const conceptItem = report.items.find((i) => i.entityId === unboundEntityId);
    expect(conceptItem).toBeDefined();
    expect(conceptItem!.status).toBe('unbound');
    expect(conceptItem!.issue).not.toBeNull();

    // Summary counts should be consistent
    expect(report.summary.fresh).toBeGreaterThanOrEqual(1);
    expect(report.summary.unbound).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. HTTP API: GET /api/wiki/freshness
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/freshness returns items + summary via HTTP', async () => {
    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('summary');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);

    // Summary has 4 keys
    const summary = res.body.summary;
    expect(summary).toHaveProperty('fresh');
    expect(summary).toHaveProperty('stale');
    expect(summary).toHaveProperty('orphaned');
    expect(summary).toHaveProperty('unbound');

    // Find greet-entity in items — should be fresh
    const greetItem = res.body.items.find(
      (i: { entityId: string }) => i.entityId === entityId,
    );
    expect(greetItem).toBeDefined();
    expect(greetItem.status).toBe('fresh');
  });

  it('GET /api/wiki/freshness with status=unbound filter returns only unbound', async () => {
    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .get('/api/wiki/freshness')
      .query({ projectId, status: 'unbound' });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    // All items should be unbound
    for (const item of res.body.items) {
      expect(item.status).toBe('unbound');
    }
    // Summary should reflect filtered counts
    expect(res.body.summary.unbound).toBe(res.body.items.length);
    expect(res.body.summary.fresh).toBe(0);
  });

  it('GET /api/wiki/freshness rejects missing projectId with 400', async () => {
    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app).get('/api/wiki/freshness');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: codeSignature Neo4j serialization (found by E2E)
  // ─────────────────────────────────────────────────────────────────────

  it('regression: codeSignature stored as JSON string in Neo4j (not JS object)', async () => {
    // The P0c E2E test found that Neo4j can't store JS objects as properties.
    // The fix uses JSON.stringify() on write and JSON.parse() on read.
    // This test verifies the raw Neo4j property is a string, not an object.
    const raw = await graphStore.query(
      `MATCH (e:WikiEntity {id: $id, projectId: $projectId})
       RETURN e.codeSignature AS rawSig`,
      { id: entityId, projectId },
    );
    expect(raw.length).toBeGreaterThanOrEqual(1);
    const rawSig = raw[0].rawSig;
    // Must be a string (JSON.stringify'd), not a JS object
    expect(typeof rawSig).toBe('string');
    // Must be parseable JSON
    const parsed = JSON.parse(rawSig as string);
    expect(parsed).toHaveProperty('entityName', 'greet');
    expect(parsed).toHaveProperty('entityType', 'function');
    expect(Array.isArray(parsed.paramTypes)).toBe(true);
    expect(parsed.paramTypes).toContain('string');
    expect(parsed).toHaveProperty('returnType');
    expect(parsed).toHaveProperty('signatureHash');
    expect(parsed).toHaveProperty('astHash');
  });

  it('regression: codeSignature roundtrip preserves nested object integrity', async () => {
    // Full roundtrip: create entity → codeSignature JSON.stringify'd → read back
    // via WikiGraph.getEntity (which calls deserializeCodeSignature internally)
    const entity = await wikiGraph.getEntity(projectId, entityId);
    expect(entity).not.toBeNull();
    expect(entity!.codeSignature).not.toBeNull();
    expect(entity!.codeSignature!.entityName).toBe('greet');
    expect(entity!.codeSignature!.entityType).toBe('function');
    expect(entity!.codeSignature!.paramTypes).toEqual(['string']);
    expect(entity!.codeSignature!.returnType).toBe('string');
    // signatureHash and astHash are non-empty hex strings
    expect(entity!.codeSignature!.signatureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entity!.codeSignature!.astHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Boundary: edge cases
  // ─────────────────────────────────────────────────────────────────────

  it('getFreshness() on project with no entities returns empty report', async () => {
    const emptyProjectId = `e2e-p0c-empty-${Date.now()}`;
    // Create the project node but no entities
    await graphStore.batchCreateNodes([
      { id: emptyProjectId, type: 'Project', projectId: emptyProjectId, name: emptyProjectId } as CodeNode,
    ]);

    const llm = createMockLLM({ generateJSONResponse: {
      title: 'x', summary: '', keyPoints: [], entities: [], existingUpdates: [], contradictions: [],
    } });
    const stores = buildStoreSet(graphStore, llm);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const report = await service.getFreshness(emptyProjectId);
    expect(report.items).toEqual([]);
    expect(report.summary).toHaveProperty('fresh', 0);
    expect(report.summary).toHaveProperty('stale', 0);
    expect(report.summary).toHaveProperty('orphaned', 0);
    expect(report.summary).toHaveProperty('unbound', 0);

    await graphStore.clearProject(emptyProjectId);
  });
});
