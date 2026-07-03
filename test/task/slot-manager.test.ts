import { describe, it, expect, beforeEach } from 'vitest';
import { SlotManager } from '../../src/task/slot-manager.js';

describe('SlotManager', () => {
  let sm: SlotManager;

  beforeEach(() => {
    sm = new SlotManager({ maxConcurrent: 2, largeRepoSlots: 1, largeRepoThreshold: 5000 });
  });

  it('should acquire and release normal slots', () => {
    const slot = sm.acquireSlot(100);
    expect(slot).not.toBeNull();
    expect(slot!.type).toBe('normal');
    expect(sm.availableNormalSlots()).toBe(1);
    sm.releaseSlot(slot!);
    expect(sm.availableNormalSlots()).toBe(2);
  });

  it('should acquire large repo slot for big projects', () => {
    const slot = sm.acquireSlot(10000);
    expect(slot).not.toBeNull();
    expect(slot!.type).toBe('large');
    expect(sm.availableLargeSlots()).toBe(0);
  });

  it('should return null when no normal slots available', () => {
    sm.acquireSlot(100);
    sm.acquireSlot(100);
    expect(sm.acquireSlot(100)).toBeNull();
  });

  it('should return null when no large slots available', () => {
    sm.acquireSlot(10000);
    expect(sm.acquireSlot(10000)).toBeNull();
  });

  it('should wait for slot availability', async () => {
    sm.acquireSlot(100);
    sm.acquireSlot(100);
    const waitPromise = sm.waitForSlot(100);
    setTimeout(() => sm.releaseSlot({ type: 'normal' }), 50);
    const slot = await waitPromise;
    expect(slot.type).toBe('normal');
  });

  it('should prioritize small projects in wait queue', async () => {
    sm.acquireSlot(100);
    sm.acquireSlot(100);
    const largeWait = sm.waitForSlot(10000);
    const smallWait = sm.waitForSlot(100);
    setTimeout(() => sm.releaseSlot({ type: 'normal' }), 50);
    const smallSlot = await smallWait;
    expect(smallSlot.type).toBe('normal');
  });
});