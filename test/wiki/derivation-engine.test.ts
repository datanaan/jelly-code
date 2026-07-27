/**
 * v1.3.0 Phase 3 T3-3: WikiDerivationEngine tests.
 *
 * Tests:
 * - Creates WikiEntity with provenance='auto-derived'
 * - Entity id includes filePath (D5 uniqueness)
 * - LLM available → definition from LLM
 * - LLM unavailable → definition from fallback template (D8)
 * - Fallback template does NOT contain "See code signature for details" (CK-8)
 * - DESCRIBES cross-domain edge written
 * - Does NOT overwrite manual entities (CK-6)
 * - enabled=false → skip derivation (T3-1b / CK-14)
 * - enabled absent → defaults to true (CK-15)
 * - Search index written via WikiService.indexEntity (D9)
 */

import { describe, it, expect, vi } from 'vitest';
import { WikiDerivationEngine } from '../../src/wiki/derivation-engine.js';
import type { WikiService } from '../../src/wiki/service.js';
import type { WikiGraph } from '../../src/wiki/graph.js';
import type { ILLMClient } from '../../src/llm/interface.js';
import type { DerivationRules } from '../../src/wiki/derivation-rules.js';
import type { SelectedNode } from '../../src/wiki/code-entity-selector.js';

// ─── Mock Factories ──────────────────────────────────────────────

function createMockWikiGraph(): WikiGraph {
  return {
    getEntity: vi.fn().mockResolvedValue(null), // no existing entity by default
    createEntity: vi.fn().mockResolvedValue(undefined),
    createCrossDomainEdges: vi.fn().mockResolvedValue(undefined),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    deleteEntity: vi.fn().mockResolvedValue(undefined),
    listEntities: vi.fn().mockResolvedValue([]),
    listEntitiesByProvenance: vi.fn().mockResolvedValue([]),
    findOrphanedEntities: vi.fn().mockResolvedValue([]),
    findDocumentedCodeNodes: vi.fn().mockResolvedValue([]),
  } as unknown as WikiGraph;
}

function createMockWikiService(graph?: WikiGraph): WikiService {
  const mockGraph = graph ?? createMockWikiGraph();
  return {
    getGraph: vi.fn().mockReturnValue(mockGraph),
    indexEntity: vi.fn().mockResolvedValue(undefined),
  } as unknown as WikiService;
}

function createMockLLM(response?: string): ILLMClient {
  return {
    generate: vi.fn().mockResolvedValue(response ?? 'A greeting function that says hello.'),
    generateJSON: vi.fn().mockResolvedValue({}),
  } as unknown as ILLMClient;
}

const DEFAULT_RULES: DerivationRules = {
  enabled: true,
  rules: [],
  llmFallback: true,
  llmFallbackDefinition: 'Exported {type} {name} in {filePath}. Signature: {signature}.',
};

const SAMPLE_NODE: SelectedNode = {
  id: 'code-greet-1',
  name: 'greet',
  type: 'Function',
  filePath: 'src/greet.ts',
  content: 'function greet(name: string): string { return "Hello, " + name; }',
  matchedRule: 'exported_api',
};

// ─── Tests ───────────────────────────────────────────────────────

