/**
 * E2E Test: P2 Evolution Narrative + Anti-Hallucination (final e2e)
 *
 * Validates the full evolution narrative pipeline end-to-end:
 *
 *  1. gatherEvolutionFacts returns all 5 data sources
 *  2. detectChapters finds founding chapter
 *  3. detectChapters finds maintenance chapter (30+ day gap)
 *  4. generateNarrative calls LLM with prompt
 *  5. generateNarrative returns LLM output
 *  6. Anti-hallucination passes truthful narrative
 *  7. Anti-hallucination catches fabricated hashes
 *  8. Anti-hallucination catches mixed real+fake
 *  9. Abbreviated hash prefix matching
 * 10. generateEvolutionStory end-to-end (WikiService)
 * 11. WikiTopic persisted in graph
 * 12. HTTP POST /api/wiki/evolution-story returns 200 + taskId
 * 13. HTTP GET /api/wiki/evolution-story/:topicId returns content
 * 14. Data insufficient path (no CHANGED_IN edges)
 *
 * Approach:
 * - Real Neo4j (required for graph queries)
 * - Mock LLM (no Ollama dependency)
 * - Direct Cypher for fixture creation (no runAnalyze)
 * - Real WikiService with real graphStore + mock llmClient
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p2-evolution-narrator.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { IGraphStore, CodeNode } from '../../src/store/interfaces.js';
import { WikiGraph } from '../../src/wiki/graph.js';
import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import { createWikiRoutes } from '../../src/wiki/routes.js';
import { gatherEvolutionFacts } from '../../src/wiki/evolution-facts-query.js';
import { detectChapters } from '../../src/wiki/chapter-detector.js';
import {
  generateNarrative,
  validateNarrative,
} from '../../src/wiki/evolution-narrator.js';
import { EVOLUTION_STORY_PROMPT } from '../../src/llm/prompts.js';
import type { EvolutionFacts } from '../../src/wiki/evolution-facts-query.js';
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

// ─── Mock LLM Factory + StoreSet Builder ──────────────────────────────────
// (createMockLLM and buildStoreSet imported from helpers.ts)

// ─── Test suite ─────────────────────────────────────────────────────────────

describe.skipIf(skipE2E)('P2 E2E: Evolution Narrative + Anti-Hallucination', () => {
  let graphStore: IGraphStore;
  let wikiGraph: WikiGraph;
  const projectId = `e2e-p2-${Date.now()}`;

  // Node IDs
  const funcNodeId = `${projectId}:Function:importantFunction`;
  const predecessorNodeId = `${projectId}:Function:oldFunction`;
  const siblingANodeId = `${projectId}:Function:helperA`;
  const siblingBNodeId = `${projectId}:Function:helperB`;
  const emptyNodeId = `${projectId}:Function:emptyFunction`;

  // Commit hashes (real, used in fixtures)
  const COMMIT_1 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const COMMIT_2 = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1';
  const COMMIT_3 = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
  const EVO_COMMIT = 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3';

  // Timestamps spread over 60+ days to trigger maintenance chapter
  const T_COMMIT_1 = '2026-01-10T10:00:00Z';
  const T_COMMIT_2 = '2026-01-15T14:00:00Z'; // 5 days after commit 1
  const T_COMMIT_3 = '2026-03-01T09:00:00Z'; // 45 days after commit 2 → maintenance gap
  const T_EVO = '2026-01-12T12:00:00Z'; // Between commit 1 and 2

  // Authors
  const AUTHOR_1 = 'alice';
  const AUTHOR_2 = 'bob';

  beforeAll(async () => {
    const config = loadConfig();
    graphStore = new Neo4jAdapter(config.neo4j);
    wikiGraph = new WikiGraph(graphStore);

    await graphStore.initializeSchema();
    await graphStore.clearProject(projectId);

    // ── Create Project node ───────────────────────────────────────────
    await graphStore.batchCreateNodes([
      { id: projectId, type: 'Project', projectId, name: projectId },
    ]);

    // ── Create CodeNodes ──────────────────────────────────────────────
    const nodes: CodeNode[] = [
      {
        id: funcNodeId,
        type: 'Function',
        projectId,
        name: 'importantFunction',
        filePath: 'src/important.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
        content: 'export function importantFunction() { return 42; }',
      },
      {
        id: predecessorNodeId,
        type: 'Function',
        projectId,
        name: 'oldFunction',
        filePath: 'src/old.ts',
        startLine: 1,
        endLine: 5,
        content: 'function oldFunction() {}',
      },
      {
        id: siblingANodeId,
        type: 'Function',
        projectId,
        name: 'helperA',
        filePath: 'src/helperA.ts',
        startLine: 1,
        endLine: 3,
        content: 'function helperA() {}',
      },
      {
        id: siblingBNodeId,
        type: 'Function',
        projectId,
        name: 'helperB',
        filePath: 'src/helperB.ts',
        startLine: 1,
        endLine: 3,
        content: 'function helperB() {}',
      },
      {
        id: emptyNodeId,
        type: 'Function',
        projectId,
        name: 'emptyFunction',
        filePath: 'src/empty.ts',
        startLine: 1,
        endLine: 3,
        content: 'function emptyFunction() {}',
      },
    ];
    await graphStore.batchCreateNodes(nodes);

    // ── Create Commit nodes ───────────────────────────────────────────
    await graphStore.query(
      `CREATE (c1:Commit {id: $h1, message: 'initial', author: $a1, timestamp: $t1, additions: 50, deletions: 0, projectId: $pid}),
              (c2:Commit {id: $h2, message: 'refactor', author: $a1, timestamp: $t2, additions: 20, deletions: 10, projectId: $pid}),
              (c3:Commit {id: $h3, message: 'bugfix', author: $a2, timestamp: $t3, additions: 5, deletions: 2, projectId: $pid}),
              (cEvo:Commit {id: $hE, message: 'rename', author: $a1, timestamp: $tE, additions: 15, deletions: 8, projectId: $pid})`,
      {
        pid: projectId,
        h1: COMMIT_1, t1: T_COMMIT_1, a1: AUTHOR_1,
        h2: COMMIT_2, t2: T_COMMIT_2,
        h3: COMMIT_3, t3: T_COMMIT_3, a2: AUTHOR_2,
        hE: EVO_COMMIT, tE: T_EVO,
      },
    );

    // ── Create CHANGED_IN edges (funcNode → commits) ──────────────────
    // Using CODE_RELATION with type='CHANGED_IN' as expected by temporal-queries.ts
    await graphStore.query(
      `MATCH (n {id: $funcId, projectId: $pid})
       MATCH (c1:Commit {id: $h1}), (c2:Commit {id: $h2}), (c3:Commit {id: $h3})
       CREATE (n)-[:CODE_RELATION {type: 'CHANGED_IN', sourceId: $funcId, targetId: $h1, projectId: $pid, valid_from: $t1, valid_to: null}]->(c1),
              (n)-[:CODE_RELATION {type: 'CHANGED_IN', sourceId: $funcId, targetId: $h2, projectId: $pid, valid_from: $t2, valid_to: null}]->(c2),
              (n)-[:CODE_RELATION {type: 'CHANGED_IN', sourceId: $funcId, targetId: $h3, projectId: $pid, valid_from: $t3, valid_to: null}]->(c3)`,
      { pid: projectId, funcId: funcNodeId, h1: COMMIT_1, h2: COMMIT_2, h3: COMMIT_3, t1: T_COMMIT_1, t2: T_COMMIT_2, t3: T_COMMIT_3 },
    );

    // ── Create Author nodes + AUTHORED_BY edges ──────────────────────
    await graphStore.query(
      `CREATE (a1:Author {id: 'a1', name: $name1, email: 'alice@example.com', projectId: $pid}),
              (a2:Author {id: 'a2', name: $name2, email: 'bob@example.com', projectId: $pid})`,
      { pid: projectId, name1: AUTHOR_1, name2: AUTHOR_2 },
    );

    await graphStore.query(
      `MATCH (n {id: $funcId, projectId: $pid}), (a1:Author {id: 'a1', projectId: $pid}), (a2:Author {id: 'a2', projectId: $pid})
       CREATE (n)-[:CODE_RELATION {type: 'AUTHORED_BY', sourceId: $funcId, targetId: 'a1', projectId: $pid, changeCount: 2, ownership: 0.67, lastChangeAt: $t2}]->(a1),
              (n)-[:CODE_RELATION {type: 'AUTHORED_BY', sourceId: $funcId, targetId: 'a2', projectId: $pid, changeCount: 1, ownership: 0.33, lastChangeAt: $t3}]->(a2)`,
      { pid: projectId, funcId: funcNodeId, t2: T_COMMIT_2, t3: T_COMMIT_3 },
    );

    // ── Create EVOLVED_FROM edge (funcNode → predecessor) ─────────────
    await graphStore.query(
      `MATCH (n {id: $funcId, projectId: $pid}), (prev {id: $prevId, projectId: $pid})
       CREATE (n)-[:CODE_RELATION {
         type: 'EVOLVED_FROM', sourceId: $funcId, targetId: $prevId,
         projectId: $pid, originalName: 'oldFunction', originalFile: 'src/old.ts',
         commitHash: $evoCommit, timestamp: $tE, valid_from: $tE, valid_to: null
       }]->(prev)`,
      { pid: projectId, funcId: funcNodeId, prevId: predecessorNodeId, evoCommit: EVO_COMMIT, tE: T_EVO },
    );

    // ── Create CO_CHANGED_WITH edges ──────────────────────────────────
    await graphStore.query(
      `MATCH (n {id: $funcId, projectId: $pid}),
            (sA {id: $sAId, projectId: $pid}),
            (sB {id: $sBId, projectId: $pid})
       CREATE (n)-[:CODE_RELATION {
         type: 'CO_CHANGED_WITH', sourceId: $funcId, targetId: $sAId,
         projectId: $pid, coChangeCount: 5, support: 0.8, confidence: 0.6, lift: 1.2
       }]->(sA),
       (n)-[:CODE_RELATION {
         type: 'CO_CHANGED_WITH', sourceId: $funcId, targetId: $sBId,
         projectId: $pid, coChangeCount: 3, support: 0.5, confidence: 0.4, lift: 1.0
       }]->(sB)`,
      { pid: projectId, funcId: funcNodeId, sAId: siblingANodeId, sBId: siblingBNodeId },
    );
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
  // 1. gatherEvolutionFacts returns all 5 data sources
  // ─────────────────────────────────────────────────────────────────────

  it('gatherEvolutionFacts returns all 5 data sources populated', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    expect(facts.nodeId).toBe(funcNodeId);

    // Source 1: evolvedFrom
    expect(facts.evolvedFrom.length).toBeGreaterThanOrEqual(1);
    const evo = facts.evolvedFrom[0];
    expect(evo.from).toBe(funcNodeId);
    expect(evo.to).toBe(predecessorNodeId);
    expect(evo.commit).toBe(EVO_COMMIT);

    // Source 2: changedIn
    expect(facts.changedIn.length).toBe(3);
    const commitHashes = facts.changedIn.map((c) => c.commit);
    expect(commitHashes).toContain(COMMIT_1);
    expect(commitHashes).toContain(COMMIT_2);
    expect(commitHashes).toContain(COMMIT_3);

    // Source 3: authoredBy
    expect(facts.authoredBy.length).toBeGreaterThanOrEqual(1);
    const authorNames = facts.authoredBy.map((a) => a.author);
    expect(authorNames.some((n) => n === AUTHOR_1 || n.includes(AUTHOR_1))).toBe(true);

    // Source 4: coChangedWith
    expect(facts.coChangedWith.length).toBeGreaterThanOrEqual(1);

    // Source 5: changeTimeline (from bi-temporal CODE_RELATION edges)
    expect(facts.changeTimeline.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. detectChapters finds founding chapter
  // ─────────────────────────────────────────────────────────────────────

  it('detectChapters finds founding chapter in first 10% of commits', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    // Build timeline from changeTimeline
    const timeline = facts.changeTimeline.map((t) => ({ timestamp: t.timestamp }));
    const chapters = detectChapters({ changeTimeline: timeline });

    // Should have at least a founding chapter
    const founding = chapters.find((c) => c.type === 'founding');
    expect(founding).toBeDefined();
    expect(founding!.from).toBe(T_COMMIT_1); // Earliest commit
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. detectChapters finds maintenance chapter (30+ day gap)
  // ─────────────────────────────────────────────────────────────────────

  it('detectChapters finds maintenance chapter for 30+ day gap', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    const timeline = facts.changeTimeline.map((t) => ({ timestamp: t.timestamp }));
    const chapters = detectChapters({ changeTimeline: timeline });

    // T_COMMIT_2 (2026-01-15) → T_COMMIT_3 (2026-03-01) is ~45 days → maintenance
    const maintenance = chapters.find((c) => c.type === 'maintenance');
    expect(maintenance).toBeDefined();
    // The maintenance gap spans from T_COMMIT_2 to T_COMMIT_3
    expect(maintenance!.from).toBe(T_COMMIT_2);
    expect(maintenance!.to).toBe(T_COMMIT_3);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. generateNarrative calls LLM with prompt
  // ─────────────────────────────────────────────────────────────────────

  it('generateNarrative calls LLM with EVOLUTION_STORY_PROMPT', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);
    const chapters = detectChapters({
      changeTimeline: facts.changeTimeline.map((t) => ({ timestamp: t.timestamp })),
    });

    const mockLLM = createMockLLM({ generateResponse: 'A truthful narrative.' });
    const narrative = await generateNarrative(facts, chapters, mockLLM);

    // LLM generate was called
    expect(mockLLM.generate).toHaveBeenCalledTimes(1);

    // The prompt passed to generate should contain the EVOLUTION_STORY_PROMPT content
    const calledPrompt = (mockLLM.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const expectedPrompt = EVOLUTION_STORY_PROMPT(facts, chapters);
    expect(calledPrompt).toBe(expectedPrompt);

    // The prompt should contain key structural markers
    expect(calledPrompt).toContain('code archaeologist');
    expect(calledPrompt).toContain('Anti-hallucination');
    expect(calledPrompt).toContain('[commit:');

    // Returned narrative matches mock output
    expect(narrative).toBe('A truthful narrative.');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. generateNarrative returns LLM output
  // ─────────────────────────────────────────────────────────────────────

  it('generateNarrative returns exactly what LLM produced', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);
    const chapters = detectChapters({
      changeTimeline: facts.changeTimeline.map((t) => ({ timestamp: t.timestamp })),
    });

    const expectedNarrative = 'This function evolved from oldFunction through three commits.';
    const mockLLM = createMockLLM({ generateResponse: expectedNarrative });
    const result = await generateNarrative(facts, chapters, mockLLM);

    expect(result).toBe(expectedNarrative);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Anti-hallucination passes truthful narrative
  // ─────────────────────────────────────────────────────────────────────

  it('validateNarrative passes when narrative cites only real commits', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    // Narrative that only references real commit hashes
    const truthfulNarrative = `This symbol was created in [commit:${COMMIT_1}] and later refactored in [commit:${COMMIT_2}]. A bugfix followed in [commit:${COMMIT_3}].`;

    const issues = validateNarrative(truthfulNarrative, facts);
    expect(issues).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. Anti-hallucination catches fabricated hashes
  // ─────────────────────────────────────────────────────────────────────

  it('validateNarrative flags fabricated commit hashes', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    const fabricatedNarrative = `This symbol was created by [commit:deadbeef0000000000000000000000000000000a] and later changed by [commit:cafef00d0000000000000000000000000000000b].`;

    const issues = validateNarrative(fabricatedNarrative, facts);
    expect(issues.length).toBe(2); // Both hashes are fake
    expect(issues.every((i) => i.type === 'fabricated_commit')).toBe(true);

    // Check that the fabricated hashes are correctly extracted
    const flaggedHashes = issues.map((i) => i.hash);
    expect(flaggedHashes).toContain('deadbeef0000000000000000000000000000000a');
    expect(flaggedHashes).toContain('cafef00d0000000000000000000000000000000b');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. Anti-hallucination catches mixed real+fake
  // ─────────────────────────────────────────────────────────────────────

  it('validateNarrative flags only the fake hash in mixed real+fake narrative', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    // One real hash + one fake hash
    const mixedNarrative = `Real change in [commit:${COMMIT_1}] but fake one in [commit:aaaabbbbcccc0000000000000000000000000000].`;

    const issues = validateNarrative(mixedNarrative, facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('fabricated_commit');
    expect(issues[0].hash).toBe('aaaabbbbcccc0000000000000000000000000000');
    // The real hash should NOT be flagged
    const flaggedHashes = issues.map((i) => i.hash);
    expect(flaggedHashes).not.toContain(COMMIT_1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. Abbreviated hash matching (prefix match)
  // ─────────────────────────────────────────────────────────────────────

  it('validateNarrative accepts abbreviated 7-char hash prefix', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);

    // COMMIT_1 = 'a1b2c3d4e5f6...' → 7-char prefix = 'a1b2c3d'
    const abbreviated = COMMIT_1.substring(0, 7);
    const narrative = `Created in [commit:${abbreviated}].`;

    const issues = validateNarrative(narrative, facts);
    expect(issues).toHaveLength(0); // Should pass — prefix match
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. generateEvolutionStory end-to-end (WikiService)
  // ─────────────────────────────────────────────────────────────────────

  it('generateEvolutionStory returns WikiTopic with topicType=evolution', async () => {
    const truthfulNarrative = `This symbol was created in [commit:${COMMIT_1}] and evolved through [commit:${COMMIT_3}].`;
    const mockLLM = createMockLLM({ generateResponse: truthfulNarrative });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const topic = await service.generateEvolutionStory(projectId, funcNodeId);

    expect(topic).toBeDefined();
    expect(topic.topicType).toBe('evolution');
    expect(topic.title).toContain('演化史');
    expect(topic.content).toBe(truthfulNarrative);
    expect(topic.projectId).toBe(projectId);
    expect(topic.compiledAt).toBeDefined();

    // LLM was called (data is sufficient)
    expect(mockLLM.generate).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. WikiTopic persisted in graph store
  // ─────────────────────────────────────────────────────────────────────

  it('generateEvolutionStory persists topic retrievable via getTopic', async () => {
    const truthfulNarrative = `Evolution from [commit:${COMMIT_1}] to [commit:${COMMIT_2}].`;
    const mockLLM = createMockLLM({ generateResponse: truthfulNarrative });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const generated = await service.generateEvolutionStory(projectId, funcNodeId);

    // Retrieve via WikiService.getTopic
    const retrieved = await service.getTopic(projectId, generated.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(generated.id);
    expect(retrieved!.topicType).toBe('evolution');
    expect(retrieved!.content).toBe(truthfulNarrative);

    // Also retrieve via WikiGraph.getTopic directly
    const direct = await wikiGraph.getTopic(projectId, generated.id);
    expect(direct).not.toBeNull();
    expect(direct!.title).toContain('演化史');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. HTTP POST /api/wiki/evolution-story returns 200 + taskId
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/evolution-story returns 200 with taskId', async () => {
    const mockLLM = createMockLLM({ generateResponse: `Story with [commit:${COMMIT_1}].` });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId, nodeId: funcNodeId });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('taskId');
    expect(res.body).toHaveProperty('status', 'processing');
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.nodeId).toBe(funcNodeId);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 13. HTTP GET /api/wiki/evolution-story/:topicId returns content
  // ─────────────────────────────────────────────────────────────────────

  it('GET /api/wiki/evolution-story/:topicId returns stored topic', async () => {
    const narrative = `Final story citing [commit:${COMMIT_2}].`;
    const mockLLM = createMockLLM({ generateResponse: narrative });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    // First generate and store a topic
    const generated = await service.generateEvolutionStory(projectId, funcNodeId);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .get(`/api/wiki/evolution-story/${generated.id}`)
      .query({ projectId });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(generated.id);
    expect(res.body.topicType).toBe('evolution');
    expect(res.body.content).toBe(narrative);
    expect(res.body.title).toContain('演化史');
  });

  it('GET /api/wiki/evolution-story/:topicId returns 404 for non-existent topic', async () => {
    const mockLLM = createMockLLM({ generateResponse: 'placeholder' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .get('/api/wiki/evolution-story/non-existent-topic-id')
      .query({ projectId });

    expect(res.status).toBe(404);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 14. Data insufficient path (no CHANGED_IN edges)
  // ─────────────────────────────────────────────────────────────────────

  it('generateEvolutionStory returns insufficient-data topic without calling LLM', async () => {
    // emptyNodeId has no CHANGED_IN or EVOLVED_FROM edges
    const mockLLM = createMockLLM({ generateResponse: 'This should not be called.' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const topic = await service.generateEvolutionStory(projectId, emptyNodeId);

    expect(topic).toBeDefined();
    expect(topic.topicType).toBe('evolution');
    expect(topic.content).toContain('Insufficient data');
    expect(topic.content).toContain('no commits');

    // LLM should NOT have been called
    expect(mockLLM.generate).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 15. POST /api/wiki/evolution-story rejects missing params (400)
  // ─────────────────────────────────────────────────────────────────────

  it('POST /api/wiki/evolution-story rejects missing projectId with 400', async () => {
    const mockLLM = createMockLLM({ generateResponse: 'x' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ nodeId: funcNodeId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('projectId');
  });

  it('POST /api/wiki/evolution-story rejects missing nodeId with 400', async () => {
    const mockLLM = createMockLLM({ generateResponse: 'x' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .post('/api/wiki/evolution-story')
      .send({ projectId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('nodeId');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Boundary: edge cases
  // ─────────────────────────────────────────────────────────────────────

  it('validateNarrative with no [commit:] markers returns empty issues', async () => {
    const facts = await gatherEvolutionFacts(projectId, funcNodeId, graphStore);
    const narrativeWithNoCommits = 'This function was refactored for better performance.';
    const issues = validateNarrative(narrativeWithNoCommits, facts);
    expect(issues).toEqual([]);
  });

  it('GET /api/wiki/evolution-story/:topicId for non-existent projectId returns 404', async () => {
    const mockLLM = createMockLLM({ generateResponse: 'x' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRoutes(service));

    const res = await request(app)
      .get('/api/wiki/evolution-story/non-existent-topic')
      .query({ projectId: 'non-existent-project' });

    expect(res.status).toBe(404);
  });
});
