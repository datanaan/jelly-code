/**
 * Tests: FallbackLLMClient — primary/fallback LLM delegation
 *
 * Covers:
 * - Primary success path (no fallback needed)
 * - Primary failure → fallback activation (generate + generateJSON)
 * - Both primary and fallback failing
 * - Error messages propagated correctly
 *
 * LLM Fallback module has minimal test coverage before this file.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ILLMClient } from '../../src/llm/interface.js';

function createMockLLM(response?: string): ILLMClient {
  return {
    generate: vi.fn().mockResolvedValue(response ?? 'mock-llm'),
    generateJSON: vi.fn().mockResolvedValue(response ?? 'mock-json'),
  };
}

describe('FallbackLLMClient', () => {
  it('should use primary when it succeeds', async () => {
    const { FallbackLLMClient } = await import('../../src/llm/fallback.js');

    const primary = createMockLLM('primary response');
    const fallback = createMockLLM('fallback response');

    const client = new FallbackLLMClient(primary, fallback);

    const result = await client.generate('test prompt');
    expect(result).toBe('primary response');
    expect(primary.generate).toHaveBeenCalledWith('test prompt', undefined);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('should fallback to secondary when primary fails (generate)', async () => {
    const { FallbackLLMClient } = await import('../../src/llm/fallback.js');

    const primary = {
      generate: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      generateJSON: vi.fn(),
    } as ILLMClient;
    const fallback = createMockLLM('fallback text');

    const client = new FallbackLLMClient(primary, fallback);

    const result = await client.generate('test prompt');
    expect(result).toBe('fallback text');
    expect(fallback.generate).toHaveBeenCalledWith('test prompt', undefined);
  });

  it('should fallback to secondary when primary fails (generateJSON)', async () => {
    const { FallbackLLMClient } = await import('../../src/llm/fallback.js');

    const primary = {
      generate: vi.fn(),
      generateJSON: vi.fn().mockRejectedValue(new Error('JSON parse error')),
    } as ILLMClient;
    const fallback = {
      generate: vi.fn(),
      generateJSON: vi.fn().mockResolvedValue({ result: 'fallback json' }),
    } as ILLMClient;

    const client = new FallbackLLMClient(primary, fallback);

    const result = await client.generateJSON<Record<string, string>>('test prompt');
    expect(result).toEqual({ result: 'fallback json' });
    expect(fallback.generateJSON).toHaveBeenCalledWith('test prompt', undefined);
  });

  it('should propagate error when both primary and fallback fail', async () => {
    const { FallbackLLMClient } = await import('../../src/llm/fallback.js');

    const primary = {
      generate: vi.fn().mockRejectedValue(new Error('Primary down')),
      generateJSON: vi.fn(),
    } as ILLMClient;
    const fallback = {
      generate: vi.fn().mockRejectedValue(new Error('Fallback down too')),
      generateJSON: vi.fn(),
    } as ILLMClient;

    const client = new FallbackLLMClient(primary, fallback);

    await expect(client.generate('test')).rejects.toThrow('Fallback down too');
  });

  it('should pass LLMOptions to both primary and fallback', async () => {
    const { FallbackLLMClient } = await import('../../src/llm/fallback.js');

    const primary = {
      generate: vi.fn().mockRejectedValue(new Error('fail')),
      generateJSON: vi.fn(),
    } as ILLMClient;
    const fallback = createMockLLM('fallback');

    const client = new FallbackLLMClient(primary, fallback);
    const options = { model: 'qwen3:14b', temperature: 0.3 };

    await client.generate('test prompt', options);
    expect(fallback.generate).toHaveBeenCalledWith('test prompt', options);
  });

  it('should work with only one method implemented', async () => {
    const { FallbackLLMClient } = await import('../../src/llm/fallback.js');

    const primary = createMockLLM('primary');
    const fallback = {
      generate: vi.fn().mockResolvedValue('fallback'),
      generateJSON: vi.fn().mockRejectedValue(new Error('not implemented')),
    } as ILLMClient;

    const client = new FallbackLLMClient(primary, fallback);

    const text = await client.generate('prompt');
    expect(text).toBe('primary');

    const primaryCalls = vi.mocked(primary.generate).mock.calls.length;
    expect(primaryCalls).toBe(1);
  });
});
