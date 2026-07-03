/**
 * Unit Tests: LLM Ollama Adapter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaAdapter, extractJSON } from '../../src/llm/ollama.js';
import type { LLMConfig } from '../../src/llm/interface.js';

const mockConfig: LLMConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:14b',
  maxRetries: 3,
};

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

// ==========================================
// extractJSON
// ==========================================

describe('extractJSON', () => {
  it('extracts JSON from ```json code block', () => {
    const input = 'Here is the result:\n```json\n{"title": "test"}\n```\nDone.';
    expect(extractJSON(input)).toBe('{"title": "test"}');
  });

  it('extracts JSON from ``` code block without language', () => {
    const input = '```\n{"title": "test"}\n```';
    expect(extractJSON(input)).toBe('{"title": "test"}');
  });

  it('extracts JSON object from plain text', () => {
    const input = 'Some text {"title": "test", "items": [1, 2]} more text';
    expect(extractJSON(input)).toBe('{"title": "test", "items": [1, 2]}');
  });

  it('extracts JSON array from plain text', () => {
    const input = 'Result: [{"a": 1}, {"b": 2}] end';
    expect(JSON.parse(extractJSON(input))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns trimmed text as fallback', () => {
    const input = '{"title": "test"}';
    expect(extractJSON(input)).toBe('{"title": "test"}');
  });

  it('handles multi-line JSON in code block', () => {
    const input = '```json\n{\n  "title": "test",\n  "items": [1, 2]\n}\n```';
    const result = JSON.parse(extractJSON(input));
    expect(result.title).toBe('test');
    expect(result.items).toEqual([1, 2]);
  });
});

// ==========================================
// OllamaAdapter.generate
// ==========================================

describe('OllamaAdapter.generate', () => {
  it('calls Ollama API with correct parameters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: 'Hello world' }),
    });

    const adapter = new OllamaAdapter(mockConfig);
    const result = await adapter.generate('Say hello');

    expect(result).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"prompt":"Say hello"'),
      }),
    );
  });

  it('uses custom model from options', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: 'response' }),
    });

    const adapter = new OllamaAdapter(mockConfig);
    await adapter.generate('test', { model: 'custom-model' });

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe('custom-model');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const adapter = new OllamaAdapter(mockConfig);
    await expect(adapter.generate('test')).rejects.toThrow('Ollama API error (500)');
  });
});

// ==========================================
// OllamaAdapter.generateJSON
// ==========================================

describe('OllamaAdapter.generateJSON', () => {
  it('parses JSON from code block response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '```json\n{"title": "compiled", "entities": []}\n```' }),
    });

    const adapter = new OllamaAdapter(mockConfig);
    const result = await adapter.generateJSON<{ title: string; entities: unknown[] }>('compile this');

    expect(result.title).toBe('compiled');
    expect(result.entities).toEqual([]);
  });

  it('parses plain JSON response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"title": "plain", "count": 5}' }),
    });

    const adapter = new OllamaAdapter(mockConfig);
    const result = await adapter.generateJSON<{ title: string; count: number }>('test');

    expect(result.title).toBe('plain');
    expect(result.count).toBe(5);
  });

  it('retries on JSON parse failure', async () => {
    // First attempt: invalid JSON
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: 'not json at all' }),
    });
    // Second attempt: valid JSON
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"success": true}' }),
    });

    const adapter = new OllamaAdapter({ ...mockConfig, maxRetries: 3 });
    const result = await adapter.generateJSON<{ success: boolean }>('test');

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'not json' }),
    });

    const adapter = new OllamaAdapter({ ...mockConfig, maxRetries: 2 });
    await expect(adapter.generateJSON('test')).rejects.toThrow(
      'LLM JSON parse failed after 2 attempts',
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('respects maxRetries from options over config', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'not json' }),
    });

    const adapter = new OllamaAdapter({ ...mockConfig, maxRetries: 5 });
    await expect(adapter.generateJSON('test', { maxRetries: 1 })).rejects.toThrow(
      'LLM JSON parse failed after 1 attempts',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
