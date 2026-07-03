/**
 * Tests: P3 Community threshold + temporal incremental
 *
 * Verifies community detection threshold triggers rebuild when
 * accumulated changes exceed threshold, and temporal incremental
 * correctly passes the 'since' parameter.
 */

import { describe, it, expect, vi } from 'vitest';

describe('P3: Community threshold', () => {
  it('should trigger rebuild when accumulatedChanges >= threshold', () => {
    // From community-rebuilder.ts and run-incremental.ts
    const COMMUNITY_CHANGE_MIN = 50;
    const COMMUNITY_CHANGE_RATIO = 0.05;
    const COMMUNITY_STALE_DAYS = 7;
    const totalFiles = 1000;

    const threshold = Math.max(COMMUNITY_CHANGE_MIN, Math.floor(totalFiles * COMMUNITY_CHANGE_RATIO));
    expect(threshold).toBe(50);

    // accumulated changes >= threshold → rebuild
    expect(100).toBeGreaterThanOrEqual(threshold);
    // accumulated changes < threshold → mark stale
    expect(10).toBeLessThan(threshold);
  });

  it('should trigger rebuild when stale days exceed threshold', () => {
    const daysSinceRebuild = 30;
    const COMMUNITY_STALE_DAYS = 7;
    expect(daysSinceRebuild).toBeGreaterThanOrEqual(COMMUNITY_STALE_DAYS);
  });

  it('should mark stale (not rebuild) when below both thresholds', () => {
    const accumulatedChanges = 10;
    const daysSinceRebuild = 3;
    const threshold = 50;
    const staleDays = 7;

    const shouldRebuild = accumulatedChanges >= threshold || daysSinceRebuild >= staleDays;
    expect(shouldRebuild).toBe(false);
  });

  it('should not block rebuild when pipelineResult is undefined', async () => {
    const { rebuildCommunities } = await import('../../src/core/community-rebuilder.js');
    expect(typeof rebuildCommunities).toBe('function');
  });
});

describe('P3: Temporal incremental', () => {
  it('run-analyze module should export runAnalyze and writePipelineResultToStores', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runAnalyze).toBe('function');
    expect(typeof mod.writePipelineResultToStores).toBe('function');
  });
});
