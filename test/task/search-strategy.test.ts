import { describe, it, expect } from 'vitest';
import { resolveSearchStrategy, wrapSearchResult } from '../../src/task/search-strategy.js';
import type { ProjectState } from '../../src/task/types.js';

describe('resolveSearchStrategy', () => {
  it('should return fresh for ready state', () => {
    const state: ProjectState = { projectId: 'p1', status: 'ready', pendingRequests: [] };
    expect(resolveSearchStrategy(state)).toBe('fresh');
  });

  it('should return stale for analyzing state', () => {
    const state: ProjectState = { projectId: 'p1', status: 'analyzing', startedAt: new Date(), pendingRequests: [] };
    expect(resolveSearchStrategy(state)).toBe('stale');
  });

  it('should return stale+wait for queued state', () => {
    const state: ProjectState = { projectId: 'p1', status: 'queued', pendingRequests: [] };
    expect(resolveSearchStrategy(state)).toBe('stale+wait');
  });

  it('should return not_found for idle state', () => {
    const state: ProjectState = { projectId: 'p1', status: 'idle', pendingRequests: [] };
    expect(resolveSearchStrategy(state)).toBe('not_found');
  });

  it('should return stale+error for error state', () => {
    const state: ProjectState = { projectId: 'p1', status: 'error', error: 'git clone failed', pendingRequests: [] };
    expect(resolveSearchStrategy(state)).toBe('stale+error');
  });

  it('should return not_found for cancelled state', () => {
    const state: ProjectState = { projectId: 'p1', status: 'cancelled', pendingRequests: [] };
    expect(resolveSearchStrategy(state)).toBe('not_found');
  });
});

describe('wrapSearchResult', () => {
  it('should not add meta for fresh strategy', () => {
    const result = wrapSearchResult({ nodes: [] }, 'fresh');
    expect(result._meta).toBeUndefined();
  });

  it('should add stale meta for stale strategy', () => {
    const analyzingSince = new Date('2026-01-01');
    const result = wrapSearchResult({ nodes: [] }, 'stale', analyzingSince);
    expect(result._meta?.stale).toBe(true);
    expect(result._meta?.analyzingSince).toBe(analyzingSince);
  });

  it('should add hint for stale+wait strategy', () => {
    const result = wrapSearchResult({ nodes: [] }, 'stale+wait', new Date());
    expect(result._meta?.stale).toBe(true);
    expect(result._meta?._hint).toContain('in progress');
  });

  it('should add hint for stale+error strategy', () => {
    const result = wrapSearchResult({ nodes: [] }, 'stale+error');
    expect(result._meta?.stale).toBe(true);
    expect(result._meta?._hint).toContain('failed');
  });

  it('should not add meta for not_found strategy', () => {
    const result = wrapSearchResult({ nodes: [] }, 'not_found');
    expect(result._meta).toBeUndefined();
  });
});