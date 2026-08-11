// BullMQ-backed JobBus driver.
//
// Implements the JobBus port over Redis via BullMQ. Idempotency uses BullMQ's
// jobId dedup. Retries use BullMQ's exponential backoff. Dead-letter is a
// separate queue we append to on final attempt. Replay reruns handlers over
// completed job records (up to BullMQ's retention window; older data must be
// replayed from the canonical event stream).

import { Queue, Worker, QueueEvents } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { JobBus, JobContext, DurableJobHandler, EnqueueOptions, JobHandle } from './job-bus.js';
import { JobBusError } from './job-bus.js';

export interface BullMQJobBusOptions {
  readonly connection: ConnectionOptions;
  readonly queueName?: string;
  readonly deadLetterQueueName?: string;
  readonly concurrency?: number;
}

export class BullMQJobBus implements JobBus {
  private readonly queue: Queue;
  private readonly dlq: Queue;
  private readonly events: QueueEvents;
  private readonly handlers = new Map<string, DurableJobHandler<unknown>>();
  private readonly concurrency: number;
  private worker: Worker | null = null;

  constructor(opts: BullMQJobBusOptions) {
    const q = opts.queueName ?? 'harness:jobs';
    const d = opts.deadLetterQueueName ?? 'harness:jobs:dlq';
    this.queue = new Queue(q, { connection: opts.connection });
    this.dlq = new Queue(d, { connection: opts.connection });
    this.events = new QueueEvents(q, { connection: opts.connection });
    this.concurrency = opts.concurrency ?? 4;
  }

  driverName(): 'bullmq' { return 'bullmq'; }

  registerHandler<T>(handler: DurableJobHandler<T>): void {
    this.handlers.set(handler.kind, handler as DurableJobHandler<unknown>);
  }

  async enqueue<T>(kind: string, payload: T, opts: EnqueueOptions): Promise<JobHandle> {
    const jobId = `${kind}:${opts.idempotencyKey}`;
    const job = await this.queue.add(
      kind,
      { payload, traceId: opts.traceId ?? cryptoRandom(), idempotencyKey: opts.idempotencyKey, partitionKey: opts.partitionKey ?? null },
      {
        jobId,
        attempts: opts.maxAttempts ?? 5,
        backoff: { type: 'exponential', delay: opts.backoffBaseMs ?? 500 },
        removeOnComplete: 1000,
        removeOnFail: false,
        ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      },
    );
    return { jobId: job.id ?? jobId, kind, enqueuedAt: new Date().toISOString() };
  }

  async start(): Promise<void> {
    if (this.worker) return;
    const connection = (this.queue as unknown as { opts: { connection: ConnectionOptions } }).opts.connection;
    this.worker = new Worker(this.queue.name, async (job) => {
      const handler = this.handlers.get(job.name);
      if (!handler) throw new JobBusError(`no handler for ${job.name}`);
      const data = job.data as { payload: unknown; traceId: string; idempotencyKey: string; partitionKey: string | null };
      const ctx: JobContext = {
        traceId: data.traceId,
        attempt: job.attemptsMade + 1,
        enqueuedAt: new Date(job.timestamp).toISOString(),
        idempotencyKey: data.idempotencyKey,
        ...(data.partitionKey !== null ? { partitionKey: data.partitionKey } : {}),
      };
      try {
        await handler.handle(data.payload, ctx);
      } catch (err) {
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await this.dlq.add(`dead:${job.name}`, { original: data, error: (err as Error).message });
          if (handler.compensate) { try { await handler.compensate(data.payload, ctx, err as Error); } catch { /* swallow */ } }
        }
        throw err;
      }
    }, { connection, concurrency: this.concurrency });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.events.close();
    await this.queue.close();
    await this.dlq.close();
    this.worker = null;
  }

  async deadLetterSize(): Promise<number> {
    return this.dlq.count();
  }

  async replay(kind: string, opts?: { fromCursor?: string; maxItems?: number }): Promise<number> {
    // BullMQ replay: fetch completed jobs of `kind` and re-enqueue them with a
    // suffixed idempotency key so dedup doesn't collapse them onto the original.
    const jobs = await this.queue.getJobs(['completed'], 0, opts?.maxItems ?? 100, false);
    let count = 0;
    for (const j of jobs) {
      if (j.name !== kind) continue;
      const data = j.data as { payload: unknown; traceId: string; idempotencyKey: string; partitionKey: string | null };
      await this.enqueue(kind, data.payload, {
        idempotencyKey: `${data.idempotencyKey}:replay:${Date.now()}`,
        traceId: data.traceId,
        ...(data.partitionKey !== null ? { partitionKey: data.partitionKey } : {}),
      });
      count++;
    }
    return count;
  }
}

function cryptoRandom(): string { return Math.random().toString(36).slice(2, 18); }