describe('WikiDerivationEngine (v1.3.0 T3-3)', () => {

  it('creates WikiEntity with provenance=auto-derived', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    const result = await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    expect(result.derived).toBe(1);
    expect(graph.createEntity).toHaveBeenCalledTimes(1);
    const entity = (graph.createEntity as any).mock.calls[0][0];
    expect(entity.provenance).toBe('auto-derived');
    expect(entity.derivedAt).toBeDefined();
  });

  it('CK-11: entity id includes filePath for uniqueness (D5)', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    const entity = (graph.createEntity as any).mock.calls[0][0];
    expect(entity.id).toContain('src/greet.ts');
    expect(entity.id).toContain(':greet');
    expect(entity.id).toMatch(/^auto-/);
    // Full id: "auto-src/greet.ts:greet"
    expect(entity.id).toBe('auto-src/greet.ts:greet');
  });

  it('LLM available → definition from LLM', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const llm = createMockLLM('Returns a personalized greeting message.');
    const engine = new WikiDerivationEngine(wikiService, llm, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    const entity = (graph.createEntity as any).mock.calls[0][0];
    expect(entity.definition).toBe('Returns a personalized greeting message.');
  });

  it('LLM unavailable → definition from fallback template (D8)', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    // No LLM client provided
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    const entity = (graph.createEntity as any).mock.calls[0][0];
    expect(entity.definition).toContain('greet');
    expect(entity.definition).toContain('Function');
    expect(entity.definition).toContain('src/greet.ts');
  });

  it('CK-8: fallback template does NOT contain "See code signature for details"', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    const entity = (graph.createEntity as any).mock.calls[0][0];
    expect(entity.definition).not.toContain('See code signature for details');
    expect(entity.definition).not.toContain('See code signature');
  });

  it('definition is never empty string (CK-1)', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    const entity = (graph.createEntity as any).mock.calls[0][0];
    expect(entity.definition.length).toBeGreaterThan(20);
  });

  it('writes DESCRIBES cross-domain edge', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    expect(graph.createCrossDomainEdges).toHaveBeenCalledWith(
      'proj-1',
      'auto-src/greet.ts:greet',
      'code-greet-1',
    );
  });

  it('CK-6: does NOT overwrite manual entities', async () => {
    const graph = createMockWikiGraph();
    graph.getEntity = vi.fn().mockResolvedValue({
      id: 'auto-src/greet.ts:greet',
      name: 'greet',
      provenance: 'manual',
      definition: 'Human-written definition that must not be overwritten.',
    });
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    const result = await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    expect(result.derived).toBe(0);
    expect(graph.createEntity).not.toHaveBeenCalled();
    expect(graph.createCrossDomainEdges).not.toHaveBeenCalled();
  });

  it('CK-14: enabled=false → skip derivation entirely (T3-1b)', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const disabledRules: DerivationRules = { ...DEFAULT_RULES, enabled: false };
    const engine = new WikiDerivationEngine(wikiService, undefined, disabledRules);

    const result = await engine.deriveEntities('proj-1', [SAMPLE_NODE, SAMPLE_NODE]);

    expect(result.derived).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.reason).toContain('disabled');
    expect(graph.createEntity).not.toHaveBeenCalled();
    expect(graph.createCrossDomainEdges).not.toHaveBeenCalled();
  });

  it('CK-15: absent enabled field → defaults to true (backward compat)', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const noEnabledField: DerivationRules = {
      rules: [],
      llmFallbackDefinition: 'Exported {type} {name}.',
    };
    const engine = new WikiDerivationEngine(wikiService, undefined, noEnabledField);

    const result = await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    expect(result.derived).toBe(1);
    expect(graph.createEntity).toHaveBeenCalled();
  });

  it('D9: search index written via WikiService.indexEntity', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    await engine.deriveEntities('proj-1', [SAMPLE_NODE]);

    expect(wikiService.indexEntity).toHaveBeenCalledWith(
      'proj-1',
      'auto-src/greet.ts:greet',
      'greet',
      expect.any(String),
      expect.any(String),
    );
  });

  it('handles multiple nodes and reports counts', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    const nodes: SelectedNode[] = [
      { id: 'n1', name: 'foo', type: 'Function', filePath: 'a.ts', content: 'function foo() {}' },
      { id: 'n2', name: 'bar', type: 'Class', filePath: 'b.ts', content: 'class Bar {}' },
      { id: 'n3', name: 'baz', type: 'Function', filePath: 'c.ts', content: 'function baz() {}' },
    ];

    const result = await engine.deriveEntities('proj-1', nodes);

    expect(result.derived).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(graph.createEntity).toHaveBeenCalledTimes(3);
  });

  it('empty node list → derived=0, no errors', async () => {
    const graph = createMockWikiGraph();
    const wikiService = createMockWikiService(graph);
    const engine = new WikiDerivationEngine(wikiService, undefined, DEFAULT_RULES);

    const result = await engine.deriveEntities('proj-1', []);

    expect(result.derived).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
