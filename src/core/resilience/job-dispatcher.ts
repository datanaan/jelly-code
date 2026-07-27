/**
 * Thin wrapper over BullMQ Queue.addBulk for batched dispatch.
 * Idempotency: deterministic jobId = `${prefix}:${sha256(batch)}`.
 * Backpressure: rejects when queue waiting count exceeds maxQueueDepth.
 */
import { createHash } from 'crypto';
import type { Queue, JobsOptions } from 'bullmq';

export interface DispatchOptions {
  batchSize: number;
  jobIdPrefix: string;
  priority?: number;
  maxQueueDepth?: number;  // default 1000
}

export interface DispatchResult {
  dispatched: number;
  batches: number;
}

export class JobDispatcher {
  async dispatch<T>(
    queue: Queue,
    items: T[],
    payloadBuilder: (batch: T[]) => unknown,
    opts: DispatchOptions,
  ): Promise<DispatchResult> {
    if (items.length === 0) return { dispatched: 0, batches: 0 };

    // Backpressure check
    const maxDepth = opts.maxQueueDepth ?? 1000;
    const waiting = await queue.getWaitingCount();
    if (waiting >= maxDepth) {
      throw new Error(`backpressure: queue ${queue.name} waiting=${waiting} >= max=${maxDepth}`);
    }

    // Split into batches
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += opts.batchSize) {
      batches.push(items.slice(i, i + opts.batchSize));
    }

    // Build jobs with deterministic jobId
    const jobs = batches.map(batch => {
      const payload = payloadBuilder(batch);
      const jobId = this.makeJobId(opts.jobIdPrefix, payload);
      const jobOpts: JobsOptions = { jobId };
      if (opts.priority !== undefined) jobOpts.priority = opts.priority;
      return {
        name: opts.jobIdPrefix,
        data: payload,
        opts: jobOpts,
      };
    });

    await queue.addBulk(jobs);
    return { dispatched: items.length, batches: batches.length };
  }

  private makeJobId(prefix: string, payload: unknown): string {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
    return `${prefix}:${hash}`;
  }
}
