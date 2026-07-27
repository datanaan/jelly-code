/**
 * LLMService: business adapter implementing ILLMClient.
 *
 * Wraps RemoteService for governance. The actual HTTP call is delegated
 * to an injectable caller function, so this module is testable without
 * mocking undici. Production caller uses undici's request().
 */
import { request } from 'undici';
import type { ILLMClient, LLMOptions } from './interface.js';
import { extractJSON } from './ollama.js';
import {
  RemoteService,
  type RemoteServiceConfig,
  type RemoteEndpoint,
  loadCredential,
  estimateTokens,
  UsageTracker,
  safeUrl,
} from '../core/resilience/index.js';
import { logger } from '../core/logger.js';

export type LLMApiCaller = (
  endpoint: RemoteEndpoint & { resolvedApiKey?: string },
  prompt: string,
  options?: LLMOptions,
) => Promise<string>;

/**
 * Default caller using undici. Handles both OpenAI-compatible and Ollama APIs.
 */
export const defaultLLMCaller: LLMApiCaller = async (endpoint, prompt, options) => {
  const model = options?.model || endpoint.model;
  const isOllama = endpoint.url.includes(':11434');
  const url = isOllama
    ? `${endpoint.url}/api/generate`
    : `${endpoint.url}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...endpoint.headers };
  if (endpoint.resolvedApiKey) headers.Authorization = `Bearer ${endpoint.resolvedApiKey}`;

  const body = isOllama
    ? JSON.stringify({ model, prompt, stream: false, options: { temperature: options?.temperature ?? 0.3 } })
    : JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: options?.temperature ?? 0.3, max_tokens: 4096 });

  const { statusCode, body: respBody } = await request(url, {
    method: 'POST',
    headers,
    body,
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });

  if (statusCode >= 400) {
    const text = await respBody.text();
    throw new Error(`LLM API error ${statusCode} from ${safeUrl(url)}: ${text.slice(0, 200)}`);
  }

  const data: any = await respBody.json();
  return isOllama ? data.response : (data.choices?.[0]?.message?.content || '');
};

export class LLMService implements ILLMClient {
  private remote: RemoteService;
  private usage = new UsageTracker();
  private endpointsWithCreds: Array<RemoteEndpoint & { resolvedApiKey?: string }>;

  constructor(
    config: RemoteServiceConfig,
    private caller: LLMApiCaller = defaultLLMCaller,
  ) {
    // Resolve credentials once at startup
    this.endpointsWithCreds = config.endpoints.map(ep => {
      const apiKey = loadCredential(ep);
      return { ...ep, resolvedApiKey: apiKey };
    });
    this.remote = new RemoteService({ ...config, endpoints: this.endpointsWithCreds });
  }

  async generate(prompt: string, options?: LLMOptions): Promise<string> {
    const start = Date.now();
    let usedEndpointUrl = this.endpointsWithCreds[0].url;
    const response = await this.remote.callPool(async (endpoint) => {
      const ep = this.endpointsWithCreds.find(e => e.url === endpoint.url)!;
      usedEndpointUrl = ep.url;
      return this.caller(ep, prompt, options);
    });
    // Record usage (rough token estimate)
    this.usage.record({
      endpoint: usedEndpointUrl,
      promptTokens: estimateTokens(prompt),
      completionTokens: estimateTokens(response),
      timestamp: Date.now(),
    });
    logger.debug({ promptLen: prompt.length, respLen: response.length, ms: Date.now() - start }, '[llm] generate ok');
    return response;
  }

  async generateJSON<T>(prompt: string, options?: LLMOptions): Promise<T> {
    const maxRetries = options?.maxRetries ?? 3;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const text = await this.generate(prompt, { ...options, temperature: 0.1 });
      try {
        const json = extractJSON(text);
        return JSON.parse(json) as T;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // loop retries
      }
    }
    throw new Error(`LLM JSON parse failed after ${maxRetries} attempts: ${lastErr?.message}`);
  }

  getStats() {
    return this.remote.getStats();
  }

  getUsageStats() {
    return this.usage.summary();
  }
}
