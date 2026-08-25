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

// Redis Streams EventBroker driver (ioredis). Topic = stream key; consumer
// group + XREADGROUP with XACK after successful handling.

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

export interface RedisStreamsEventBrokerDeps {
  readonly url: string;
  readonly group?: string;
  readonly consumer?: string;
  readonly pollMs?: number;
}

interface BoundSub {
  readonly binding: StreamBinding;
  readonly handler: (msg: StreamMessage) => Promise<void>;
}

function field(fields: readonly string[], name: string): string {
  const i = fields.indexOf(name);
  return i >= 0 && i + 1 < fields.length ? fields[i + 1] ?? '' : '';
}

export class RedisStreamsEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'redis-streams';
  private readonly redis: Redis;
  private readonly group: string;
  private readonly consumer: string;
  private readonly pollMs: number;
  private readonly subs = new Map<string, BoundSub[]>();
  private started = false;
  private timer?: NodeJS.Timeout;

  constructor(deps: RedisStreamsEventBrokerDeps) {
    this.redis = new Redis(deps.url);
    this.group = deps.group ?? 'anant-events';
    this.consumer = deps.consumer ?? `anant-${process.pid}`;
    this.pollMs = deps.pollMs ?? 200;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    await this.redis.xadd(
      record.topic,
      '*',
      'key', opts?.partitionKey ?? record.event.id,
      'value', encodeCanonicalEvent(record.event),
      'x-event-id', record.event.id,
    );
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    const arr = this.subs.get(binding.topic) ?? [];
    arr.push({ binding, handler });
    this.subs.set(binding.topic, arr);
  }

  async start(): Promise<void> {
    for (const topic of this.subs.keys()) {
      await this.redis.xgroup('CREATE', topic, this.group, '0', 'MKSTREAM').catch(() => undefined);
    }
    this.started = true;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.started = false;
    this.redis.disconnect();
  }

  private async poll(): Promise<void> {
    if (!this.started) return;
    for (const [topic, subs] of this.subs) {
      try {
        const res = (await this.redis.xreadgroup(
          'GROUP', this.group, this.consumer, 'COUNT', 10, 'BLOCK', 1, 'STREAMS', topic, '>',
        )) as unknown as [string, [string, string[]][]][] | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const entry of entries) {
            const id = entry[0];
            const fieldsArr = entry[1];
            const value = field(fieldsArr, 'value');
            const key = field(fieldsArr, 'key');
            const eventId = field(fieldsArr, 'x-event-id');
            const msg: StreamMessage = {
              topic, partition: 0, offset: id, key: key || null, value,
              ...(eventId ? { headers: { 'x-event-id': eventId } } : {}),
              timestamp: new Date().toISOString(),
            };
            for (const sub of subs) {
              try { await sub.handler(msg); } catch { /* Phase 3: DLQ stream */ }
            }
            await this.redis.xack(topic, this.group, id);
          }
        }
      } catch { /* transient */ }
    }
  }

  async health(): Promise<EventBrokerHealth> {
    let ok = false;
    try { ok = (await this.redis.ping()) === 'PONG'; } catch { ok = false; }
    return { ok, driver: 'redis-streams' };
  }

  // DLQ stream policy lands with Phase 3 breadth.
  async deadLetterSize(): Promise<number> { return 0; }
}
