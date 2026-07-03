import type { ProjectState, ProjectStatus, TaskManagerConfig } from './types.js';
import { randomUUID } from 'crypto';

const DEFAULT_CONFIG: TaskManagerConfig = {
  maxConcurrent: 3,
  largeRepoThreshold: 5000,
  largeRepoSlots: 1,
  staleWhileRevalidate: true,
};

export interface RequestResult {
  status: ProjectStatus;
  position: number;
}

export class TaskManager {
  private projects = new Map<string, ProjectState>();
  private config: TaskManagerConfig;
  private listeners: Array<(projectId: string, from: ProjectStatus, to: ProjectStatus) => void> = [];

  constructor(config?: Partial<TaskManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): TaskManagerConfig {
    return { ...this.config };
  }

  getState(projectId: string): ProjectState | null {
    return this.projects.get(projectId) ?? null;
  }

  async requestAnalyze(projectId: string, options: {
    repoPath?: string;
    gitUrl?: string;
    estimatedFiles?: number;
  }): Promise<RequestResult> {
    const existing = this.projects.get(projectId);

    // No existing state, or in a terminal state that allows re-queue
    if (!existing || existing.status === 'idle' || existing.status === 'error' || existing.status === 'cancelled') {
      const state: ProjectState = {
        projectId,
        status: 'queued',
        startedAt: new Date(),
        estimatedFiles: options.estimatedFiles,
        pendingRequests: [],
      };
      this.projects.set(projectId, state);
      this.emit(projectId, existing?.status ?? 'idle', 'queued');
      return { status: 'queued', position: 0 };
    }

    // Already analyzing or queued — dedup: register a pending request with a real Promise
    if (existing.status === 'analyzing' || existing.status === 'queued') {
      const promise = new Promise<RequestResult>((resolve, reject) => {
        existing.pendingRequests.push({
          id: randomUUID(),
          submittedAt: new Date(),
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
      // Return a wrapper that resolves with status/position when the real promise settles
      // We need the caller to get back a promise that resolves when markReady/markError fires
      return promise;
    }

    // Ready → re-analysis
    if (existing.status === 'ready') {
      const state: ProjectState = {
        projectId,
        status: 'queued',
        startedAt: new Date(),
        estimatedFiles: options.estimatedFiles,
        pendingRequests: [],
      };
      this.projects.set(projectId, state);
      this.emit(projectId, 'ready', 'queued');
      return { status: 'queued', position: 0 };
    }

    return { status: existing.status, position: 0 };
  }

  markAnalyzing(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state || (state.status !== 'queued' && state.status !== 'cancelled')) {
      throw new Error(`Cannot mark analyzing: project ${projectId} is ${state?.status ?? 'unknown'}`);
    }
    const prev = state.status;
    state.status = 'analyzing';
    state.startedAt = new Date();
    this.emit(projectId, prev, 'analyzing');
  }

  markReady(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state || state.status !== 'analyzing') {
      throw new Error(`Cannot mark ready: project ${projectId} is ${state?.status ?? 'unknown'}`);
    }
    const prev = state.status;
    state.status = 'ready';
    state.error = undefined;
    this.emit(projectId, prev, 'ready');
    for (const pending of state.pendingRequests) {
      pending.resolve({ status: 'ready', position: 0 });
    }
    state.pendingRequests = [];
  }

  markError(projectId: string, error: string): void {
    const state = this.projects.get(projectId);
    if (!state || state.status !== 'analyzing') {
      throw new Error(`Cannot mark error: project ${projectId} is ${state?.status ?? 'unknown'}`);
    }
    const prev = state.status;
    state.status = 'error';
    state.error = error;
    this.emit(projectId, prev, 'error');
    for (const pending of state.pendingRequests) {
      pending.reject(new Error(error));
    }
    state.pendingRequests = [];
  }

  cancel(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    if (state.status === 'analyzing') {
      throw new Error('Cannot cancel an analyzing task');
    }
    const prev = state.status;
    state.status = 'cancelled';
    this.emit(projectId, prev, 'cancelled');
  }

  updateProgress(projectId: string, progress: { phase: string; percent: number }): void {
    const state = this.projects.get(projectId);
    if (!state || state.status !== 'analyzing') {
      throw new Error(`Cannot update progress: project ${projectId} is ${state?.status ?? 'unknown'}`);
    }
    state.progress = progress;
  }

  onStateChange(listener: (projectId: string, from: ProjectStatus, to: ProjectStatus) => void): void {
    this.listeners.push(listener);
  }

  private emit(projectId: string, from: ProjectStatus, to: ProjectStatus): void {
    for (const listener of this.listeners) {
      listener(projectId, from, to);
    }
  }
}
