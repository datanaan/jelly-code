/**
 * Unit Tests: BullMQ Queue Setup
 *
 * Tests that queues are created with correct configuration.
 * Uses BullMQ's test connection (no real Redis needed for unit tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { analyzeQueue, searchSyncQueue, cleanupQueue, closeQueues } from '../../src/core/queue-setup.js';

describe('Queue Setup', () => {
  it('should create analyze queue with correct name', () => {
    expect(analyzeQueue).toBeInstanceOf(Queue);
    expect(analyzeQueue.name).toBe('analyze');
  });

  it('should create search-sync queue with correct name', () => {
    expect(searchSyncQueue).toBeInstanceOf(Queue);
    expect(searchSyncQueue.name).toBe('search-sync');
  });

  it('should create cleanup queue with correct name', () => {
    expect(cleanupQueue).toBeInstanceOf(Queue);
    expect(cleanupQueue.name).toBe('cleanup');
  });

  it('should have default job options on analyze queue', () => {
    // DefaultJobOptions should include attempts and backoff
    expect(analyzeQueue.defaultJobOptions).toBeDefined();
    expect(analyzeQueue.defaultJobOptions?.attempts).toBe(3);
  });

  it('should have default job options on cleanup queue', () => {
    expect(cleanupQueue.defaultJobOptions).toBeDefined();
    expect(cleanupQueue.defaultJobOptions?.attempts).toBe(3);
  });
});
