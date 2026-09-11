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

// Transactional-outbox publish path for CanonicalEvents (Phase 0).
//
// The event append and the outbox row are written back-to-back; a flusher
// drains pending rows to the EventBroker and marks them delivered
// (at-least-once, idempotent by event.id). Works identically on SQLite and
// Postgres via the portable SqlStore.

import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { SqlStore } from './sql/sql-store.js';
import { EVENT_TOPIC_EVENTS, decodeCanonicalEvent, type EventBroker } from './event-broker.js';

export interface EventOutbox {
  enqueue(event: CanonicalEvent, opts?: { topic?: string; scopeId?: string }): Promise<void>;
  flush(broker: EventBroker, opts?: { limit?: number; maxAttempts?: number }): Promise<number>;
  counts(): Promise<{ pending: number; delivered: number; dead: number }>;
  /** Re-publish already-delivered events after a cursor (replay-from-cursor). */
  replay(broker: EventBroker, opts?: { since?: string; limit?: number }): Promise<number>;
}

export class SqlEventOutbox implements EventOutbox {
  /**
   * Collapse concurrent drains into one.
   *
   * `flush` is called from TWO places — the publisher's interval and the write
   * path's per-event hook — so at any real event rate the calls overlap and every
   * one of them sweeps the SAME oldest rows, multiplying store work by the event
   * rate until the connection pool is exhausted and the process saturates (observed
   * as 103% CPU, /health timing out, and zero delivery progress). Whichever caller
   * arrives while a drain is running joins it and gets its result.
   */
  private inFlight: Promise<number> | undefined;

  constructor(private readonly store: SqlStore, private readonly topic: string = EVENT_TOPIC_EVENTS) {}

  async enqueue(event: CanonicalEvent, opts?: { topic?: string; scopeId?: string }): Promise<void> {
    await this.store.enqueueOutboxEvent({
      id: event.id,
      topic: opts?.topic ?? this.topic,
      scopeId: opts?.scopeId ?? event.scopeId,
      eventJson: JSON.stringify(event),
    });
  }

  async flush(broker: EventBroker, opts?: { limit?: number; maxAttempts?: number; maxTotal?: number }): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const run = this.drain(broker, opts);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async drain(broker: EventBroker, opts?: { limit?: number; maxAttempts?: number; maxTotal?: number }): Promise<number> {
    const limit = opts?.limit ?? 50;
    const maxAttempts = opts?.maxAttempts ?? 3;
    // `limit` is the BATCH size, so without a total cap one call keeps looping
    // until the queue is empty — measured at 35,754 rows / 52s against the
    // fastest possible broker, while producers kept adding faster than that. A
    // drain attempt that outlives its own trigger interval cannot catch up, and
    // it also means a single request/interval tick can monopolise the store.
    // Work is now bounded per call; the publisher's next tick continues.
    const maxTotal = opts?.maxTotal ?? 500;
    let delivered = 0;
    for (;;) {
      const rows = await this.store.pendingOutboxEvents(limit);
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = decodeCanonicalEvent(row.eventJson);
        try {
          if (!event) throw new Error('undecodable outbox event');
          await broker.publish({ topic: row.topic, event, headers: { 'x-event-id': row.id } }, { partitionKey: row.scopeId });
          await this.store.markOutboxDelivered(row.id);
          delivered += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const nextAttemptAt = new Date(Date.now() + 1000).toISOString();
          await this.store.markOutboxFailed(row.id, message, maxAttempts, nextAttemptAt);
        }
      }
      if (rows.length < limit) break;
      if (delivered >= maxTotal) break;
    }
    return delivered;
  }

  /** Re-publish delivered events after `since` (ISO delivered_at cursor). */
  async replay(broker: EventBroker, opts?: { since?: string; limit?: number }): Promise<number> {
    const since = opts?.since ?? new Date(0).toISOString();
    const limit = opts?.limit ?? 200;
    const rows = await this.store.deliveredOutboxEventsSince(since, limit);
    let republished = 0;
    for (const row of rows) {
      const event = decodeCanonicalEvent(row.eventJson);
      if (!event) continue;
      await broker.publish({ topic: row.topic, event, headers: { 'x-event-id': row.id, 'x-replay': 'true' } }, { partitionKey: row.scopeId });
      republished += 1;
    }
    return republished;
  }

  async counts(): Promise<{ pending: number; delivered: number; dead: number }> {
    return this.store.outboxCounts();
  }
}

export interface OutboxPublisherOptions {
  flushIntervalMs?: number;
  limit?: number;
  maxAttempts?: number;
}

/**
 * Periodic outbox flusher — drains the transactional outbox to the broker on an
 * interval with bounded concurrency. Keeps pending near-zero in steady state.
 */
export class OutboxPublisher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight = false;
  private readonly flushIntervalMs: number;
  private readonly limit: number;
  private readonly maxAttempts: number;
  private readonly onFlush: ((delivered: number) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;

  constructor(
    private readonly outbox: EventOutbox,
    private readonly broker: EventBroker,
    opts: OutboxPublisherOptions & { onFlush?: (delivered: number) => void; onError?: (err: unknown) => void } = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.limit = opts.limit ?? 50;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.onFlush = opts.onFlush;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<number> {
    if (!this.running) return 0;
    // One flush at a time. `setInterval` does not wait for an async callback, so
    // a slow drain previously stacked overlapping calls that all walked the SAME
    // oldest rows: duplicated publish attempts, and each tick's progress measured
    // against a queue the other ticks were still holding. A tick that arrives
    // while the previous one is running is simply skipped — bounded work per tick
    // (see EventOutbox.flush) means the next one makes progress.
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const delivered = await this.outbox.flush(this.broker, { limit: this.limit, maxAttempts: this.maxAttempts });
      if (delivered > 0) this.onFlush?.(delivered);
      return delivered;
    } catch (err) {
      // Never let a store failure become an unhandled rejection: the publisher is
      // fire-and-forget, so silence here would look like an idle broker.
      this.onError?.(err);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }

  async counts(): Promise<{ pending: number; delivered: number; dead: number }> {
    return this.outbox.counts();
  }
}
