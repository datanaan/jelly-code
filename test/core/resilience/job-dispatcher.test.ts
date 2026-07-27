import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobDispatcher } from '../../../src/core/resilience/job-dispatcher.js';

// Mock BullMQ Queue
const mockAddBulk = vi.fn();
const mockGetWaitingCount = vi.fn().mockResolvedValue(0);
const mockQueue = {
  addBulk: mockAddBulk,
  getWaitingCount: mockGetWaitingCount,
} as any;

describe('JobDispatcher', () => {
  beforeEach(() => {
    mockAddBulk.mockReset();
    mockAddBulk.mockResolvedValue([]);
    mockGetWaitingCount.mockReset();
    mockGetWaitingCount.mockResolvedValue(0);
  });

  it('splits items into batches of batchSize', async () => {
    const dispatcher = new JobDispatcher();
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i }));
    const result = await dispatcher.dispatch(
      mockQueue,
      items,
      (batch) => ({ items: batch }),
      { batchSize: 10, jobIdPrefix: 'test' },
    );
    expect(result.batches).toBe(3);
    expect(result.dispatched).toBe(25);
    expect(mockAddBulk).toHaveBeenCalledTimes(1);
    const jobs = mockAddBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(3);
    expect(jobs[0].data.items).toHaveLength(10);
    expect(jobs[2].data.items).toHaveLength(5);
  });

  it('empty items returns dispatched=0', async () => {
    const dispatcher = new JobDispatcher();
    const result = await dispatcher.dispatch(mockQueue, [], () => ({}), { batchSize: 10, jobIdPrefix: 'x' });
    expect(result.dispatched).toBe(0);
    expect(result.batches).toBe(0);
    expect(mockAddBulk).not.toHaveBeenCalled();
  });

  it('backpressure: throws when queue length exceeds maxQueueDepth', async () => {
    mockGetWaitingCount.mockResolvedValue(1500);
    const dispatcher = new JobDispatcher();
    await expect(dispatcher.dispatch(
      mockQueue,
      [{ id: 1 }],
      (b) => ({ items: b }),
      { batchSize: 10, jobIdPrefix: 'x', maxQueueDepth: 1000 },
    )).rejects.toThrow(/backpressure|queue full/i);
  });

  it('jobId is deterministic for same batch (idempotency)', async () => {
    const dispatcher = new JobDispatcher();
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await dispatcher.dispatch(mockQueue, items, (b) => ({ items: b }), { batchSize: 10, jobIdPrefix: 'derive' });
    const jobId1 = mockAddBulk.mock.calls[0][0][0].opts.jobId;
    mockAddBulk.mockClear();
    mockAddBulk.mockResolvedValue([]);
    await dispatcher.dispatch(mockQueue, items, (b) => ({ items: b }), { batchSize: 10, jobIdPrefix: 'derive' });
    const jobId2 = mockAddBulk.mock.calls[0][0][0].opts.jobId;
    expect(jobId1).toBe(jobId2);
  });

  it('priority passed through to BullMQ', async () => {
    const dispatcher = new JobDispatcher();
    await dispatcher.dispatch(
      mockQueue, [{ id: 1 }], (b) => ({ items: b }),
      { batchSize: 10, jobIdPrefix: 'x', priority: 5 },
    );
    expect(mockAddBulk.mock.calls[0][0][0].opts.priority).toBe(5);
  });
});
