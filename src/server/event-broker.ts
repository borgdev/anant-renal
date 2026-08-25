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

// Pluggable event-broker port (Phase 0 of the enterprise roadmap).
//
// Where JobBus is durable work, EventBroker is streaming events: publish a
// CanonicalEvent to a topic, subscribe a handler to a topic. Drivers land
// underneath — inprocess (dev/tests), kafka, redis-streams, and later
// rabbitmq / nats / sqs-sns / pubsub / event-hubs — selected at boot via
// HH_EVENTBROKER_DRIVER. Runtime code never changes when the driver flips.
//
// Semantics every driver must honor:
//   • at-least-once publish (consumers idempotent by event.id)
//   • ordering per partition key (defaults to scopeId)
//   • dead-lettering on handler failure
//   • trace-id propagation via headers

import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';

export type EventBrokerDriver =
  | 'inprocess' | 'kafka' | 'redis-streams' | 'bullmq'
  | 'rabbitmq' | 'nats' | 'sqs-sns' | 'pubsub' | 'event-hubs';

/** Canonical topic for the platform's own event stream. */
export const EVENT_TOPIC_EVENTS = 'anant.canonical.events';

export interface EventBrokerRecord {
  readonly topic: string;
  readonly event: CanonicalEvent;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EventBrokerPublishOptions {
  readonly partitionKey?: string;
}

export interface EventBrokerHealth {
  readonly ok: boolean;
  readonly driver: EventBrokerDriver;
  readonly detail?: string;
}

export interface EventBroker {
  readonly driver: EventBrokerDriver;
  publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void>;
  subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<EventBrokerHealth>;
  deadLetterSize(): Promise<number>;
}

export class EventBrokerError extends Error {
  constructor(message: string) { super(message); this.name = 'EventBrokerError'; }
}

/** Encode a canonical event for the wire (JSON). */
export function encodeCanonicalEvent(event: CanonicalEvent): string {
  return JSON.stringify(event);
}

/** Decode a wire message into a canonical event; undefined when not one. */
export function decodeCanonicalEvent(value: string): CanonicalEvent | undefined {
  try {
    const e = JSON.parse(value) as CanonicalEvent;
    if (e && typeof e.id === 'string' && typeof e.type === 'string' && typeof e.scopeId === 'string') return e;
    return undefined;
  } catch {
    return undefined;
  }
}
