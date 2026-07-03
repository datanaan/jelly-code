import { describe, it, expect, beforeEach } from 'vitest';
import { TaskManager } from '../../src/task/task-manager.js';
import type { TaskManagerConfig } from '../../src/task/types.js';

const defaultConfig: TaskManagerConfig = {
  maxConcurrent: 3,
  largeRepoThreshold: 5000,
  largeRepoSlots: 1,
  staleWhileRevalidate: true,
};

describe('TaskManager', () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = new TaskManager(defaultConfig);
  });

  describe('state transitions', () => {
    it('should return null for unknown project', () => {
      expect(tm.getState('unknown-project')).toBeNull();
    });

    it('should transition idle → queued on requestAnalyze', async () => {
      const result = await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test', estimatedFiles: 100 });
      expect(result.status).toBe('queued');
      expect(tm.getState('proj-1')?.status).toBe('queued');
    });

    it('should transition queued → analyzing on markAnalyzing', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      expect(tm.getState('proj-1')?.status).toBe('analyzing');
    });

    it('should transition analyzing → ready on markReady', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      tm.markReady('proj-1');
      expect(tm.getState('proj-1')?.status).toBe('ready');
    });

    it('should transition analyzing → error on markError', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      tm.markError('proj-1', 'git clone failed');
      expect(tm.getState('proj-1')?.status).toBe('error');
      expect(tm.getState('proj-1')?.error).toBe('git clone failed');
    });

    it('should reject invalid transitions', async () => {
      expect(() => tm.markAnalyzing('proj-1')).toThrow();
    });

    it('should allow ready → queued for re-analysis', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      tm.markReady('proj-1');
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      expect(tm.getState('proj-1')?.status).toBe('queued');
    });

    it('should allow error → queued for retry', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      tm.markError('proj-1', 'failed');
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      expect(tm.getState('proj-1')?.status).toBe('queued');
    });
  });

  describe('deduplication', () => {
    it('should dedup concurrent requests for same projectId', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      // Second request while analyzing: returns a pending promise that tracks the analysis
      // Verify the project state shows analyzing with a pending request registered
      const pendingPromise = tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      expect(tm.getState('proj-1')?.status).toBe('analyzing');
      expect(tm.getState('proj-1')?.pendingRequests.length).toBe(1);
      // Resolve the pending promise to avoid test hang
      tm.markReady('proj-1');
      const result = await pendingPromise;
      expect(result.status).toBe('ready');
    });

    it('should notify all pending requests on completion', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      const pendingPromise = tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markReady('proj-1');
      const result = await pendingPromise;
      expect(result.status).toBe('ready');
    });

    it('should reject all pending requests on error', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      const pendingPromise = tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markError('proj-1', 'something broke');
      await expect(pendingPromise).rejects.toThrow('something broke');
    });
  });

  describe('cancel', () => {
    it('should cancel a queued task', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.cancel('proj-1');
      expect(tm.getState('proj-1')?.status).toBe('cancelled');
    });

    it('should not cancel an analyzing task', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      expect(() => tm.cancel('proj-1')).toThrow();
    });
  });

  describe('state change listener', () => {
    it('should emit state transitions', async () => {
      const transitions: Array<{ from: string; to: string }> = [];
      tm.onStateChange((_projectId, from, to) => {
        transitions.push({ from, to });
      });
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      tm.markReady('proj-1');
      expect(transitions).toEqual([
        { from: 'idle', to: 'queued' },
        { from: 'queued', to: 'analyzing' },
        { from: 'analyzing', to: 'ready' },
      ]);
    });
  });

  describe('updateProgress', () => {
    it('should update progress for analyzing project', async () => {
      await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
      tm.markAnalyzing('proj-1');
      tm.updateProgress('proj-1', { phase: 'parsing', percent: 50 });
      expect(tm.getState('proj-1')?.progress).toEqual({ phase: 'parsing', percent: 50 });
    });

    it('should throw for non-analyzing project', () => {
      expect(() => tm.updateProgress('proj-1', { phase: 'parsing', percent: 50 })).toThrow();
    });
  });
});
