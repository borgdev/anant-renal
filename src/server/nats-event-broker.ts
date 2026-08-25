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

// NATS (JetStream) EventBroker driver (optional dep — lazy load). Topic →
// a JetStream subject `hh-<topic>`; publish with msgID = event.id (idempotent),
// consume with an explicit-ack durable consumer; failures are nacked (→ DLQ).

import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';
import {
  encodeCanonicalEvent,
  type EventBroker,
  type EventBrokerDriver,
  type EventBrokerHealth,
  type EventBrokerPublishOptions,
  type EventBrokerRecord,
} from './event-broker.js';
import { lazyRequire } from './lazy-require.js';

// Minimal structural types for the `nats` surface we use (SDK not installed).
interface NatsCodec { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown; }
interface NatsMsg {
  subject: string;
  data: Uint8Array;
  seq: number;
  headers?: Map<string, string>;
  info?: { timestamp?: string };
  ack(): void;
  nak(): void;
  term(): void;
}
interface JetStreamClient {
  publish(subject: string, data: Uint8Array, opts?: { msgID?: string }): Promise<{ seq: number }>;
  subscribe(subject: string, opts: { durable?: string; ack_policy?: string; max_deliver?: number; deliver_policy?: string }): JetStreamSubscription;
  getConsumer(stream: string, durable: string): Promise<{ info(): Promise<{ num_pending: number; num_ack_pending: number }> }>;
}
interface JetStreamSubscription { [Symbol.asyncIterator](): AsyncIterator<NatsMsg>; unsubscribe(): void; }
interface NatsConnection {
  jetstreamManager(): Promise<{ streams: { add(cfg: Record<string, unknown>): Promise<unknown>; info(name: string): Promise<unknown> } }>;
  close(): Promise<void>;
  status(): { type: string };
}
interface NatsLib { connect(opts: Record<string, unknown>): Promise<NatsConnection>; jetstream(conn: NatsConnection): JetStreamClient; StringCodec(): NatsCodec; }

export interface NatsEventBrokerDeps {
  readonly url: string;
  readonly stream?: string;
  readonly maxAttempts?: number;
  readonly consumerPrefix?: string;
  /** Injected `nats` lib for tests (defaults to lazy require). */
  readonly sdk?: NatsLib;
}

function sanitize(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

export class NatsEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'nats';
  private readonly url: string;
  private readonly stream: string;
  private readonly maxAttempts: number;
  private readonly consumerPrefix: string;
  private readonly getSdk: () => NatsLib;
  private conn: NatsConnection | undefined;
  private js?: JetStreamClient;
  private subs: JetStreamSubscription[] = [];
  private started = false;

  constructor(deps: NatsEventBrokerDeps) {
    this.url = deps.url;
    this.stream = deps.stream ?? 'hh-events';
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.consumerPrefix = deps.consumerPrefix ?? `anant-${process.pid}`;
    this.getSdk = deps.sdk ? () => deps.sdk! : lazyRequire<NatsLib>('nats');
  }

  private subject(topic: string): string { return `hh.${sanitize(topic)}`; }

  async start(): Promise<void> {
    const nats = this.getSdk();
    this.conn = await nats.connect({ servers: this.url });
    this.js = nats.jetstream(this.conn);
    // ensure the stream exists (subjects: hh.>)
    try {
      const jsm = await this.conn.jetstreamManager();
      await jsm.streams.add({ name: this.stream, subjects: ['hh.>'], retention: 'limits', max_msgs: 1_000_000, discard: 'old' });
    } catch { /* stream already exists */ }
    this.started = true;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    if (!this.js) throw new Error('nats broker not started');
    const nats = this.getSdk();
    const codec = nats.StringCodec();
    await this.js.publish(this.subject(record.topic), codec.encode(encodeCanonicalEvent(record.event)), {
      msgID: record.event.id, // idempotency
    });
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    if (!this.js) throw new Error('nats broker not started');
    const sub = this.js.subscribe(this.subject(binding.topic), {
      durable: `${this.consumerPrefix}-${sanitize(binding.topic)}`,
      ack_policy: 'explicit',
      max_deliver: this.maxAttempts,
      deliver_policy: 'new',
    });
    this.subs.push(sub);
    void this.pump(sub, binding, handler);
  }

  private async pump(sub: JetStreamSubscription, binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    const nats = this.getSdk();
    const codec = nats.StringCodec();
    for await (const m of sub) {
      const raw = codec.decode(m.data);
      const msg: StreamMessage = {
        topic: binding.topic, partition: 0, offset: String(m.seq), key: m.subject,
        value: typeof raw === 'string' ? raw : JSON.stringify(raw),
        ...(m.headers ? { headers: Object.fromEntries(m.headers.entries()) } : {}),
        timestamp: m.info?.timestamp ?? new Date().toISOString(),
      };
      try {
        await handler(msg);
        m.ack();
      } catch {
        m.nak(); // redeliver until max_deliver, then JetStream DLQ
      }
    }
  }

  async stop(): Promise<void> {
    for (const s of this.subs) { try { s.unsubscribe(); } catch { /* ignore */ } }
    this.subs = [];
    if (this.conn) { try { await this.conn.close(); } catch { /* ignore */ } }
    this.conn = undefined;
    this.started = false;
  }

  async health(): Promise<EventBrokerHealth> {
    return { ok: this.started && this.conn?.status().type === 'CONNECTED', driver: 'nats', detail: this.url };
  }

  async deadLetterSize(): Promise<number> {
    if (!this.js || !this.conn) return 0;
    let total = 0;
    try {
      const jsm = await this.conn.jetstreamManager();
      for (const topic of this.subs.map(() => 'hh.>')) {
        try {
          const info = await jsm.streams.info(this.stream);
          const state = (info as unknown as { state?: { messages?: number; first_seq?: number; last_seq?: number } }).state;
          total += state?.messages ?? 0;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return total;
  }
}
