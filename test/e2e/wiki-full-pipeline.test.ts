/**
 * E2E Test: Wiki Full Pipeline
 * Updated for ISSUE-002: all methods now require projectId
 *
 * Tests the complete wiki flow: WikiGraph CRUD → WikiSearch index/search →
 * WikiService.getIndex/status → relations → lint
 *
 * Prerequisites:
 * - Neo4j running on localhost:7687
 * - Typesense running on localhost:8108
 * - Qdrant running on localhost:6333
 *
 * Run with: npx vitest run test/e2e/wiki-full-pipeline.test.ts
 * Or with env: RUN_E2E=1 npx vitest run test/e2e/wiki-full-pipeline.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createStoreSet } from '../../src/store/factory.js';
import type { StoreSet } from '../../src/store/interfaces.js';
import { WikiGraph } from '../../src/wiki/graph.js';
import { WikiSearch } from '../../src/wiki/search.js';
import type {
  WikiSource,
  WikiEntity,
  WikiPageDoc,
} from '../../src/wiki/models.js';
import { skipE2E } from './helpers.js';

// ─── E2E gate ───────────────────────────────────────────────────────────────
// (skipE2E imported from helpers.ts — RUN_E2E=1 to enable)

const TEST_PREFIX = `wiki-e2e-${Date.now()}`;
const TEST_PROJECT = `e2e-project-${TEST_PREFIX}`;

describe.skipIf(skipE2E)('Wiki E2E', () => {
  let stores: StoreSet;
  let wikiGraph: WikiGraph;
  let wikiSearch: WikiSearch;

  beforeAll(async () => {
    const config = loadConfig();
    stores = createStoreSet(config);
    wikiGraph = new WikiGraph(stores.graph);
    wikiSearch = new WikiSearch(stores.search, stores.vector);

    await stores.graph.initializeSchema();
    await wikiSearch.initializeCollection();
  }, 30_000);

  afterAll(async () => {
    try {
      // Cleanup: remove all test wiki data from Neo4j (scoped by projectId)
      await stores.graph.query(
        `MATCH (n) WHERE n.projectId = $projectId DETACH DELETE n`,
        { projectId: TEST_PROJECT },
      );
    } catch {
      // Ignore cleanup errors
    }

    await stores.graph.close();
    await stores.search.close();
    await stores.vector.close();
  }, 15_000);

  describe('WikiGraph', () => {
    it('should create and read back a WikiSource', async () => {
      const source: WikiSource = {
        id: `source-${TEST_PREFIX}-arch`,
        projectId: TEST_PROJECT,
        title: 'Architecture Overview',
        sourcePath: '/docs/arch.md',
        summary: 'System architecture document',
        keyPoints: ['microservices', 'event-driven'],
        compiledAt: new Date().toISOString(),
      };

      await wikiGraph.createSource(source);

      const retrieved = await wikiGraph.getSource(TEST_PROJECT, source.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(source.id);
      expect(retrieved!.title).toBe('Architecture Overview');
      expect(retrieved!.keyPoints).toEqual(['microservices', 'event-driven']);
    });

    it('should create and read back a WikiEntity', async () => {
      const entity: WikiEntity = {
        id: `${TEST_PREFIX}-search-service`,
        projectId: TEST_PROJECT,
        name: 'SearchService',
        entityType: 'service',
        definition: 'Unified knowledge search routing service',
        details: 'Implements RRF fusion across Typesense and Qdrant backends',
        firstCompiled: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      };

      await wikiGraph.createEntity(entity);

      const retrieved = await wikiGraph.getEntity(TEST_PROJECT, entity.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('SearchService');
      expect(retrieved!.entityType).toBe('service');
      expect(retrieved!.definition).toContain('Unified knowledge');
    });

    it('should create relations between entities', async () => {
      const entityA: WikiEntity = {
        id: `${TEST_PREFIX}-entity-a`,
        projectId: TEST_PROJECT,
        name: 'EntityA',
        entityType: 'concept',
        definition: 'First test entity',
        details: 'Details for entity A',
        firstCompiled: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      };
      const entityB: WikiEntity = {
        id: `${TEST_PREFIX}-entity-b`,
        projectId: TEST_PROJECT,
        name: 'EntityB',
        entityType: 'concept',
        definition: 'Second test entity',
        details: 'Details for entity B',
        firstCompiled: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      };

      await wikiGraph.createEntity(entityA);
      await wikiGraph.createEntity(entityB);

      await wikiGraph.createLinksToRelation(TEST_PROJECT, entityA.id, entityB.id, 'depends on');

      const outgoing = await wikiGraph.getOutgoingLinks(TEST_PROJECT, entityA.id);
      expect(outgoing).toContain(entityB.id);

      const incoming = await wikiGraph.getIncomingLinks(TEST_PROJECT, entityB.id);
      expect(incoming).toContain(entityA.id);
    });
  });

  describe('WikiSearch', () => {
    it('should index and search a page', async () => {
      const embedding = Array.from({ length: 1024 }, (_, i) => (i % 10) * 0.01);

      const page: WikiPageDoc = {
        id: `${TEST_PREFIX}-search-test-entity`,
        projectId: TEST_PROJECT,
        pageType: 'entity',
        title: 'SearchTestEntity',
        content: 'A test entity for verifying wiki search indexing works correctly',
        entityType: 'concept',
        compiledAt: Math.floor(Date.now() / 1000),
      };

      await wikiSearch.indexPage(page, embedding);

      await new Promise(resolve => setTimeout(resolve, 500));

      const keywordResults = await wikiSearch.keywordSearch('SearchTestEntity', 5);
      expect(keywordResults.length).toBeGreaterThanOrEqual(1);
      expect(keywordResults[0].id).toBe(page.id);
    });
  });

  describe('WikiGraph Index', () => {
    it('should return correct index structure', async () => {
      const index = await wikiGraph.getIndex(TEST_PROJECT);

      expect(index).toHaveProperty('entities');
      expect(index).toHaveProperty('sources');
      expect(index).toHaveProperty('topics');
      expect(Array.isArray(index.entities)).toBe(true);
      expect(Array.isArray(index.sources)).toBe(true);
      expect(Array.isArray(index.topics)).toBe(true);

      for (const entity of index.entities) {
        expect(entity).toHaveProperty('id');
        expect(entity).toHaveProperty('name');
        expect(entity).toHaveProperty('type');
        expect(entity).toHaveProperty('linkCount');
        expect(typeof entity.linkCount).toBe('number');
      }

      for (const source of index.sources) {
        expect(source).toHaveProperty('id');
        expect(source).toHaveProperty('title');
        expect(source).toHaveProperty('entityCount');
        expect(typeof source.entityCount).toBe('number');
      }

      const testEntities = index.entities.filter(
        e => e.id.startsWith(TEST_PREFIX),
      );
      expect(testEntities.length).toBeGreaterThanOrEqual(2);
    });
  });
});
