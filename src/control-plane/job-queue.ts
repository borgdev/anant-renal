// Durable job queue with retries, backoff, idempotency keys, dead-letter, and
// compensation callbacks. In-process reference implementation — the interfaces
// are what packs consume; production swaps in a Redis/Postgres backing store
// without changing pack code.

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'compensated';

export interface JobRecord<TInput = unknown, TResult = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly input: TInput;
  readonly enqueuedAt: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly status: JobStatus;
  readonly lastError?: string;
  readonly result?: TResult;
  readonly traceId: string;
  readonly compensationKind?: string;
}

export interface JobHandler<TInput = unknown, TResult = unknown> {
  readonly kind: string;
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  handle(input: TInput, ctx: { attempt: number; traceId: string }): Promise<TResult>;
  compensate?(input: TInput, result: TResult | undefined, ctx: { traceId: string }): Promise<void>;
}

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly dlq: JobRecord[] = [];

  constructor(private readonly clock: Clock = systemClock) {}

  registerHandler<TInput, TResult>(handler: JobHandler<TInput, TResult>): void {
    this.handlers.set(handler.kind, handler as JobHandler);
  }

  enqueue<TInput>(kind: string, input: TInput, idempotencyKey: string, traceId: string): JobRecord<TInput> {
    const existing = Array.from(this.jobs.values()).find((j) => j.kind === kind && j.idempotencyKey === idempotencyKey);
    if (existing) return existing as JobRecord<TInput>;
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`Unknown job kind: ${kind}`);
    const rec: JobRecord<TInput> = {
      id: `job:${kind}:${idempotencyKey}:${this.clock.now().toISOString()}`,
      kind,
      idempotencyKey,
      input,
      enqueuedAt: this.clock.now().toISOString(),
      attempts: 0,
      maxAttempts: handler.maxAttempts,
      nextAttemptAt: this.clock.now().toISOString(),
      status: 'queued',
      traceId,
    };
    this.jobs.set(rec.id, rec as JobRecord);
    return rec;
  }

  async runOnce(now: Date = this.clock.now()): Promise<{ processed: number; dead: number }> {
    let processed = 0;
    let dead = 0;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'queued') continue;
      if (Date.parse(job.nextAttemptAt) > now.getTime()) continue;
      const handler = this.handlers.get(job.kind);
      if (!handler) continue;
      const attempt = job.attempts + 1;
      const running: JobRecord = { ...job, status: 'running', attempts: attempt };
      this.jobs.set(id, running);
      try {
        const result = await handler.handle(job.input, { attempt, traceId: job.traceId });
        this.jobs.set(id, { ...running, status: 'succeeded', result });
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= handler.maxAttempts) {
          const failed: JobRecord = { ...running, status: 'dead', lastError: msg };
          this.jobs.set(id, failed);
          this.dlq.push(failed);
          dead++;
          if (handler.compensate) {
            try { await handler.compensate(job.input, undefined, { traceId: job.traceId }); this.jobs.set(id, { ...failed, status: 'compensated' }); } catch { /* leave dead */ }
          }
        } else {
          const backoff = Math.min(handler.maxBackoffMs, handler.initialBackoffMs * Math.pow(2, attempt - 1));
          const nextAt = new Date(now.getTime() + backoff).toISOString();
          this.jobs.set(id, { ...running, status: 'queued', nextAttemptAt: nextAt, lastError: msg });
        }
      }
    }
    return { processed, dead };
  }

  list(): readonly JobRecord[] { return Array.from(this.jobs.values()); }
  deadLetterQueue(): readonly JobRecord[] { return this.dlq; }
}
