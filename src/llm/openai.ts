/**
 * OpenAI-compatible LLM adapter for jelly_code.
 *
 * Uses OpenAI chat completions API (works with any compatible provider).
 * Supports text generation and structured JSON output with automatic retry.
 */

import type { ILLMClient, LLMConfig, LLMOptions } from './interface.js';
import { extractJSON } from './ollama.js';

export class OpenAIAdapter implements ILLMClient {
  private readonly timeoutMs: number;

  constructor(private config: LLMConfig) {
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async generate(prompt: string, options?: LLMOptions): Promise<string> {
    const model = options?.model || this.config.model;

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.3,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${body}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content || '';
  }

  async generateJSON<T>(prompt: string, options?: LLMOptions): Promise<T> {
    const maxRetries = options?.maxRetries ?? this.config.maxRetries;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const text = await this.generate(prompt, { ...options, temperature: 0.1 });
      try {
        const json = extractJSON(text);
        return JSON.parse(json) as T;
      } catch {
        if (attempt === maxRetries - 1) {
          throw new Error(`LLM JSON parse failed after ${maxRetries} attempts`);
        }
        continue;
      }
    }

    throw new Error('unreachable');
  }
}
