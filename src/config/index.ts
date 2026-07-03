import dotenv from 'dotenv';
dotenv.config();

export type DeployMode = 'jelly' | 'standalone';

export interface LLMConfig {
  baseUrl: string;
  model: string;
  maxRetries: number;
  apiKey?: string;
  timeoutMs?: number;
}

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export interface TypesenseConfig {
  host: string;
  port: number;
  apiKey: string;
  protocol?: 'http' | 'https';
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
}

export interface JellyConfig {
  apiUrl: string;
  sharedSecret: string;
}

export interface StandaloneConfig {
  apiKeys: string[];
}

export interface WikiConfig {
  staleDays: number;
  autoWriteBack: boolean;
}

export interface RepoConfig {
  cacheDir: string;
  fullClone: boolean;
  cloneTimeout: number;
  fetchTimeout: number;
}

export interface BitemporalConfig {
  /** Retention period in days for superseded bi-temporal edges.
   *  Edges with valid_to older than this are soft-archived (archived = true).
   *  Default: 90 days. */
  retentionDays: number;
}

export interface AppConfig {
  deployMode: DeployMode;
  port: number;
  neo4j: Neo4jConfig;
  typesense: TypesenseConfig;
  qdrant: QdrantConfig;
  /** Fallback LLM config (Ollama local) */
  llm: LLMConfig;
  /** Primary LLM config (OpenAI-compatible cloud API) */
  llmPrimary?: LLMConfig;
  wiki: WikiConfig;
  repo: RepoConfig;
  /** Bi-temporal archive/TTL settings */
  bitemporal: BitemporalConfig;
  jelly?: JellyConfig;
  standalone?: StandaloneConfig;
}

export function loadConfig(): AppConfig {
  const deployMode = (process.env.DEPLOY_MODE || 'standalone') as DeployMode;

  if (!['jelly', 'standalone'].includes(deployMode)) {
    throw new Error(`Invalid DEPLOY_MODE: ${deployMode}. Must be 'jelly' or 'standalone'.`);
  }

  const config: AppConfig = {
    deployMode,
    port: parseInt(process.env.PORT || '8095'),
    neo4j: {
      uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
      user: process.env.NEO4J_USER || 'neo4j',
      password: process.env.NEO4J_PASSWORD || '',
    },
    typesense: {
      host: process.env.TYPESENSE_HOST || 'localhost',
      port: parseInt(process.env.TYPESENSE_PORT || '8108'),
      apiKey: process.env.TYPESENSE_API_KEY || 'xyz',
      protocol: (process.env.TYPESENSE_PROTOCOL as 'http' | 'https') || 'http',
    },
    qdrant: {
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      apiKey: process.env.QDRANT_API_KEY || undefined,
    },
    llm: {
      baseUrl: process.env.LLM_BASE_URL || 'http://localhost:11434',
      model: process.env.LLM_MODEL || 'qwen3:14b',
      maxRetries: parseInt(process.env.LLM_MAX_RETRIES || '3'),
      apiKey: undefined, // Ollama doesn't need auth
      timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '120000'),
    },
    wiki: {
      staleDays: parseInt(process.env.WIKI_STALE_DAYS || '30'),
      autoWriteBack: process.env.WIKI_AUTO_WRITE_BACK !== 'false',
    },
    repo: {
      cacheDir: process.env.REPO_CACHE_DIR || '/data/code_strone',
      fullClone: process.env.REPO_FULL_CLONE !== 'false',
      cloneTimeout: parseInt(process.env.REPO_CLONE_TIMEOUT || '600000'),
      fetchTimeout: parseInt(process.env.REPO_FETCH_TIMEOUT || '300000'),
    },
    bitemporal: {
      retentionDays: parseInt(process.env.BITEMPORAL_RETENTION_DAYS || '90'),
    },
  };

  // Primary LLM (OpenAI-compatible cloud API) — optional, falls back to local Ollama
  const primaryBaseUrl = process.env.LLM_PRIMARY_BASE_URL;
  const primaryModel = process.env.LLM_PRIMARY_MODEL;
  if (primaryBaseUrl && primaryModel) {
    config.llmPrimary = {
      baseUrl: primaryBaseUrl,
      model: primaryModel,
      maxRetries: parseInt(process.env.LLM_PRIMARY_MAX_RETRIES || '3'),
      apiKey: process.env.LLM_PRIMARY_API_KEY,
      timeoutMs: parseInt(process.env.LLM_PRIMARY_TIMEOUT_MS || '120000'),
    };
  }

  if (deployMode === 'jelly') {
    config.jelly = {
      apiUrl: process.env.JELLY_API_URL || 'http://localhost:8000',
      sharedSecret: process.env.JELLY_SHARED_SECRET || '',
    };
  } else {
    config.standalone = {
      apiKeys: (process.env.STANDALONE_API_KEYS || '').split(',').filter(Boolean),
    };
  }

  return config;
}
