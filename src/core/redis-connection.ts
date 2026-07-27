/**
 * Redis connection configuration for BullMQ queues.
 *
 * Reuses the existing Jelly ecosystem Redis instance (6380 by default).
 * The connection is shared across all BullMQ queues and workers.
 *
 * Configuration via environment variables:
 * - REDIS_HOST: Redis server hostname (default: localhost)
 * - REDIS_PORT: Redis server port (default: 6380)
 * - REDIS_PASSWORD: Redis password (optional)
 * - REDIS_DB: Redis database index (default: 0)
 */

import { Redis, type RedisOptions } from 'ioredis';
import { logger } from './logger.js';

export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  maxRetriesPerRequest: number | null;
  enableReadyCheck: boolean;
}

function loadRedisConfig(): RedisConnectionConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6380', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    maxRetriesPerRequest: null,  // BullMQ requires null for its own retry logic
    enableReadyCheck: false,     // BullMQ handles ready checks internally
  };
}

let _redisConnection: Redis | null = null;

/**
 * Get or create the shared Redis connection for BullMQ.
 * Lazily created on first access, cached for the lifetime of the process.
 */
export function getRedisConnection(): Redis {
  if (!_redisConnection) {
    const config = loadRedisConfig();
    const options: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      enableReadyCheck: config.enableReadyCheck,
      retryStrategy: (times: number) => {
        // Exponential backoff with jitter: 1s → 2s → 4s → 8s → 16s → 30s cap
        const delay = Math.min(1000 * Math.pow(2, times), 30000);
        return delay;
      },
      lazyConnect: true,  // Don't connect until first operation
    };

    if (config.password) {
      options.password = config.password;
    }

    _redisConnection = new Redis(options);

    _redisConnection.on('error', (err: Error) => {
      // Don't crash the process on Redis connection errors — let BullMQ handle retries
      logger.error({ error: err.message }, 'Redis connection error');
    });

    _redisConnection.on('connect', () => {
      logger.info({ host: config.host, port: config.port }, 'Redis connected');
    });

    _redisConnection.on('close', () => {
      logger.info('Redis connection closed');
    });
  }

  return _redisConnection;
}

/**
 * Gracefully close the Redis connection.
 * Should be called during shutdown.
 */
export async function closeRedisConnection(): Promise<void> {
  if (_redisConnection) {
    await _redisConnection.quit();
    _redisConnection = null;
    logger.info('Redis connection closed gracefully');
  }
}
