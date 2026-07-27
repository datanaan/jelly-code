import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockGraphQuery = vi.fn();
const mockGetEntity = vi.fn().mockResolvedValue(null);
const mockCreateEntity = vi.fn().mockResolvedValue(undefined);
const mockCreateCrossDomainEdges = vi.fn().mockResolvedValue(undefined);
const mockIndexEntity = vi.fn().mockResolvedValue(undefined);
const mockPoolGenerate = vi.fn().mockResolvedValue('mock LLM definition');

const stores = {
  graph: { query: mockGraphQuery },
} as any;

const wikiService = {
  getGraph: () => ({
    getEntity: mockGetEntity,
    createEntity: mockCreateEntity,
    createCrossDomainEdges: mockCreateCrossDomainEdges,
  }),
  indexEntity: mockIndexEntity,
} as any;

const pool = { generate: mockPoolGenerate } as any;

async function makeHandler(rules?: any) {
  const rulesConfig = rules ?? { enabled: true, rules: [], llmFallback: true };
  const mod = await import('../../src/worker/llm-worker.js');
  return mod.createLLMDerivationHandler({ stores, wikiService, pool, rules: rulesConfig });
}

describe('llm-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEntity.mockResolvedValue(null);
    mockPoolGenerate.mockResolvedValue('mock LLM definition');
  });

  it('processes a derivation job: calls deriveOne for each nodeId', async () => {
    const handler = await makeHandler();
    mockGraphQuery.mockResolvedValueOnce([
      { id: 'n1', name: 'fnA', type: 'Function', filePath: '/a.ts', content: 'export function fnA() {}' },
      { id: 'n2', name: 'fnB', type: 'Function', filePath: '/b.ts', content: 'export function fnB() {}' },
    ]);
    const job = {
      data: { projectId: 'p1', nodes: ['n1', 'n2'] },
      updateProgress: vi.fn(),
    } as any;
    const result = await handler(job);
    expect(result.processed).toBe(2);
    expect(mockCreateEntity).toHaveBeenCalledTimes(2);
  });

  it('single node failure does not abort the batch', async () => {
    // Second node's createEntity throws — simulate graph write failure
    let createCallIdx = 0;
    mockCreateEntity.mockImplementation(() => {
      createCallIdx++;
      if (createCallIdx === 2) return Promise.reject(new Error('node2-graph-write-fail'));
      return Promise.resolve(undefined);
    });
    const handler = await makeHandler();
    mockGraphQuery.mockResolvedValueOnce([
      { id: 'n1', name: 'a', type: 'Function', filePath: '/a', content: 'x' },
      { id: 'n2', name: 'b', type: 'Function', filePath: '/b', content: 'y' },
      { id: 'n3', name: 'c', type: 'Function', filePath: '/c', content: 'z' },
    ]);
    const job = { data: { projectId: 'p1', nodes: ['n1', 'n2', 'n3'] }, updateProgress: vi.fn() } as any;
    const result = await handler(job);
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(1);
  });

  it('empty nodeIds returns processed=0', async () => {
    const handler = await makeHandler();
    const job = { data: { projectId: 'p1', nodes: [] }, updateProgress: vi.fn() } as any;
    const result = await handler(job);
    expect(result.processed).toBe(0);
  });

  it('progress is updated per node', async () => {
    const handler = await makeHandler();
    mockGraphQuery.mockResolvedValueOnce([
      { id: 'n1', name: 'a', type: 'Function', filePath: '/a', content: 'x' },
    ]);
    const updateProgress = vi.fn();
    const job = { data: { projectId: 'p1', nodes: ['n1'] }, updateProgress } as any;
    await handler(job);
    expect(updateProgress).toHaveBeenCalled();
  });

  it('disabled rules returns skipped=nodes.length', async () => {
    const handler = await makeHandler({ enabled: false, rules: [] });
    const job = { data: { projectId: 'p1', nodes: ['n1'] }, updateProgress: vi.fn() } as any;
    const result = await handler(job);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
  });
});
