/**
 * P0c-T4 data roundtrip regression: graph.ts codeSignature read/write
 *
 * This test closes the gap disclosed by the P0c-T4 implementer:
 * listEntities / getEntity / findEntityByName / updateEntity were missing
 * codeSignature from their RETURN and SET clauses, making the freshness
 * detector non-functional in production (signature never roundtripped).
 *
 * Strategy: In-memory mock IGraphStore that simulates Neo4j row format.
 * The mock stores WikiEntity rows as plain objects — mirroring how the
 * Neo4j JS driver deserializes structured properties (maps, not JSON strings).
 * When WikiGraph.createEntity writes `e.codeSignature = $codeSignature`,
 * the mock captures the full structured object and returns it verbatim on
 * subsequent MATCH queries.
 */

import { describe, it, expect, vi } from 'vitest';
import { WikiGraph } from '../../src/wiki/graph.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import type { WikiEntity, CodeSignature } from '../../src/wiki/models.js';

// ==========================================
// In-memory mock graph store
// ==========================================

interface StoredEntity {
  id: string;
  projectId: string;
  name: string;
  entity_type: string;
  definition: string;
  details: string;
  first_compiled: string;
  last_updated: string;
  codeSignature: CodeSignature | null;
}

/**
 * Simulates Neo4j behavior for WikiEntity nodes.
 * - MERGE + SET writes update the in-memory store.
 * - MATCH + RETURN reads produce rows matching what Neo4j would return.
 *
 * Key: Neo4j stores JS objects passed as params as structured properties.
 * When read back via RETURN e.codeSignature AS codeSignature, the value
 * comes back as a plain object — no JSON.parse needed.
 */
function createInMemoryStore(): IGraphStore & {
  _entities: Map<string, StoredEntity>;
} {
  const entities = new Map<string, StoredEntity>();

  const store = {
    _entities: entities,
    async query(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
      const isWrite = /\b(MERGE|CREATE|SET|DELETE|DETACH|REMOVE)\b/i.test(cypher);

      if (isWrite) {
        // ── createEntity: MERGE + SET ──
        if (cypher.includes('WikiEntity') && cypher.includes('MERGE')) {
          const key = `${params.projectId}:${params.id}`;
          const existing = entities.get(key as string) ?? {};
          entities.set(key as string, {
            ...existing,
            id: params.id as string,
            projectId: params.projectId as string,
            name: params.name as string,
            entity_type: params.entityType as string,
            definition: params.definition as string,
            details: params.details as string,
            first_compiled: params.firstCompiled as string,
            last_updated: params.lastUpdated as string,
            codeSignature: (params.codeSignature as CodeSignature | null) ?? null,
          });
          return [];
        }

        // ── updateEntity: MATCH + SET (conditional) ──
        if (cypher.includes('WikiEntity') && cypher.includes('SET') && !cypher.includes('MERGE')) {
          const key = `${params.projectId}:${params.id}`;
          const entity = entities.get(key as string);
          if (!entity) return [];

          if ('definition' in params) entity.definition = params.definition as string;
          if ('details' in params) entity.details = params.details as string;
          if ('lastUpdated' in params) entity.last_updated = params.lastUpdated as string;
          if ('name' in params) entity.name = params.name as string;
          if ('entityType' in params) entity.entity_type = params.entityType as string;
          if ('codeSignature' in params) {
            entity.codeSignature = (params.codeSignature as CodeSignature | null) ?? null;
          }
          return [];
        }

        // Other writes (sources, topics, relations, etc.) — no-op for these tests
        return [];
      }

      // ── Read queries ──
      if (cypher.includes('WikiEntity') && cypher.includes('RETURN')) {
        const projectId = params.projectId as string;

        // Filter entities by projectId
        let matching = Array.from(entities.values()).filter(e => e.projectId === projectId);

        // getEntity: WHERE e.id = $id
        if ('id' in params && cypher.includes('e.id = $id')) {
          matching = matching.filter(e => e.id === params.id);
        }

        // findEntityByName: WHERE (e.name = $name OR e.id = $name)
        if ('name' in params && cypher.includes('e.name = $name')) {
          matching = matching.filter(e => e.name === params.name || e.id === params.name);
        }

        // entityType filter
        if ('entityType' in params && cypher.includes('entity_type = $entityType')) {
          matching = matching.filter(e => e.entity_type === params.entityType);
        }

        // Sort by name (matching ORDER BY e.name)
        matching.sort((a, b) => a.name.localeCompare(b.name));

        // Return rows matching Neo4j RETURN clause format
        return matching.map(e => ({
          id: e.id,
          projectId: e.projectId,
          name: e.name,
          entityType: e.entity_type,
          definition: e.definition,
          details: e.details,
          firstCompiled: e.first_compiled,
          lastUpdated: e.last_updated,
          codeSignature: e.codeSignature, // structured object, just like Neo4j returns it
        }));
      }

      return [];
    },
    // Stubs for IGraphStore methods not used in these tests
    findSymbol: vi.fn(async () => []),
    initializeSchema: vi.fn(async () => {}),
    findSymbolByFile: vi.fn(async () => []),
    getNode: vi.fn(async () => null),
    getInboundRelations: vi.fn(async () => []),
    getOutboundRelations: vi.fn(async () => []),
    bfsTraverse: vi.fn(async () => ({ visited: [], edges: [], depths: new Map() })),
    findProcessesByNode: vi.fn(async () => []),
    findEntryPoint: vi.fn(async () => null),
    findCommunityByNode: vi.fn(async () => null),
    batchCreateNodes: vi.fn(async () => {}),
    batchCreateRelations: vi.fn(async () => {}),
    findNodeIdsByFilePath: vi.fn(async () => []),
    findNodeIdsByFilePaths: vi.fn(async () => new Map()),
    deleteNodesByFilePath: vi.fn(async () => []),
    deleteNodesByIds: vi.fn(async () => 0),
    clearProject: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };

  return store as unknown as IGraphStore & { _entities: Map<string, StoredEntity> };
}

