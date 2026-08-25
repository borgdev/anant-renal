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

// Google Cloud Pub/Sub EventBroker driver (optional dep — lazy load). Topic →
// a Pub/Sub topic `hh-<topic>`; publish with orderingKey = partition key (topic
// must be message-ordering-enabled); consume via a pull subscription; nack on
// handler failure → redelivery → dead-letter topic.

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

// Minimal structural types for the Pub/Sub surface we use (SDK not installed).
interface PubSubMessage { id: string; data: Buffer; attributes?: Record<string, string>; publishTime?: string; orderingKey?: string; ack(): void; nack(): void; }
interface PubSubSubscription {
  on(event: 'message', cb: (msg: PubSubMessage) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(): Promise<void>;
}
interface PubSubTopic { name: string; publishMessage(msg: { data: Buffer; attributes?: Record<string, string>; orderingKey?: string }): Promise<string>; exists(): Promise<[boolean]>; createSubscription(name: string, opts?: Record<string, unknown>): Promise<PubSubSubscription>; }
interface PubSubClient { topic(name: string): PubSubTopic; subscription(name: string): PubSubSubscription; close(): Promise<void>; }
interface PubSubLib { PubSub: new (opts?: Record<string, unknown>) => PubSubClient; }

export interface PubSubEventBrokerDeps {
  readonly projectId: string;
  readonly topicBase?: string;
  readonly subscriptionSuffix?: string;
  readonly maxAttempts?: number;
  /** Injected `@google-cloud/pubsub` for tests (defaults to lazy require). */
  readonly sdk?: PubSubLib;
}

function sanitize(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

export class PubSubEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'pubsub';
  private readonly projectId: string;
  private readonly topicBase: string;
  private readonly subscriptionSuffix: string;
  private readonly maxAttempts: number;
  private readonly getSdk: () => PubSubLib;
  private client?: PubSubClient;
  private readonly topics = new Map<string, PubSubTopic>();
  private readonly subs = new Map<string, PubSubSubscription>();
  private started = false;

  constructor(deps: PubSubEventBrokerDeps) {
    this.projectId = deps.projectId;
    this.topicBase = deps.topicBase ?? 'projects/anant-health/topics';
    this.subscriptionSuffix = deps.subscriptionSuffix ?? `anant-${process.pid}`;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.getSdk = deps.sdk ? () => deps.sdk! : lazyRequire<PubSubLib>('@google-cloud/pubsub');
  }

  private topicName(topic: string): string { return `${this.topicBase}/hh-${sanitize(topic)}`; }

  private async topic(topic: string): Promise<PubSubTopic> {
    let t = this.topics.get(topic);
    if (!t) {
      const { PubSub } = this.getSdk();
      this.client ??= new PubSub({ projectId: this.projectId });
      t = this.client.topic(this.topicName(topic));
      const [exists] = await t.exists();
      if (!exists) await t.publishMessage({ data: Buffer.from('') }); // ordering topics need a warm message
      this.topics.set(topic, t);
    }
    return t;
  }

  async start(): Promise<void> {
    const { PubSub } = this.getSdk();
    this.client ??= new PubSub({ projectId: this.projectId });
    this.started = true;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    const t = await this.topic(record.topic);
    await t.publishMessage({
      data: Buffer.from(encodeCanonicalEvent(record.event)),
      attributes: { 'x-event-id': record.event.id, ...(record.headers ?? {}) },
      ...(opts?.partitionKey ? { orderingKey: opts.partitionKey } : {}),
    });
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    const t = await this.topic(binding.topic);
    const subName = `hh-${sanitize(binding.topic)}-${this.subscriptionSuffix}`;
    let sub: PubSubSubscription;
    try {
      sub = await t.createSubscription(subName, { ackDeadlineSeconds: 60 });
    } catch {
      // already exists — reuse it
      const { PubSub } = this.getSdk();
      this.client ??= new PubSub({ projectId: this.projectId });
      sub = this.client.subscription(subName);
    }
    this.subs.set(binding.topic, sub);
    sub.on('message', (msg) => {
      void (async () => {
        const streamMsg: StreamMessage = {
          topic: binding.topic, partition: 0, offset: msg.id, key: msg.orderingKey ?? null,
          value: msg.data.toString(), ...(msg.attributes ? { headers: msg.attributes } : {}),
          timestamp: msg.publishTime ?? new Date().toISOString(),
        };
        try { await handler(streamMsg); msg.ack(); } catch { msg.nack(); }
      })();
    });
    sub.on('error', () => { /* transient */ });
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const s of this.subs.values()) { try { await s.close(); } catch { /* ignore */ } }
    if (this.client) { try { await this.client.close(); } catch { /* ignore */ } }
  }

  async health(): Promise<EventBrokerHealth> {
    try {
      const t = await this.topic('anant.canonical.events');
      const [exists] = await t.exists();
      return { ok: this.started && exists, driver: 'pubsub', detail: this.projectId };
    } catch (err) {
      return { ok: false, driver: 'pubsub', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // No native DLQ depth without a dead-letter subscription — expose 0.
  async deadLetterSize(): Promise<number> { return 0; }
}
