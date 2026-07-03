/**
 * Ollama LLM adapter for jelly_code.
 *
 * Uses Ollama REST API directly via fetch — no extra dependencies needed.
 * Supports text generation and structured JSON output with automatic retry.
 */

import type { ILLMClient, LLMConfig, LLMOptions } from './interface.js';

export class OllamaAdapter implements ILLMClient {
  private readonly timeoutMs: number;

  constructor(private config: LLMConfig) {
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async generate(prompt: string, options?: LLMOptions): Promise<string> {
    const model = options?.model || this.config.model;

    const response = await fetch(`${this.config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.3,
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${body}`);
    }

    const data = await response.json() as { response: string };
    return data.response;
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

/**
 * Extract JSON from LLM output.
 * Handles responses wrapped in ```json ... ``` code blocks,
 * or plain JSON objects within surrounding text.
 */
export function extractJSON(text: string): string {
  // Try ```json ... ``` or ``` ... ``` code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find a JSON object or array
  const braceMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (braceMatch) return braceMatch[1];

  return text.trim();
}
