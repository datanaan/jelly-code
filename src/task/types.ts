/**
 * Task management types for concurrent analysis control.
 */

export type ProjectStatus = 'idle' | 'queued' | 'analyzing' | 'ready' | 'error' | 'cancelled';

export interface PendingRequest {
  id: string;
  submittedAt: Date;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface ProjectState {
  projectId: string;
  status: ProjectStatus;
  startedAt?: Date;
  estimatedFiles?: number;
  progress?: { phase: string; percent: number };
  error?: string;
  pendingRequests: PendingRequest[];
}

export interface TaskManagerConfig {
  maxConcurrent: number;
  largeRepoThreshold: number;
  largeRepoSlots: number;
  staleWhileRevalidate: boolean;
}

export type SearchStrategy = 'fresh' | 'stale' | 'stale+wait' | 'not_found' | 'stale+error';

export interface SearchResultMeta {
  stale?: boolean;
  analyzingSince?: Date;
  estimatedWait?: number;
  _hint?: string;
}
