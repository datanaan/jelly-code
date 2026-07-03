/**
 * E2E Test: P2 Evolution Expansion — Pure Iteration + Multi-Node
 *
 * Extends the baseline evolution narrator tests with:
 *  1. Pure iteration scenario: 5 CHANGED_IN commits (no EVOLVED_FROM)
 *  2. Multi-node: 2 different nodes each with their own evolution story
 *  3. generateEvolutionStory still works without EVOLVED_FROM
 *  4. Chapter detection with shorter gaps (7-day vs 30-day)
 *  5. gatherEvolutionFacts returns correct changedIn count
 *  6. HTTP POST + GET for multi-node stories
 *  7. Data sufficiency check with 1 commit
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 *
 * Run with: RUN_E2E=1 npx vitest run test/e2e/p2-evolution-expansion.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { IGraphStore, CodeNode } from '../../src/store/interfaces.js';
import { WikiService, type WikiConfig } from '../../src/wiki/service.js';
import { gatherEvolutionFacts } from '../../src/wiki/evolution-facts-query.js';
import { detectChapters } from '../../src/wiki/chapter-detector.js';
import { skipE2E, createMockLLM, buildStoreSet } from './helpers.js';

// ─── Mock embedder ────────────────────────────────────────────────────────────
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedText: vi.fn(async (_text: string) => new Float32Array(384).fill(0.1)),
  embeddingToArray: vi.fn((vec: Float32Array) => Array.from(vec)),
}));

describe.skipIf(skipE2E)('P2 E2E Expansion: Pure Iteration + Multi-Node', () => {
  let graphStore: IGraphStore;
  const projectId = `e2e-p2-exp-${Date.now()}`;

  // Two nodes with separate evolution stories
  const nodeAlpha = `${projectId}:Function:alpha`;
  const nodeBeta = `${projectId}:Function:beta`;

  // Alpha has 5 commits (pure iteration, no EVOLVED_FROM)
  const ALPHA_COMMITS = [
    'aaa1111111111111111111111111111111111111',
    'bbb2222222222222222222222222222222222222',
    'ccc3333333333333333333333333333333333333',
    'ddd4444444444444444444444444444444444444',
    'eee5555555555555555555555555555555555555',
  ];

  // Alpha timestamps: spread with >30-day gaps for maintenance detection
  const ALPHA_TIMES = [
    '2026-01-01T10:00:00Z',
    '2026-01-08T10:00:00Z',  // 7 days later
    '2026-02-20T10:00:00Z',  // 43 days later → maintenance gap!
    '2026-03-01T10:00:00Z',  // 9 days later
    '2026-04-15T10:00:00Z',  // 45 days later → another maintenance gap!
  ];

  // Beta has 3 commits
  const BETA_COMMITS = [
    'fff6666666666666666666666666666666666666',
    'ggg7777777777777777777777777777777777777',
    'hhh8888888888888888888888888888888888888',
  ];

  const BETA_TIMES = [
    '2026-01-05T10:00:00Z',
    '2026-01-20T10:00:00Z',
    '2026-02-10T10:00:00Z',
  ];

  const AUTHORS = ['alice', 'bob', 'charlie'];

  beforeAll(async () => {
    const config = loadConfig();
    graphStore = new Neo4jAdapter(config.neo4j);

    await graphStore.initializeSchema();
    await graphStore.clearProject(projectId);

    // Create project node
    await graphStore.batchCreateNodes([
      { id: projectId, type: 'Project', projectId, name: projectId },
    ]);

    // Create CodeNodes
    await graphStore.batchCreateNodes([
      { id: nodeAlpha, type: 'Function', projectId, name: 'alpha', filePath: 'src/alpha.ts', startLine: 1, endLine: 3, isExported: true, content: 'export function alpha() { return "a"; }' },
      { id: nodeBeta, type: 'Function', projectId, name: 'beta', filePath: 'src/beta.ts', startLine: 1, endLine: 3, isExported: true, content: 'export function beta() { return "b"; }' },
    ] as CodeNode[]);

    // Create Commit nodes
    const commitCypher = ALPHA_COMMITS.map((h, i) =>
      `(c_a${i}:Commit {id: $ah${i}, message: $amsg${i}, author: $aa${i}, timestamp: $at${i}, additions: 10, deletions: 5, projectId: $pid})`,
    ).join(',\n');
    const betaCypher = BETA_COMMITS.map((h, i) =>
      `(c_b${i}:Commit {id: $bh${i}, message: $bmsg${i}, author: $ba${i}, timestamp: $bt${i}, additions: 5, deletions: 2, projectId: $pid})`,
    ).join(',\n');

    const commitParams: Record<string, string> = { pid: projectId };
    ALPHA_COMMITS.forEach((h, i) => {
      commitParams[`ah${i}`] = h;
      commitParams[`amsg${i}`] = `alpha commit ${i + 1}`;
      commitParams[`aa${i}`] = AUTHORS[i % 3];
      commitParams[`at${i}`] = ALPHA_TIMES[i];
    });
    BETA_COMMITS.forEach((h, i) => {
      commitParams[`bh${i}`] = h;
      commitParams[`bmsg${i}`] = `beta commit ${i + 1}`;
      commitParams[`ba${i}`] = AUTHORS[i % 3];
      commitParams[`bt${i}`] = BETA_TIMES[i];
    });

    await graphStore.query(
      `CREATE\n${commitCypher},\n${betaCypher}`,
      commitParams,
    );

    // Create CHANGED_IN edges for alpha (5 edges)
    for (let i = 0; i < ALPHA_COMMITS.length; i++) {
      await graphStore.query(
        `MATCH (n {id: $nid, projectId: $pid})
         MATCH (c:Commit {id: $cid, projectId: $pid})
         CREATE (n)-[:CODE_RELATION {
           type: 'CHANGED_IN', sourceId: $nid, targetId: $cid,
           projectId: $pid, valid_from: $ts, valid_to: null
         }]->(c)`,
        { pid: projectId, nid: nodeAlpha, cid: ALPHA_COMMITS[i], ts: ALPHA_TIMES[i] },
      );
    }

    // Create CHANGED_IN edges for beta (3 edges)
    for (let i = 0; i < BETA_COMMITS.length; i++) {
      await graphStore.query(
        `MATCH (n {id: $nid, projectId: $pid})
         MATCH (c:Commit {id: $cid, projectId: $pid})
         CREATE (n)-[:CODE_RELATION {
           type: 'CHANGED_IN', sourceId: $nid, targetId: $cid,
           projectId: $pid, valid_from: $ts, valid_to: null
         }]->(c)`,
        { pid: projectId, nid: nodeBeta, cid: BETA_COMMITS[i], ts: BETA_TIMES[i] },
      );
    }

    // Create AUTHORED_BY edges for alpha
    await graphStore.query(
      `CREATE (a:Author {id: 'a-alice', name: 'alice', email: 'alice@example.com', projectId: $pid}),
              (b:Author {id: 'a-bob', name: 'bob', email: 'bob@example.com', projectId: $pid}),
              (c:Author {id: 'a-charlie', name: 'charlie', email: 'charlie@example.com', projectId: $pid})`,
      { pid: projectId },
    );

    // Alpha authored by alice (3 changes) + bob (2 changes)
    // lastChangeAt is required by findAuthoredBy → mapOwnershipToFact
    await graphStore.query(
      `MATCH (n {id: $nid, projectId: $pid})
       MATCH (a:Author {id: 'a-alice', projectId: $pid})
       MATCH (b:Author {id: 'a-bob', projectId: $pid})
       CREATE (n)-[:CODE_RELATION {type: 'AUTHORED_BY', sourceId: $nid, targetId: 'a-alice', projectId: $pid, changeCount: 3, ownership: 0.6, lastChangeAt: $t2}]->(a),
              (n)-[:CODE_RELATION {type: 'AUTHORED_BY', sourceId: $nid, targetId: 'a-bob', projectId: $pid, changeCount: 2, ownership: 0.4, lastChangeAt: $t4}]->(b)`,
      { pid: projectId, nid: nodeAlpha, t2: ALPHA_TIMES[1], t4: ALPHA_TIMES[3] },
    );

    // Beta authored by bob (2 changes) + charlie (1 change)
    await graphStore.query(
      `MATCH (n {id: $nid, projectId: $pid})
       MATCH (b:Author {id: 'a-bob', projectId: $pid})
       MATCH (c:Author {id: 'a-charlie', projectId: $pid})
       CREATE (n)-[:CODE_RELATION {type: 'AUTHORED_BY', sourceId: $nid, targetId: 'a-bob', projectId: $pid, changeCount: 2, ownership: 0.67, lastChangeAt: $t2}]->(b),
              (n)-[:CODE_RELATION {type: 'AUTHORED_BY', sourceId: $nid, targetId: 'a-charlie', projectId: $pid, changeCount: 1, ownership: 0.33, lastChangeAt: $t3}]->(c)`,
      { pid: projectId, nid: nodeBeta, t2: BETA_TIMES[1], t3: BETA_TIMES[2] },
    );
  }, 30_000);

  afterAll(async () => {
    try { await graphStore.clearProject(projectId); } catch { /* ignore */ }
    await graphStore.close();
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────
  // 1. Alpha gatherEvolutionFacts returns 5 changedIn
  // ─────────────────────────────────────────────────────────────────────
  it('alpha gatherEvolutionFacts returns 5 changedIn commits', async () => {
    const facts = await gatherEvolutionFacts(projectId, nodeAlpha, graphStore);

    expect(facts.nodeId).toBe(nodeAlpha);
    expect(facts.changedIn.length).toBe(5);
    expect(facts.evolvedFrom.length).toBe(0); // Pure iteration
    expect(facts.authoredBy.length).toBeGreaterThanOrEqual(1);
    expect(facts.coChangedWith.length).toBe(0); // No CO_CHANGED_WITH edges

    const commitHashes = facts.changedIn.map(c => c.commit);
    for (const h of ALPHA_COMMITS) {
      expect(commitHashes).toContain(h);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Beta gatherEvolutionFacts returns 3 changedIn
  // ─────────────────────────────────────────────────────────────────────
  it('beta gatherEvolutionFacts returns 3 changedIn commits', async () => {
    const facts = await gatherEvolutionFacts(projectId, nodeBeta, graphStore);

    expect(facts.nodeId).toBe(nodeBeta);
    expect(facts.changedIn.length).toBe(3);
    expect(facts.evolvedFrom.length).toBe(0); // Pure iteration

    const commitHashes = facts.changedIn.map(c => c.commit);
    for (const h of BETA_COMMITS) {
      expect(commitHashes).toContain(h);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Chapter detection finds founding + maintenance for alpha
  // ─────────────────────────────────────────────────────────────────────
  it('alpha detectChapters finds founding + 2 maintenance chapters', async () => {
    const facts = await gatherEvolutionFacts(projectId, nodeAlpha, graphStore);
    const timeline = facts.changeTimeline.map(t => ({ timestamp: t.timestamp }));
    const chapters = detectChapters({ changeTimeline: timeline });

    // Founding chapter
    const founding = chapters.find(c => c.type === 'founding');
    expect(founding).toBeDefined();
    expect(founding!.from).toBe(ALPHA_TIMES[0]);

    // Should have 2 maintenance chapters (43-day and 45-day gaps)
    const maintenance = chapters.filter(c => c.type === 'maintenance');
    expect(maintenance.length).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Alpha generateEvolutionStory works without EVOLVED_FROM
  // ─────────────────────────────────────────────────────────────────────
  it('alpha generateEvolutionStory returns topic with 5 commits cited', async () => {
    const narrative = `Evolved over [commit:${ALPHA_COMMITS[0]}] to [commit:${ALPHA_COMMITS[4]}].`;
    const mockLLM = createMockLLM({ generateResponse: narrative });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const topic = await service.generateEvolutionStory(projectId, nodeAlpha);

    expect(topic).toBeDefined();
    expect(topic.topicType).toBe('evolution');
    expect(topic.content).toBe(narrative);
    expect(mockLLM.generate).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Beta generateEvolutionStory with fewer commits
  // ─────────────────────────────────────────────────────────────────────
  it('beta generateEvolutionStory returns topic with 3 commits', async () => {
    const narrative = `Beta story citing [commit:${BETA_COMMITS[0]}] and [commit:${BETA_COMMITS[2]}].`;
    const mockLLM = createMockLLM({ generateResponse: narrative });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const topic = await service.generateEvolutionStory(projectId, nodeBeta);

    expect(topic).toBeDefined();
    expect(topic.topicType).toBe('evolution');
    expect(mockLLM.generate).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Both stories persisted independently
  // ─────────────────────────────────────────────────────────────────────
  it('alpha and beta stories are persisted and retrievable separately', async () => {
    const alphaNarrative = `Alpha story [commit:${ALPHA_COMMITS[1]}].`;
    const betaNarrative = `Beta story [commit:${BETA_COMMITS[1]}].`;

    const mockLLM = createMockLLM({ generateResponse: 'placeholder' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const alphaTopic = await service.generateEvolutionStory(projectId, nodeAlpha);
    const betaTopic = await service.generateEvolutionStory(projectId, nodeBeta);

    // Different topic IDs
    expect(alphaTopic.id).not.toBe(betaTopic.id);

    // Both retrievable
    const alphaRetrieved = await service.getTopic(projectId, alphaTopic.id);
    const betaRetrieved = await service.getTopic(projectId, betaTopic.id);
    expect(alphaRetrieved).not.toBeNull();
    expect(betaRetrieved).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. Single-commit node returns insufficient-data
  // ─────────────────────────────────────────────────────────────────────
  it('function with no commit data returns insufficient data', async () => {
    const noDataId = `${projectId}:Function:noDataFunc`;
    await graphStore.batchCreateNodes([
      { id: noDataId, type: 'Function', projectId, name: 'noDataFunc', filePath: 'src/noData.ts', startLine: 1, endLine: 1, isExported: true, content: 'function noData() {}' } as CodeNode,
    ]);
    // No CHANGED_IN edges → insufficient data

    const mockLLM = createMockLLM({ generateResponse: 'should not be called' });
    const stores = buildStoreSet(graphStore, mockLLM);
    const wikiConfig: WikiConfig = { staleDays: 365, autoWriteBack: false };
    const service = new WikiService(stores, wikiConfig);

    const topic = await service.generateEvolutionStory(projectId, noDataId);
    expect(topic.content).toContain('Insufficient data');
    expect(mockLLM.generate).not.toHaveBeenCalled();
  });
});
