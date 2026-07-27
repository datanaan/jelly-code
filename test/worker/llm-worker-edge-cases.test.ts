/**
 * CK-30: Worker 异常场景
 *
 * 验证：空节点列表、不存在的 node ID、空 projectId 时不 crash。
 */
import { describe, it, expect, vi } from 'vitest';
import { createLLMDerivationHandler } from '../../src/worker/llm-worker.js';
import { createMockLLM } from '../e2e/helpers.js';

function makeMockStore() {
  const query = vi.fn().mockResolvedValue([]);
  return {
    graph: { query },
    search: { search: vi.fn(), upsert: vi.fn(), deleteCollection: vi.fn() },
    vector: { upsert: vi.fn(), search: vi.fn(), deleteCollection: vi.fn() },
    llm: createMockLLM({ generateResponse: 'mock' }),
    close: vi.fn(),
  } as any;
}

const baseDeps = {
  stores: makeMockStore(),
  wikiService: { getGraph: () => ({ createEntity: vi.fn(), deleteEntity: vi.fn() }) } as any,
  pool: createMockLLM({ generateResponse: 'mock-def' }),
  rules: { enabled: true, rules: [], maxEntitiesPerProject: 100 },
};

describe('CK-30: worker 异常场景', () => {
  it('空节点列表 — 不 crash', async () => {
    const handler = createLLMDerivationHandler(baseDeps);
    const job = { data: { projectId: 'p1', nodes: [] }, updateProgress: vi.fn() } as any;
    const result = await handler(job);
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('不存在的 node ID — 不 crash', async () => {
    const deps = {
      ...baseDeps,
      stores: makeMockStore(),
    };
    const handler = createLLMDerivationHandler(deps);
    const job = { data: { projectId: 'p1', nodes: ['nonexistent-id-1'] }, updateProgress: vi.fn() } as any;
    const result = await handler(job);
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('空 projectId — 不 crash', async () => {
    const deps = {
      ...baseDeps,
      stores: makeMockStore(),
    };
    const handler = createLLMDerivationHandler(deps);
    const job = { data: { projectId: '', nodes: ['n1'] }, updateProgress: vi.fn() } as any;
    const result = await handler(job);
    // Should not throw — graph query with empty projectId returns 0 rows
    expect(result).toBeDefined();
  });
});
