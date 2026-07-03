import type { TaskManagerConfig } from './types.js';

export interface Slot {
  type: 'normal' | 'large';
}

interface Waiter {
  estimatedFiles: number;
  resolve: (slot: Slot) => void;
  priority: number;
}

export class SlotManager {
  private maxNormal: number;
  private maxLarge: number;
  private largeThreshold: number;
  private usedNormal = 0;
  private usedLarge = 0;
  private waitQueue: Waiter[] = [];

  constructor(config: Pick<TaskManagerConfig, 'maxConcurrent' | 'largeRepoSlots' | 'largeRepoThreshold'>) {
    this.maxNormal = config.maxConcurrent;
    this.maxLarge = config.largeRepoSlots;
    this.largeThreshold = config.largeRepoThreshold;
  }

  acquireSlot(estimatedFiles: number): Slot | null {
    if (estimatedFiles >= this.largeThreshold) {
      if (this.usedLarge < this.maxLarge) {
        this.usedLarge++;
        return { type: 'large' };
      }
      return null;
    }
    if (this.usedNormal < this.maxNormal) {
      this.usedNormal++;
      return { type: 'normal' };
    }
    return null;
  }

  releaseSlot(slot: Slot): void {
    if (slot.type === 'large') {
      this.usedLarge = Math.max(0, this.usedLarge - 1);
    } else {
      this.usedNormal = Math.max(0, this.usedNormal - 1);
    }
    this.processWaitQueue();
  }

  availableNormalSlots(): number {
    return this.maxNormal - this.usedNormal;
  }

  availableLargeSlots(): number {
    return this.maxLarge - this.usedLarge;
  }

  async waitForSlot(estimatedFiles: number): Promise<Slot> {
    const slot = this.acquireSlot(estimatedFiles);
    if (slot) return slot;
    return new Promise<Slot>((resolve) => {
      const priority = estimatedFiles >= this.largeThreshold ? this.largeThreshold + estimatedFiles : estimatedFiles;
      this.waitQueue.push({ estimatedFiles, resolve, priority });
      this.waitQueue.sort((a, b) => a.priority - b.priority);
    });
  }

  private processWaitQueue(): void {
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue[0];
      const slot = this.acquireSlot(waiter.estimatedFiles);
      if (slot) {
        this.waitQueue.shift();
        waiter.resolve(slot);
      } else {
        break;
      }
    }
  }
}