/**
 * EmbeddingService: HTTP-pool mode embedder.
 *
 * In local mode, callers should continue using the transformers.js-backed
 * embedder.ts (we keep that path for dev/standalone). This service is used
 * when CODE_EMBEDDING_URLS is set.
 */
import { request } from 'undici';
import {
  RemoteService,
  loadCredential,
  safeUrl,
  type RemoteEndpoint,
  type RemoteServiceConfig,
} from '../resilience/index.js';
import { logger } from '../logger.js';
import type { EmbeddingServiceConfig } from './config.js';

export type EmbeddingApiCaller = (
  endpoint: RemoteEndpoint & { resolvedApiKey?: string },
  texts: string[],
) => Promise<number[][]>;

export const defaultEmbeddingCaller: EmbeddingApiCaller = async (endpoint, texts) => {
  const url = `${endpoint.url}/embeddings`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...endpoint.headers };
  if (endpoint.resolvedApiKey) headers.Authorization = `Bearer ${endpoint.resolvedApiKey}`;
  const { statusCode, body } = await request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: texts, model: endpoint.model }),
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  if (statusCode >= 400) {
    const text = await body.text();
    throw new Error(`Embedding API ${statusCode} from ${safeUrl(url)}: ${text.slice(0, 200)}`);
  }
  const data: any = await body.json();
  return data.data.map((item: any) => item.embedding);
};

export class EmbeddingService {
  private remote: RemoteService;
  private endpointsWithCreds: Array<RemoteEndpoint & { resolvedApiKey?: string }>;

  constructor(
    private config: EmbeddingServiceConfig,
    private caller: EmbeddingApiCaller = defaultEmbeddingCaller,
  ) {
    // Apply default batchSize if caller didn't supply one
    if (!this.config.batchSize || this.config.batchSize <= 0) {
      this.config.batchSize = 16;
    }
    this.endpointsWithCreds = (config.endpoints as RemoteEndpoint[]).map(ep => ({
      ...ep,
      resolvedApiKey: loadCredential(ep),
    }));
    const remoteConfig: RemoteServiceConfig = {
      name: 'embedding',
      endpoints: this.endpointsWithCreds,
      strategy: config.strategy,
      resilience: config.resilience,
    };
    this.remote = new RemoteService(remoteConfig);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    logger.debug({ batchSize: this.config.batchSize, totalTexts: texts.length }, '[embedding] embed called');
    const allVectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize);
      const batchVectors = await this.remote.callPool(async (endpoint) => {
        const ep = this.endpointsWithCreds.find(e => e.url === endpoint.url)!;
        const raw = await this.caller(ep, batch);
        // Dimension check
        if (raw.length > 0 && raw[0].length !== this.config.dimensions) {
          throw new Error(`Embedding dimension mismatch: got ${raw[0].length}, expected ${this.config.dimensions}`);
        }
        return raw;
      });
      for (const v of batchVectors) allVectors.push(new Float32Array(v));
    }
    return allVectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return Array.from(vec);
  }

  isReady(): boolean {
    return this.endpointsWithCreds.length > 0;
  }

  getStats() {
    return this.remote.getStats();
  }
}


