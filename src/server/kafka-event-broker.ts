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

// Kafka EventBroker driver (kafkajs). Topic = Kafka topic; partition key maps
// to the Kafka message key so ordering per partition key is preserved.

import { Kafka, type Consumer, type ConsumerRunConfig, type EachMessagePayload, type KafkaConfig, type Producer } from 'kafkajs';
import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';
import {
  encodeCanonicalEvent,
  type EventBroker,
  type EventBrokerDriver,
  type EventBrokerHealth,
  type EventBrokerPublishOptions,
  type EventBrokerRecord,
} from './event-broker.js';

export interface KafkaEventBrokerDeps {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly groupId?: string;
}

export class KafkaEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'kafka';
  private readonly producer: Producer;
  private readonly consumer: Consumer;
  private readonly groupId: string;
  private readonly handlers = new Map<string, (msg: StreamMessage) => Promise<void>>();
  private started = false;

  constructor(deps: KafkaEventBrokerDeps) {
    const config: KafkaConfig = { clientId: deps.clientId, brokers: [...deps.brokers] };
    const kafka = new Kafka(config);
    this.groupId = deps.groupId ?? 'anant-events';
    this.producer = kafka.producer();
    this.consumer = kafka.consumer({ groupId: this.groupId });
  }

  async start(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    for (const topic of this.handlers.keys()) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
    const run: ConsumerRunConfig = {
      eachMessage: async (payload: EachMessagePayload) => {
        const msg = toStreamMessage(payload);
        const handler = this.handlers.get(payload.topic);
        if (handler) await handler(msg);
      },
    };
    await this.consumer.run(run);
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    await this.producer.disconnect();
    this.started = false;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    await this.producer.send({
      topic: record.topic,
      messages: [{
        key: opts?.partitionKey ?? record.event.id,
        value: encodeCanonicalEvent(record.event),
        headers: { 'x-event-id': record.event.id, ...(record.headers ?? {}) },
      }],
    });
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    this.handlers.set(binding.topic, handler);
    if (this.started) {
      await this.consumer.subscribe({ topic: binding.topic, fromBeginning: false });
    }
  }

  async health(): Promise<EventBrokerHealth> {
    return { ok: this.started, driver: 'kafka' };
  }

  // DLQ topic policy (retry/DLQ topics) lands with Phase 3 breadth.
  async deadLetterSize(): Promise<number> { return 0; }
}

function toStreamMessage(payload: EachMessagePayload): StreamMessage {
  const m = payload.message;
  const headers: Record<string, string> = {};
  if (m.headers) {
    for (const [k, v] of Object.entries(m.headers)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) headers[k] = v.map((x) => (Buffer.isBuffer(x) ? x.toString() : String(x))).join(',');
      else if (typeof v === 'string') headers[k] = v;
      else if (Buffer.isBuffer(v)) headers[k] = v.toString();
      else headers[k] = String(v);
    }
  }
  return {
    topic: payload.topic,
    partition: payload.partition,
    offset: m.offset,
    key: m.key ? m.key.toString() : null,
    value: m.value ? m.value.toString() : '',
    headers,
    timestamp: new Date(Number(m.timestamp)).toISOString(),
  };
}