// ==========================================
// Fixtures
// ==========================================

const PROJECT_ID = 'test-proj';

const SIG_A: CodeSignature = {
  entityName: 'greet',
  entityType: 'function',
  paramTypes: ['string'],
  returnType: 'string',
  signatureHash: 'abc123',
  astHash: 'def456',
};

const SIG_B: CodeSignature = {
  entityName: 'greet',
  entityType: 'function',
  paramTypes: ['string', 'string'],
  returnType: 'string',
  signatureHash: 'xyz789',
  astHash: 'uvw012',
};

function makeEntity(overrides: Partial<WikiEntity> & { id: string; name: string }): WikiEntity {
  return {
    projectId: PROJECT_ID,
    entityType: 'api',
    definition: 'test definition',
    details: 'test details',
    firstCompiled: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    ...overrides,
  } as WikiEntity;
}

// ==========================================
// Tests
// ==========================================

describe('graph.ts codeSignature roundtrip', () => {

  // ─── getEntity roundtrip ──────────────────────────────────

  it('getEntity: entity created with codeSignature → returned with full signature', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: SIG_A,
    });

    await graph.createEntity(entity);
    const result = await graph.getEntity(PROJECT_ID, 'entity-greet');

    expect(result).not.toBeNull();
    expect(result!.codeSignature).toBeDefined();
    expect(result!.codeSignature).toEqual(SIG_A);
    expect(result!.codeSignature!.signatureHash).toBe('abc123');
    expect(result!.codeSignature!.astHash).toBe('def456');
    expect(result!.codeSignature!.paramTypes).toEqual(['string']);
  });

  // ─── findEntityByName roundtrip ───────────────────────────

  it('findEntityByName: entity created with codeSignature → found with full signature', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: SIG_A,
    });

    await graph.createEntity(entity);
    const result = await graph.findEntityByName(PROJECT_ID, 'GreetEntity');

    expect(result).not.toBeNull();
    expect(result!.codeSignature).toBeDefined();
    expect(result!.codeSignature).toEqual(SIG_A);
    expect(result!.codeSignature!.entityName).toBe('greet');
    expect(result!.codeSignature!.returnType).toBe('string');
  });

  it('findEntityByName: finds by id alias too, returning codeSignature', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    const entity = makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: SIG_A,
    });

    await graph.createEntity(entity);
    // The query matches e.id = $name as well
    const result = await graph.findEntityByName(PROJECT_ID, 'entity-greet');

    expect(result).not.toBeNull();
    expect(result!.codeSignature).toEqual(SIG_A);
  });

  // ─── listEntities roundtrip ───────────────────────────────

  it('listEntities: returns codeSignature for each entity', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    await graph.createEntity(makeEntity({
      id: 'entity-a',
      name: 'AlphaEntity',
      codeSignature: SIG_A,
    }));
    await graph.createEntity(makeEntity({
      id: 'entity-b',
      name: 'BetaEntity',
      codeSignature: SIG_B,
    }));
    // Entity without codeSignature (null)
    await graph.createEntity(makeEntity({
      id: 'entity-c',
      name: 'GammaEntity',
      codeSignature: null,
    }));

    const results = await graph.listEntities(PROJECT_ID);

    expect(results).toHaveLength(3);
    // Sorted by name: Alpha, Beta, Gamma
    expect(results[0].name).toBe('AlphaEntity');
    expect(results[0].codeSignature).toEqual(SIG_A);

    expect(results[1].name).toBe('BetaEntity');
    expect(results[1].codeSignature).toEqual(SIG_B);

    expect(results[2].name).toBe('GammaEntity');
    // null becomes undefined per our mapping (codeSignature ?? undefined)
    expect(results[2].codeSignature).toBeUndefined();
  });

  // ─── updateEntity roundtrip ───────────────────────────────

  it('updateEntity: changing codeSignature → subsequent getEntity returns new value', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    // Create with SIG_A
    await graph.createEntity(makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: SIG_A,
    }));

    // Verify initial state
    const before = await graph.getEntity(PROJECT_ID, 'entity-greet');
    expect(before!.codeSignature).toEqual(SIG_A);

    // Update to SIG_B (code signature changed after source code modified)
    await graph.updateEntity(PROJECT_ID, 'entity-greet', {
      codeSignature: SIG_B,
      lastUpdated: '2026-06-22T12:00:00Z',
    });

    // Verify new state
    const after = await graph.getEntity(PROJECT_ID, 'entity-greet');
    expect(after!.codeSignature).toEqual(SIG_B);
    expect(after!.codeSignature!.signatureHash).toBe('xyz789');
    expect(after!.codeSignature!.paramTypes).toEqual(['string', 'string']);
    expect(after!.lastUpdated).toBe('2026-06-22T12:00:00Z');
  });

  it('updateEntity: setting codeSignature to null → subsequent getEntity returns undefined', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    await graph.createEntity(makeEntity({
      id: 'entity-greet',
      name: 'GreetEntity',
      codeSignature: SIG_A,
    }));

    // Explicitly unbind
    await graph.updateEntity(PROJECT_ID, 'entity-greet', {
      codeSignature: null,
    });

    const result = await graph.getEntity(PROJECT_ID, 'entity-greet');
    expect(result!.codeSignature).toBeUndefined();
  });

  // ─── RETURN clause verification ───────────────────────────

  it('getEntity query includes codeSignature in RETURN clause', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    // Spy on query to capture cypher
    const querySpy = vi.spyOn(store, 'query');

    await graph.getEntity(PROJECT_ID, 'entity-x');

    const readCall = querySpy.mock.calls.find(
      ([cypher]) => typeof cypher === 'string' && cypher.includes('MATCH (e:WikiEntity)') && cypher.includes('RETURN'),
    );
    expect(readCall).toBeDefined();
    expect(readCall![0]).toContain('e.codeSignature AS codeSignature');
  });

  it('findEntityByName query includes codeSignature in RETURN clause', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    const querySpy = vi.spyOn(store, 'query');

    await graph.findEntityByName(PROJECT_ID, 'TestEntity');

    const readCall = querySpy.mock.calls.find(
      ([cypher]) => typeof cypher === 'string' && cypher.includes('e.name = $name'),
    );
    expect(readCall).toBeDefined();
    expect(readCall![0]).toContain('e.codeSignature AS codeSignature');
  });

  it('listEntities query includes codeSignature in RETURN clause', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    const querySpy = vi.spyOn(store, 'query');

    await graph.listEntities(PROJECT_ID);

    const readCall = querySpy.mock.calls.find(
      ([cypher]) => typeof cypher === 'string' && cypher.includes('ORDER BY e.name'),
    );
    expect(readCall).toBeDefined();
    expect(readCall![0]).toContain('e.codeSignature AS codeSignature');
  });

  it('updateEntity writes codeSignature SET clause when provided', async () => {
    const store = createInMemoryStore();
    const graph = new WikiGraph(store);

    // Pre-create entity
    await graph.createEntity(makeEntity({
      id: 'entity-x',
      name: 'X',
      codeSignature: SIG_A,
    }));

    const querySpy = vi.spyOn(store, 'query');

    await graph.updateEntity(PROJECT_ID, 'entity-x', {
      codeSignature: SIG_B,
    });

    const writeCall = querySpy.mock.calls.find(
      ([cypher]) => typeof cypher === 'string' && cypher.includes('SET') && !cypher.includes('MERGE'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall![0]).toContain('e.codeSignature = $codeSignature');
  });
});
