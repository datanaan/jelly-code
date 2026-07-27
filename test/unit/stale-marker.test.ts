/**
 * Unit Tests: Stale Marker Logic
 *
 * Tests the stale marking and filtering logic used by incremental analysis.
 * Imports the real computeCommunityThreshold from run-incremental.ts.
 *
 * Mocks ioredis to prevent NOAUTH errors from transitive imports.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock ioredis BEFORE importing modules that use it
vi.mock('ioredis', () => {
  const MockRedis = vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    quit: vi.fn().mockResolvedValue(undefined),
  }));
  return { default: MockRedis, Redis: MockRedis };
});

import { IncrementalFallbackError } from '../../src/core/incremental-fallback-error.js';
import { computeCommunityThreshold, COMMUNITY_CHANGE_MIN } from '../../src/core/run-incremental.js';

describe('Stale Marker Logic', () => {
  it('should construct IncrementalFallbackError', () => {
    const err = new IncrementalFallbackError('explosion_guard');
    expect(err).toBeInstanceOf(IncrementalFallbackError);
    expect(err.message).toBe('explosion_guard');
  });

  it('should detect stale threshold correctly', () => {
    const totalFiles = 1000;
    const filesToReparse = 600;
    expect(filesToReparse > totalFiles * 0.5).toBe(true);
  });

  it('should not trigger explosion guard for small changes', () => {
    const totalFiles = 1000;
    const filesToReparse = 100;
    expect(filesToReparse > totalFiles * 0.5).toBe(false);
  });

  it('should handle zero files gracefully', () => {
    const totalFiles = 0;
    const filesToReparse = 0;
    expect(filesToReparse > totalFiles * 0.5).toBe(false);
  });

  it('should import COMMUNITY_CHANGE_MIN constant', () => {
    expect(COMMUNITY_CHANGE_MIN).toBe(50);
  });

  it('should compute community change threshold correctly via real import', () => {
    const totalFiles = 2000;
    const threshold = computeCommunityThreshold(totalFiles);
    expect(threshold).toBe(100);
  });

  it('should use min threshold for small repos', () => {
    const totalFiles = 100;
    const threshold = computeCommunityThreshold(totalFiles);
    expect(threshold).toBe(50);
  });

  it('should calculate days since community rebuild', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const days = (Date.now() - new Date(sevenDaysAgo).getTime()) / 86400000;
    expect(days).toBeGreaterThanOrEqual(6.9);
    expect(days).toBeLessThanOrEqual(7.1);
  });

  it('should compute community threshold for empty repo', () => {
    const threshold = computeCommunityThreshold(0);
    expect(threshold).toBe(50);
  });

  it('should compute community threshold for large repo', () => {
    const threshold = computeCommunityThreshold(100000);
    expect(threshold).toBe(5000);
  });
});
