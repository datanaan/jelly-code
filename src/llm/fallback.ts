/**
 * Fallback LLM adapter — tries primary backend, falls back to secondary on error.
 *
 * Usage:
 *   Primary:  OpenAI-compatible API (e.g. Coding Plan cloud LLM)
 *   Fallback: Ollama local instance
 */

import type { ILLMClient, LLMOptions } from './interface.js';

export class FallbackLLMClient implements ILLMClient {
  constructor(
    private primary: ILLMClient,
    private fallback: ILLMClient,
  ) {}

  async generate(prompt: string, options?: LLMOptions): Promise<string> {
    try {
      return await this.primary.generate(prompt, options);
    } catch (err) {
      console.warn('[llm] Primary LLM failed, falling back:', err instanceof Error ? err.message : err);
      return this.fallback.generate(prompt, options);
    }
  }

  async generateJSON<T>(prompt: string, options?: LLMOptions): Promise<T> {
    try {
      return await this.primary.generateJSON<T>(prompt, options);
    } catch (err) {
      console.warn('[llm] Primary LLM failed (JSON), falling back:', err instanceof Error ? err.message : err);
      return this.fallback.generateJSON<T>(prompt, options);
    }
  }
}
