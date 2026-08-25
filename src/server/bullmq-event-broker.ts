/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// BullMQ EventBroker driver. Topic → a BullMQ queue (prefix `hh-`); publish =
// Queue.add (jobId = event.id for idempotency), consume = Worker. Failed jobs
// (after exponential retry) land in the failed set → DLQ depth.

import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';
import {
  encodeCanonicalEvent,
  type EventBroker,
  type EventBrokerDriver,
  type EventBrokerHealth,
  type EventBrokerPublishOptions,
  type EventBrokerRecord,
} from './event-broker.js';

export interface BullMqEventBrokerDeps {
  readonly url: string;
  readonly prefix?: string;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  /** Optional injected clients (tests) — defaults to real ioredis + bullmq. */
  readonly connection?: unknown;
}

interface JobData { readonly value: string; readonly key: string | null; readonly headers?: Readonly<Record<string, string>>; }

// BullMQ queue names allow only [A-Za-z0-9_-] (no ':', no dots on some versions).
function queueName(topic: string, prefix: string): string { return `${prefix}${topic.replace(/[^A-Za-z0-9_-]/g, '_')}`; }

export class BullMqEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'bullmq';
  private readonly url: string;
  private readonly prefix: string;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly redis: Redis;
  private readonly ownRedis: boolean;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly handlers = new Map<string, (msg: StreamMessage) => Promise<void>>();
  private started = false;

  constructor(deps: BullMqEventBrokerDeps) {
    this.url = deps.url;
    this.prefix = deps.prefix ?? 'hh_';
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.backoffMs = deps.backoffMs ?? 1000;
    this.ownRedis = deps.connection === undefined;
    this.redis = (deps.connection as Redis | undefined) ?? new Redis(this.url, { maxRetriesPerRequest: null });
  }

  private queue(topic: string): Queue {
    const name = queueName(topic, this.prefix);
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.redis,
        defaultJobOptions: { attempts: this.maxAttempts, backoff: { type: 'exponential', delay: this.backoffMs }, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    const data: JobData = { value: encodeCanonicalEvent(record.event), key: opts?.partitionKey ?? record.event.id, headers: { 'x-event-id': record.event.id, ...(record.headers ?? {}) } };
    await this.queue(record.topic).add(record.event.id, data, { jobId: record.event.id }); // jobId ⇒ idempotent
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    this.handlers.set(binding.topic, handler);
  }

  async start(): Promise<void> {
    this.started = true;
    for (const topic of this.handlers.keys()) {
      const name = queueName(topic, this.prefix);
      const worker = new Worker(name, async (job: Job<JobData>) => {
        const msg: StreamMessage = {
          topic, partition: 0, offset: String(job.id), key: job.data.key ?? null, value: job.data.value,
          ...(job.data.headers ? { headers: job.data.headers } : {}),
          timestamp: new Date(job.timestamp).toISOString(),
        };
        await this.handlers.get(topic)?.(msg);
      }, { connection: this.redis, concurrency: 1 });
      this.workers.push(worker);
    }
    await Promise.all(this.workers.map((w) => w.waitUntilReady()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    if (this.ownRedis) this.redis.disconnect();
    this.started = false;
  }

  async health(): Promise<EventBrokerHealth> {
    try {
      const counts = await this.queue('anant.canonical.events').getJobCounts('waiting', 'active', 'completed', 'failed');
      return { ok: this.started && counts !== undefined, driver: 'bullmq' };
    } catch {
      return { ok: false, driver: 'bullmq' };
    }
  }

  async deadLetterSize(): Promise<number> {
    let total = 0;
    for (const name of this.queues.keys()) {
      const q = this.queues.get(name)!;
      const counts = await q.getJobCounts('failed');
      total += counts.failed ?? 0;
    }
    return total;
  }
}
