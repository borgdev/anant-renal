// In-process JobBus driver.
//
// Synchronous execution, no external dependencies. Ships as the default for
// unit tests and for a "single-binary demo" mode where the harness runs on a
// laptop without Redis or Kafka. Preserves the ordering + idempotency +
// retry + DLQ + replay semantics of the port; the storage substrate is a
// per-kind ring buffer in memory.

import type { JobBus, JobContext, DurableJobHandler, EnqueueOptions, JobHandle } from './job-bus.js';
import { JobBusError } from './job-bus.js';

interface StoredJob {
  readonly jobId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly enqueuedAt: string;
  attempts: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly partitionKey: string | undefined;
  status: 'pending' | 'running' | 'done' | 'failed';
  lastError?: string;
}

export class InProcessJobBus implements JobBus {
  private readonly handlers = new Map<string, DurableJobHandler<unknown>>();
  private readonly log: StoredJob[] = [];
  private readonly dlq: StoredJob[] = [];
  private readonly seenIdempotency = new Set<string>();
  private started = false;

  driverName(): 'inprocess' { return 'inprocess'; }

  registerHandler<T>(handler: DurableJobHandler<T>): void {
    this.handlers.set(handler.kind, handler as DurableJobHandler<unknown>);
  }

  async enqueue<T>(kind: string, payload: T, opts: EnqueueOptions): Promise<JobHandle> {
    const dedup = `${kind}:${opts.idempotencyKey}`;
    if (this.seenIdempotency.has(dedup)) {
      return { jobId: dedup, kind, enqueuedAt: new Date().toISOString() };
    }
    this.seenIdempotency.add(dedup);
    const job: StoredJob = {
      jobId: dedup,
      kind, payload,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 5,
      backoffBaseMs: opts.backoffBaseMs ?? 100,
      idempotencyKey: opts.idempotencyKey,
      traceId: opts.traceId ?? cryptoRandom(),
      partitionKey: opts.partitionKey,
      status: 'pending',
    };
    this.log.push(job);
    if (this.started) await this.drain();
    return { jobId: job.jobId, kind, enqueuedAt: job.enqueuedAt };
  }

  async start(): Promise<void> { this.started = true; await this.drain(); }
  async stop(): Promise<void> { this.started = false; }
  async deadLetterSize(): Promise<number> { return this.dlq.length; }

  async replay(kind: string, opts?: { fromCursor?: string; maxItems?: number }): Promise<number> {
    const cursor = opts?.fromCursor;
    const max = opts?.maxItems ?? Number.POSITIVE_INFINITY;
    let count = 0;
    for (const j of this.log) {
      if (j.kind !== kind) continue;
      if (cursor && j.enqueuedAt < cursor) continue;
      if (count >= max) break;
      const h = this.handlers.get(kind);
      if (!h) continue;
      const ctx: JobContext = { traceId: j.traceId, attempt: 1, enqueuedAt: j.enqueuedAt, idempotencyKey: j.idempotencyKey, ...(j.partitionKey !== undefined ? { partitionKey: j.partitionKey } : {}) };
      await h.handle(j.payload, ctx);
      count++;
    }
    return count;
  }

  private async drain(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      // Partition-aware serial drain: at most one running job per partitionKey.
      const runningPartitions = new Set<string>();
      for (const job of this.log) {
        if (job.status !== 'pending') continue;
        const pk = job.partitionKey ?? job.jobId;
        if (runningPartitions.has(pk)) continue;
        runningPartitions.add(pk);
        progressed = true;
        await this.runJob(job);
      }
    }
  }

  private async runJob(job: StoredJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) throw new JobBusError(`no handler registered for ${job.kind}`);
    job.status = 'running';
    while (job.attempts < job.maxAttempts) {
      job.attempts++;
      const ctx: JobContext = { traceId: job.traceId, attempt: job.attempts, enqueuedAt: job.enqueuedAt, idempotencyKey: job.idempotencyKey, ...(job.partitionKey !== undefined ? { partitionKey: job.partitionKey } : {}) };
      try {
        await handler.handle(job.payload, ctx);
        job.status = 'done';
        return;
      } catch (err) {
        job.lastError = (err as Error).message;
        if (job.attempts >= job.maxAttempts) {
          if (handler.compensate) { try { await handler.compensate(job.payload, ctx, err as Error); } catch { /* swallow */ } }
          job.status = 'failed';
          this.dlq.push(job);
          return;
        }
        // exponential backoff — no real sleep in-process; the loop just retries.
      }
    }
  }
}

function cryptoRandom(): string { return Math.random().toString(36).slice(2, 18); }
