/**
 * LLM client abstraction for jelly_code.
 *
 * Provides a unified interface for text generation and structured JSON output.
 * The primary implementation is OllamaAdapter, but the interface allows swapping
 * to other LLM backends (OpenAI, Anthropic, etc.) without changing business code.
 */

export interface ILLMClient {
  /**
   * Generate text from a prompt.
   * Used for synthesize answers, free-form generation, etc.
   */
  generate(prompt: string, options?: LLMOptions): Promise<string>;

  /**
   * Generate structured JSON output from a prompt.
   * Automatically retries on JSON parse failure (up to maxRetries times).
   * Handles LLM responses wrapped in ```json ... ``` code blocks.
   */
  generateJSON<T>(prompt: string, options?: LLMOptions): Promise<T>;
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxRetries?: number;
}

export interface LLMConfig {
  baseUrl: string;     // LLM API base URL (e.g. http://localhost:11434 for Ollama)
  model: string;       // e.g. qwen3:14b
  maxRetries: number;  // e.g. 3
  apiKey?: string;     // optional bearer token for OpenAI-compatible APIs
  timeoutMs?: number;  // fetch timeout in ms (default: 120000)
}
