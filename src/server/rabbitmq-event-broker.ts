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

// RabbitMQ EventBroker driver (amqplib, optional dep — lazy load). Topic →
// a topic exchange `hh-<topic>`; consume from a durable queue bound to it with
// a dead-letter exchange so failed handlers land in the DLQ.

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

// Minimal structural types for the amqplib surface we use (SDK not installed).
interface AmqpChannel {
  assertExchange(name: string, type: string, opts?: Record<string, unknown>): Promise<unknown>;
  assertQueue(name: string, opts?: Record<string, unknown>): Promise<{ queue: string; messageCount: number; consumerCount: number }>;
  bindQueue(queue: string, exchange: string, key: string): Promise<unknown>;
  publish(exchange: string, key: string, buffer: Buffer, opts?: Record<string, unknown>): boolean;
  consume(queue: string, cb: (msg: AmqpMessage | null) => void, opts?: Record<string, unknown>): Promise<unknown>;
  ack(msg: AmqpMessage): void;
  nack(msg: AmqpMessage, allUpTo?: boolean, requeue?: boolean): void;
  checkQueue(queue: string): Promise<{ queue: string; messageCount: number; consumerCount: number }>;
  close(): Promise<void>;
}
interface AmqpMessage { content: Buffer; fields: { exchange: string; routingKey: string }; properties: { messageId?: string; headers?: Record<string, string>; timestamp?: number }; }
interface AmqpConnection { createChannel(): Promise<AmqpChannel>; createConfirmChannel(): Promise<AmqpChannel>; close(): Promise<void>; }
interface AmqpLib { connect(url: string): Promise<AmqpConnection>; }

export interface RabbitMqEventBrokerDeps {
  readonly url: string;
  readonly maxAttempts?: number;
  readonly consumerTag?: string;
  /** Injected amqplib for tests (defaults to lazy require). */
  readonly sdk?: AmqpLib;
}

function sanitize(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

export class RabbitMqEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'rabbitmq';
  private readonly url: string;
  private readonly maxAttempts: number;
  private readonly consumerTag: string;
  private readonly getSdk: () => AmqpLib;
  private conn: AmqpConnection | undefined;
  private publishChannel?: AmqpChannel;
  private readonly consumeChannels = new Map<string, AmqpChannel>();
  private readonly dlqQueues = new Set<string>();
  private started = false;

  constructor(deps: RabbitMqEventBrokerDeps) {
    this.url = deps.url;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.consumerTag = deps.consumerTag ?? `anant-${process.pid}`;
    this.getSdk = deps.sdk ? () => deps.sdk! : lazyRequire<AmqpLib>('amqplib');
  }

  private async ensure(): Promise<void> {
    if (this.conn) return;
    const amqp = this.getSdk();
    const conn = await amqp.connect(this.url);
    const channel = await conn.createChannel();
    this.conn = conn;
    this.publishChannel = channel;
  }

  private exch(topic: string): string { return `hh-${sanitize(topic)}`; }
  private queue(topic: string): string { return `hh-${sanitize(topic)}.${this.consumerTag}`; }
  private dlq(topic: string): string { return `hh-${sanitize(topic)}.dlq`; }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    await this.ensure();
    const ch = this.publishChannel!;
    const exch = this.exch(record.topic);
    await ch.assertExchange(exch, 'topic', { durable: true });
    ch.publish(exch, opts?.partitionKey ?? record.event.id, Buffer.from(encodeCanonicalEvent(record.event)), {
      messageId: record.event.id,
      headers: { 'x-event-id': record.event.id, ...(record.headers ?? {}) },
    });
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    await this.ensure();
    const ch = await this.conn!.createChannel();
    this.consumeChannels.set(binding.topic, ch);
    const exch = this.exch(binding.topic);
    const queue = this.queue(binding.topic);
    const dlq = this.dlq(binding.topic);
    await ch.assertExchange(exch, 'topic', { durable: true });
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: `hh-${sanitize(binding.topic)}.dlx` });
    await ch.assertExchange(`hh-${sanitize(binding.topic)}.dlx`, 'fanout', { durable: true });
    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, `hh-${sanitize(binding.topic)}.dlx`, '#');
    this.dlqQueues.add(dlq);
    await ch.bindQueue(queue, exch, '#');
    await ch.consume(queue, (msg) => {
      if (!msg) return;
      const streamMsg: StreamMessage = {
        topic: binding.topic,
        partition: 0,
        offset: `${msg.fields.routingKey}:${msg.properties.messageId ?? ''}`,
        key: msg.fields.routingKey,
        value: msg.content.toString(),
        ...(msg.properties.headers ? { headers: msg.properties.headers } : {}),
        timestamp: msg.properties.timestamp ? new Date(msg.properties.timestamp * 1000).toISOString() : new Date().toISOString(),
      };
      void (async () => {
        let attempt = 0;
        while (attempt < this.maxAttempts) {
          attempt += 1;
          try {
            await handler(streamMsg);
            ch.ack(msg);
            return;
          } catch {
            // retry via requeue until maxAttempts, then DLQ
          }
        }
        ch.nack(msg, false, false); // → dead-letter exchange
      })();
    }, { noAck: false });
  }

  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> {
    this.started = false;
    for (const ch of this.consumeChannels.values()) { try { await ch.close(); } catch { /* ignore */ } }
    if (this.publishChannel) { try { await this.publishChannel.close(); } catch { /* ignore */ } }
    if (this.conn) { try { await this.conn.close(); } catch { /* ignore */ } }
    this.conn = undefined;
  }

  async health(): Promise<EventBrokerHealth> {
    try {
      await this.ensure();
      return { ok: this.started, driver: 'rabbitmq', detail: this.url };
    } catch (err) {
      return { ok: false, driver: 'rabbitmq', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async deadLetterSize(): Promise<number> {
    if (!this.conn) return 0;
    const ch = await this.conn.createChannel();
    let total = 0;
    for (const queue of this.dlqQueues) {
      try { const r = await ch.checkQueue(queue); total += r.messageCount; } catch { /* transient */ }
    }
    await ch.close();
    return total;
  }
}
