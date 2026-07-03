export { TaskManager } from './task-manager.js';
export type { RequestResult } from './task-manager.js';
export { SlotManager } from './slot-manager.js';
export type { Slot } from './slot-manager.js';
export { resolveSearchStrategy, wrapSearchResult } from './search-strategy.js';
export type {
  ProjectState,
  ProjectStatus,
  PendingRequest,
  TaskManagerConfig,
  SearchStrategy,
  SearchResultMeta,
} from './types.js';

import { TaskManager } from './task-manager.js';
import type { TaskManagerConfig } from './types.js';

const DEFAULT_CONFIG: TaskManagerConfig = {
  maxConcurrent: 3,
  largeRepoThreshold: 5000,
  largeRepoSlots: 1,
  staleWhileRevalidate: true,
};

export function createTaskManager(config?: Partial<TaskManagerConfig>): TaskManager {
  return new TaskManager({ ...DEFAULT_CONFIG, ...config });
}