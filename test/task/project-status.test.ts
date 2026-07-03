import { describe, it, expect, beforeEach } from 'vitest';
import { createTaskManager } from '../../src/task/index.js';
import type { TaskManager } from '../../src/task/index.js';

describe('project_status tool logic', () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = createTaskManager();
  });

  it('should return idle for unknown project', () => {
    expect(tm.getState('unknown')).toBeNull();
  });

  it('should return analyzing with progress for active project', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markAnalyzing('proj-1');
    tm.updateProgress('proj-1', { phase: 'parsing', percent: 30 });
    const state = tm.getState('proj-1');
    expect(state?.status).toBe('analyzing');
    expect(state?.progress).toEqual({ phase: 'parsing', percent: 30 });
  });

  it('should return ready for completed project', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markAnalyzing('proj-1');
    tm.markReady('proj-1');
    expect(tm.getState('proj-1')?.status).toBe('ready');
  });

  it('should return error with message for failed project', async () => {
    await tm.requestAnalyze('proj-1', { repoPath: '/tmp/test' });
    tm.markAnalyzing('proj-1');
    tm.markError('proj-1', 'git clone timed out');
    const state = tm.getState('proj-1');
    expect(state?.status).toBe('error');
    expect(state?.error).toBe('git clone timed out');
  });
});
