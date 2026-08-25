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

// Azure Event Hubs EventBroker driver (optional dep — lazy load). Publish =
// EventHubProducerClient.sendBatch (partitionKey → ordering); consume =
// EventHubConsumerClient with a consumer group; failures are logged (Event Hubs
// has no per-message nack — redelivery relies on checkpointing).

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

// Minimal structural types for the @azure/event-hubs surface we use (SDK not installed).
interface EventData { body: unknown; properties?: Record<string, string | number | boolean | Date | null | undefined>; partitionKey?: string; }
interface EventHubProducerClient {
  sendBatch(batch: Array<EventData>): Promise<void>;
  getEventHubProperties(): Promise<{ name: string; partitionIds: string[] }>;
  close(): Promise<void>;
}
interface EventHubConsumerClient { subscribe(opts: { processEvents: (events: Array<{ body: unknown; properties?: Record<string, unknown>; sequenceNumber?: number; enqueuedTime?: Date; partitionKey?: string | null }>, ctx: unknown) => Promise<void>; processError: (err: Error, ctx: unknown) => Promise<void> }): { close(): Promise<void> }; close(): Promise<void>; }
interface EventHubsLib { EventHubProducerClient: new (connectionString: string, eventHubName: string, opts?: Record<string, unknown>) => EventHubProducerClient; EventHubConsumerClient: new (consumerGroup: string, connectionString: string, eventHubName: string, opts?: Record<string, unknown>) => EventHubConsumerClient; }

export interface EventHubsEventBrokerDeps {
  readonly connectionString: string;
  readonly eventHubName: string;
  readonly consumerGroup?: string;
  /** Injected `@azure/event-hubs` for tests (defaults to lazy require). */
  readonly sdk?: EventHubsLib;
}

export class EventHubsEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'event-hubs';
  private readonly connectionString: string;
  private readonly eventHubName: string;
  private readonly consumerGroup: string;
  private readonly getSdk: () => EventHubsLib;
  private producer?: EventHubProducerClient;
  private consumer?: EventHubConsumerClient;
  private started = false;

  constructor(deps: EventHubsEventBrokerDeps) {
    this.connectionString = deps.connectionString;
    this.eventHubName = deps.eventHubName;
    this.consumerGroup = deps.consumerGroup ?? '$Default';
    this.getSdk = deps.sdk ? () => deps.sdk! : lazyRequire<EventHubsLib>('@azure/event-hubs');
  }

  async start(): Promise<void> {
    const sdk = this.getSdk();
    this.producer = new sdk.EventHubProducerClient(this.connectionString, this.eventHubName);
    this.started = true;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    if (!this.producer) throw new Error('event-hubs broker not started');
    const data: EventData = {
      body: { value: encodeCanonicalEvent(record.event), key: opts?.partitionKey ?? record.event.id },
      properties: { 'x-event-id': record.event.id },
      ...(opts?.partitionKey ? { partitionKey: opts.partitionKey } : {}),
    };
    await this.producer.sendBatch([data]);
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    const sdk = this.getSdk();
    this.consumer = new sdk.EventHubConsumerClient(this.consumerGroup, this.connectionString, this.eventHubName);
    await this.consumer.subscribe({
      processEvents: async (events) => {
        for (const ev of events) {
          const body = ev.body as { value?: string; key?: string } | undefined;
          const msg: StreamMessage = {
            topic: binding.topic,
            partition: 0,
            offset: String(ev.sequenceNumber ?? ''),
            key: ev.partitionKey ?? body?.key ?? null,
            value: body?.value ?? '',
            ...(ev.properties ? { headers: ev.properties as Record<string, string> } : {}),
            timestamp: ev.enqueuedTime ? new Date(ev.enqueuedTime).toISOString() : new Date().toISOString(),
          };
          try { await handler(msg); } catch { /* checkpoint later redelivers */ }
        }
      },
      processError: async () => { /* transient */ },
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.producer) { try { await this.producer.close(); } catch { /* ignore */ } }
    if (this.consumer) { try { await this.consumer.close(); } catch { /* ignore */ } }
  }

  async health(): Promise<EventBrokerHealth> {
    try {
      if (!this.producer) return { ok: false, driver: 'event-hubs' };
      await this.producer.getEventHubProperties();
      return { ok: true, driver: 'event-hubs', detail: this.eventHubName };
    } catch (err) {
      return { ok: false, driver: 'event-hubs', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async deadLetterSize(): Promise<number> { return 0; }
}
