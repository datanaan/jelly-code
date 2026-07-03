import { describe, it, expect, beforeEach } from 'vitest';
import { createTaskManager } from '../../src/task/index.js';
import type { TaskManager } from '../../src/task/index.js';

describe('analyze dedup integration', () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = createTaskManager();
  });

  it('should dedup concurrent analyze requests — second request blocks until ready', async () => {
    const r1 = await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    expect(r1.status).toBe('queued');
    tm.markAnalyzing('proj-1');

    // While analyzing, a second request returns a promise that resolves on markReady
    const r2Promise = tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });

    // Project is still analyzing — state confirms dedup
    expect(tm.getState('proj-1')?.status).toBe('analyzing');
    expect(tm.getState('proj-1')?.pendingRequests.length).toBe(1);

    // Complete the analysis — this resolves the pending promise
    tm.markReady('proj-1');
    const r2 = await r2Promise;
    expect(r2.status).toBe('ready');
  });

  it('should return queued for re-analysis after ready', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markAnalyzing('proj-1');
    tm.markReady('proj-1');
    const r = await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    expect(r.status).toBe('queued');
  });

  it('should return queued for re-analysis after error', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markAnalyzing('proj-1');
    tm.markError('proj-1', 'something went wrong');
    const r = await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    expect(r.status).toBe('queued');
  });

  it('should track progress through lifecycle', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    expect(tm.getState('proj-1')?.status).toBe('queued');
    tm.markAnalyzing('proj-1');
    expect(tm.getState('proj-1')?.status).toBe('analyzing');
    tm.updateProgress('proj-1', { phase: 'parsing', percent: 50 });
    expect(tm.getState('proj-1')?.progress?.percent).toBe(50);
    tm.markReady('proj-1');
    expect(tm.getState('proj-1')?.status).toBe('ready');
  });

  it('should handle multiple independent projects', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/a' });
    await tm.requestAnalyze('proj-2', { repoPath: '/tmp/b' });
    tm.markAnalyzing('proj-1');
    tm.markAnalyzing('proj-2');
    expect(tm.getState('proj-1')?.status).toBe('analyzing');
    expect(tm.getState('proj-2')?.status).toBe('analyzing');
    tm.markReady('proj-1');
    expect(tm.getState('proj-1')?.status).toBe('ready');
    expect(tm.getState('proj-2')?.status).toBe('analyzing');
  });

  it('should reject pending requests on error', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markAnalyzing('proj-1');

    const r2Promise = tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markError('proj-1', 'boom');

    await expect(r2Promise).rejects.toThrow('boom');
    expect(tm.getState('proj-1')?.status).toBe('error');
    expect(tm.getState('proj-1')?.error).toBe('boom');
  });
});
