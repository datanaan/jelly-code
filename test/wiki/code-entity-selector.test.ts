/**
 * v1.3.0 Phase 3 T3-2: CodeEntitySelector tests.
 *
 * Tests:
 * - Rule priority order (exported_api before high_indegree)
 * - Deduplication (same node matched by multiple rules)
 * - maxEntitiesPerProject cap
 * - Nodes with existing WikiEntity excluded
 * - Empty rules → empty result
 * - selectNodesForChanges only queries changed files
 */

import { describe, it, expect, vi } from 'vitest';
import { CodeEntitySelector } from '../../src/wiki/code-entity-selector.js';
import type { IGraphStore } from '../../src/store/interfaces.js';
import type { DerivationRules } from '../../src/wiki/derivation-rules.js';

// ─── Mock Factory ────────────────────────────────────────────────

function createMockGraphStore(
  queryResults: Record<string, Record<string, unknown>[]> = {},
): IGraphStore {
  return {
    query: vi.fn(async (cypher: string, _params: Record<string, unknown>) => {
      // Check changedFiles query first (it also has isExported but we distinguish by changedFiles)
      if (cypher.includes('IN $changedFiles')) {
        return queryResults.changedFiles ?? [];
      }
      // Match based on Cypher content
      if (cypher.includes('isExported = true') && cypher.includes('CODE_RELATION')) {
        return queryResults.highInDegreeExported ?? [];
      }
      if (cypher.includes('isExported = true')) {
        return queryResults.exported ?? [];
      }
      if (cypher.includes('minInDegree') || cypher.includes('inDegree')) {
        return queryResults.highInDegree ?? [];
      }
      return [];
    }),
  } as unknown as IGraphStore;
}

// ─── Fixtures ────────────────────────────────────────────────────

const EXPORTED_RULES: DerivationRules = {
  enabled: true,
  rules: [
    {
      name: 'exported_api',
      filter: { has_exportModifier: true, type: ['Function', 'Class'] },
      priority: 1,
      maxPerProject: 100,
    },
  ],
  maxEntitiesPerProject: 200,
};

const MULTI_RULES: DerivationRules = {
  enabled: true,
  rules: [
    {
      name: 'exported_api',
      filter: { has_exportModifier: true, type: ['Function', 'Class'] },
      priority: 1,
      maxPerProject: 100,
    },
    {
      name: 'high_indegree',
      filter: { minInDegree: 5 },
      priority: 2,
      maxPerProject: 50,
    },
  ],
  maxEntitiesPerProject: 200,
};

// ─── Tests ───────────────────────────────────────────────────────

describe('CodeEntitySelector (v1.3.0 T3-2)', () => {

  it('selects exported nodes via exported_api rule', async () => {
    const store = createMockGraphStore({
      exported: [
        { id: 'n1', name: 'greet', type: 'Function', filePath: 'src/greet.ts', content: 'function greet() {}' },
        { id: 'n2', name: 'Foo', type: 'Class', filePath: 'src/foo.ts', content: 'class Foo {}' },
      ],
    });
    const selector = new CodeEntitySelector(EXPORTED_RULES, store);

    const nodes = await selector.selectNodes('proj-1');

    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('greet');
    expect(nodes[0].matchedRule).toBe('exported_api');
    expect(nodes[1].name).toBe('Foo');
  });

  it('deduplicates nodes matched by multiple rules', async () => {
    const store = createMockGraphStore({
      exported: [
        { id: 'n1', name: 'greet', type: 'Function', filePath: 'src/greet.ts' },
      ],
      highInDegree: [
        { id: 'n1', name: 'greet', type: 'Function', filePath: 'src/greet.ts', inDegree: 10 },
        { id: 'n2', name: 'helper', type: 'Function', filePath: 'src/helper.ts', inDegree: 7 },
      ],
    });
    const selector = new CodeEntitySelector(MULTI_RULES, store);

    const nodes = await selector.selectNodes('proj-1');

    // n1 should appear once (matched by exported_api, priority 1)
    // n2 should appear once (matched by high_indegree)
    expect(nodes).toHaveLength(2);
    const n1 = nodes.find(n => n.id === 'n1')!;
    expect(n1.matchedRule).toBe('exported_api');
  });

  it('respects maxEntitiesPerProject cap', async () => {
    const cappedRules: DerivationRules = {
      ...EXPORTED_RULES,
      maxEntitiesPerProject: 1,
    };
    const store = createMockGraphStore({
      exported: [
        { id: 'n1', name: 'a', type: 'Function', filePath: 'a.ts' },
        { id: 'n2', name: 'b', type: 'Function', filePath: 'b.ts' },
      ],
    });
    const selector = new CodeEntitySelector(cappedRules, store);

    const nodes = await selector.selectNodes('proj-1');
    expect(nodes).toHaveLength(1);
  });

  it('returns empty array when rules list is empty', async () => {
    const emptyRules: DerivationRules = { rules: [] };
    const store = createMockGraphStore();
    const selector = new CodeEntitySelector(emptyRules, store);

    const nodes = await selector.selectNodes('proj-1');
    expect(nodes).toEqual([]);
  });

  it('queries exclude nodes that already have active DESCRIBES edges', async () => {
    const store = createMockGraphStore({ exported: [] });
    const selector = new CodeEntitySelector(EXPORTED_RULES, store);

    await selector.selectNodes('proj-1');

    const [cypher] = (store.query as any).mock.calls[0];
    // CK: Cypher includes NOT EXISTS check for DESCRIBES edge
    expect(cypher).toContain('NOT EXISTS');
    expect(cypher).toContain('DESCRIBES');
    expect(cypher).toContain('valid_to IS NULL');
  });

  it('selectNodesForChanges only queries changed files', async () => {
    const store = createMockGraphStore({
      changedFiles: [
        { id: 'n1', name: 'changed', type: 'Function', filePath: 'src/changed.ts' },
      ],
    });
    const selector = new CodeEntitySelector(EXPORTED_RULES, store);

    const nodes = await selector.selectNodesForChanges('proj-1', ['src/changed.ts']);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('changed');

    const [cypher, params] = (store.query as any).mock.calls[0];
    expect(cypher).toContain('IN $changedFiles');
    expect(params.changedFiles).toEqual(['src/changed.ts']);
  });

  it('selectNodesForChanges returns empty for empty file list', async () => {
    const store = createMockGraphStore();
    const selector = new CodeEntitySelector(EXPORTED_RULES, store);

    const nodes = await selector.selectNodesForChanges('proj-1', []);
    expect(nodes).toEqual([]);
  });

  it('passes projectId to Cypher for isolation', async () => {
    const store = createMockGraphStore({ exported: [] });
    const selector = new CodeEntitySelector(EXPORTED_RULES, store);

    await selector.selectNodes('proj-42');

    const [, params] = (store.query as any).mock.calls[0];
    expect(params.projectId).toBe('proj-42');
  });
});
