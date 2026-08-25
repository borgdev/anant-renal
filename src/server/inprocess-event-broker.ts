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

// In-process EventBroker driver — dev + tests. Synchronous ring-buffer
// delivery with retry/backoff and an in-memory dead-letter list.

import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';
import {
  encodeCanonicalEvent,
  type EventBroker,
  type EventBrokerDriver,
  type EventBrokerHealth,
  type EventBrokerPublishOptions,
  type EventBrokerRecord,
} from './event-broker.js';

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export interface InProcessEventBrokerOptions {
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
}

interface Sub {
  readonly binding: StreamBinding;
  readonly handler: (msg: StreamMessage) => Promise<void>;
}

export class InProcessEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'inprocess';
  private readonly subs = new Map<string, Sub[]>();
  private readonly deadLetters: string[] = [];
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private seq = 0;
  private running = false;

  constructor(opts: InProcessEventBrokerOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 50;
  }

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    const subs = this.subs.get(record.topic) ?? [];
    if (subs.length === 0) return;
    const msg: StreamMessage = {
      topic: record.topic,
      partition: 0,
      offset: String(++this.seq),
      key: opts?.partitionKey ?? record.event.id,
      value: encodeCanonicalEvent(record.event),
      headers: { ...(record.headers ?? {}), 'x-event-id': record.event.id },
      timestamp: record.event.occurredAt,
    };
    for (const sub of subs) {
      let attempt = 0;
      let ok = false;
      while (!ok && attempt < this.maxAttempts) {
        attempt += 1;
        try {
          await sub.handler(msg);
          ok = true;
        } catch {
          if (attempt >= this.maxAttempts) {
            this.deadLetters.push(msg.value);
          } else {
            await sleep(this.backoffBaseMs * 2 ** (attempt - 1));
          }
        }
      }
    }
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    const arr = this.subs.get(binding.topic) ?? [];
    arr.push({ binding, handler });
    this.subs.set(binding.topic, arr);
  }

  async health(): Promise<EventBrokerHealth> { return { ok: this.running, driver: 'inprocess' }; }
  async deadLetterSize(): Promise<number> { return this.deadLetters.length; }
}
