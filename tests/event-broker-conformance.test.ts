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

// Phase 3 — EventBroker conformance suite. ONE suite run per driver:
//   • inprocess  — always (CI, deterministic sync delivery)
//   • rabbitmq   — against an in-memory fake amqplib SDK (driver logic, no infra)
//   • redis-streams / bullmq — gated: run when RUN_REAL_BROKER_TESTS=1 with a
//     reachable Redis (HH_REDIS_URL or a testcontainers Redis).
// Covers: publish N → consume N, ordering per partition key, idempotency,
// DLQ on handler failure, health, and outbox replay-from-cursor.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { StreamBinding, StreamMessage } from '../src/adapters/event-stream.js';
import type { EventBroker } from '../src/server/event-broker.js';
import { encodeCanonicalEvent, decodeCanonicalEvent, EVENT_TOPIC_EVENTS } from '../src/server/event-broker.js';
import { InProcessEventBroker } from '../src/server/inprocess-event-broker.js';
import { RedisStreamsEventBroker } from '../src/server/redis-streams-event-broker.js';
import { BullMqEventBroker } from '../src/server/bullmq-event-broker.js';
import { RabbitMqEventBroker } from '../src/server/rabbitmq-event-broker.js';
import { SqsSnsEventBroker } from '../src/server/sqs-sns-event-broker.js';
import { NatsEventBroker } from '../src/server/nats-event-broker.js';
import { PubSubEventBroker } from '../src/server/pubsub-event-broker.js';
import { EventHubsEventBroker } from '../src/server/event-hubs-event-broker.js';
import { getSqlStore } from '../src/server/sql/index.js';
import { SqlEventOutbox } from '../src/server/event-outbox.js';
import { effectToCanonicalEvent, effectKindToEventType } from '../src/server/realm-event-bridge.js';

// ---------------------------------------------------------------- helpers

let seq = 0;
function makeEvent(i: number, overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  seq += 1;
  const now = new Date(Date.now() + seq).toISOString();
  return {
    id: `evt-${seq}`,
    type: 'lab.result-arrived',
    occurredAt: now,
    scopeId: 'scope:facility-1',
    subjectId: `patient-${i}`,
    facilityId: 'f1',
    payload: { value: i, marker: `m${i}` },
    provenance: { sourceId: 'conformance', observedAt: now, ingestedAt: now },
    classification: 'phi',
    ...overrides,
  };
}

const BINDING: StreamBinding = { topic: 'anant.canonical.events', source: 'conformance', eventType: 'patient.registered', subjectPath: 'subjectId' };

async function waitFor(cond: () => boolean, timeoutMs = 6000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Run the core conformance assertions against a fresh broker. */
async function runCoreConformance(name: string, make: () => Promise<{ broker: EventBroker; cleanup?: () => Promise<void> }>, asyncDelivery = false): Promise<void> {
  const { broker, cleanup } = await make();
  const received: StreamMessage[] = [];
  const topic = `${EVENT_TOPIC_EVENTS}.${name}`;
  const binding: StreamBinding = { ...BINDING, topic };
  await broker.subscribe(binding, async (msg) => { received.push(msg); });
  await broker.start();

  // publish N → consume N
  const events = [makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4), makeEvent(5)];
  for (const e of events) await broker.publish({ topic, event: e }, { partitionKey: e.scopeId });
  if (asyncDelivery) await waitFor(() => received.length >= events.length, 15000);
  expect(received.length).toBe(events.length);

  // ordering per partition key — decode values in delivery order
  const decoded = received.map((m) => decodeCanonicalEvent(m.value));
  expect(decoded.map((d) => d?.payload['marker'])).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

  // idempotency — the same event id published twice must be delivered at-least-once;
  // broker-level dedup (BullMQ jobId) or consumer dedup by x-event-id collapses to one.
  const dup = makeEvent(6);
  await broker.publish({ topic, event: dup, headers: { 'x-event-id': dup.id } });
  await broker.publish({ topic, event: dup, headers: { 'x-event-id': dup.id } });
  if (asyncDelivery) await waitFor(() => received.some((m) => m.headers?.['x-event-id'] === dup.id), 15000);
  const dupDeliveries = received.filter((m) => m.headers?.['x-event-id'] === dup.id).length;
  expect(dupDeliveries).toBeGreaterThanOrEqual(1);

  // health
  const health = await broker.health();
  expect(health.ok).toBe(true);
  expect(health.driver).toBe(name);

  await broker.stop();
  await cleanup?.();
}

// ---------------------------------------------------------------- inprocess (always)

describe('EventBroker conformance — inprocess (CI)', () => {
  it('publish→consume, ordering, idempotency, health', async () => {
    await runCoreConformance('inprocess', async () => ({
      broker: new InProcessEventBroker({ maxAttempts: 2, backoffBaseMs: 5 }),
      cleanup: async () => {},
    }));
  });

  it('dead-letters a handler that fails past maxAttempts', async () => {
    const broker = new InProcessEventBroker({ maxAttempts: 2, backoffBaseMs: 1 });
    const topic = 'anant.canonical.events.dlq';
    const failing = async (): Promise<void> => { throw new Error('boom'); };
    await broker.subscribe({ ...BINDING, topic }, failing);
    await broker.start();
    await broker.publish({ topic, event: makeEvent(1) });
    await broker.publish({ topic, event: makeEvent(2) });
    expect(await broker.deadLetterSize()).toBe(2);
    await broker.stop();
  });
});

// ---------------------------------------------------------------- rabbitmq (fake SDK)

interface FakeMsg { content: Buffer; properties: { messageId?: string; headers?: Record<string, string>; timestamp?: number }; fields: { exchange: string; routingKey: string }; }
interface FakeQueue { messages: FakeMsg[]; consumers: Array<(m: FakeMsg) => void>; }

/** Compact in-memory amqplib stand-in that drives the RabbitMq driver logic. */
function makeFakeAmqp() {
  const exchanges = new Map<string, { queues: string[] }>();
  const queues = new Map<string, FakeQueue>();
  const deliver = (q: string): void => {
    const entry = queues.get(q);
    if (!entry || entry.consumers.length === 0) return;
    const msg = entry.messages.shift();
    if (msg) for (const c of entry.consumers) c(msg);
  };
  const channel = {
    async assertExchange(name: string) { if (!exchanges.has(name)) exchanges.set(name, { queues: [] }); return {}; },
    async assertQueue(name: string) { if (!queues.has(name)) queues.set(name, { messages: [], consumers: [] }); return { queue: name, messageCount: 0, consumerCount: 0 }; },
    async bindQueue(queue: string, exchange: string) { const ex = exchanges.get(exchange); if (ex && !ex.queues.includes(queue)) ex.queues.push(queue); return {}; },
    publish(exchange: string, key: string, buffer: Buffer, opts?: Record<string, unknown>): boolean {
      const ex = exchanges.get(exchange);
      if (!ex) return false;
      for (const q of ex.queues) {
        const entry = queues.get(q);
        if (!entry) continue;
        entry.messages.push({
          content: buffer,
          properties: {
            ...(opts?.messageId !== undefined ? { messageId: opts.messageId as string } : {}),
            ...(opts?.headers !== undefined ? { headers: opts.headers as Record<string, string> } : {}),
            timestamp: Math.floor(Date.now() / 1000),
          },
          fields: { exchange, routingKey: key },
        });
        setImmediate(() => deliver(q));
      }
      return true;
    },
    async consume(queue: string, cb: (m: FakeMsg | null) => void) { const entry = queues.get(queue); if (entry) entry.consumers.push(cb as (m: FakeMsg) => void); return {}; },
    ack(_m: FakeMsg) { /* delivered */ },
    nack(_m: FakeMsg) {
      // simulate dead-letter routing: move to the topic's .dlq queue
      for (const [name, entry] of queues) {
        if (name.endsWith('.dlq')) { entry.messages.push({ ..._m }); setImmediate(() => deliver(name)); }
      }
    },
    async checkQueue(q: string) { const e = queues.get(q); return { queue: q, messageCount: e?.messages.length ?? 0, consumerCount: e?.consumers.length ?? 0 }; },
    async close() { /* noop */ },
  };
  return {
    async connect() { return { createChannel: async () => channel, createConfirmChannel: async () => channel, close: async () => {} }; },
  };
}

describe('EventBroker conformance — rabbitmq (fake amqplib SDK)', () => {
  it('publish→consume round-trip through the driver', async () => {
    await runCoreConformance('rabbitmq', async () => ({
      broker: new RabbitMqEventBroker({ url: 'amqp://fake', maxAttempts: 2, sdk: makeFakeAmqp() as never }),
      cleanup: async () => {},
    }), true);
  });

  it('dead-letters a failing handler into the DLQ queue', async () => {
    const broker = new RabbitMqEventBroker({ url: 'amqp://fake', maxAttempts: 2, sdk: makeFakeAmqp() as never });
    const topic = 'anant.canonical.events.rdlq';
    const failing = async (): Promise<void> => { throw new Error('boom'); };
    await broker.subscribe({ ...BINDING, topic }, failing);
    await broker.start();
    await broker.publish({ topic, event: makeEvent(1) });
    const start = Date.now();
    while ((await broker.deadLetterSize()) === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await broker.deadLetterSize()).toBeGreaterThan(0);
    await broker.stop();
  });
});

// ---------------------------------------------------------------- lazy-SDK drivers (structural)

describe('EventBroker drivers — missing optional SDKs', () => {
  it('lazy-require throws a clear error for uninstalled SDKs', async () => {
    const cases: Array<() => EventBroker> = [
      () => new RabbitMqEventBroker({ url: 'amqp://localhost' }),
      () => new NatsEventBroker({ url: 'nats://localhost' }),
      () => new SqsSnsEventBroker({ topicArn: 'arn', queueUrl: 'https://sqs' }),
      () => new PubSubEventBroker({ projectId: 'proj' }),
      () => new EventHubsEventBroker({ connectionString: 'Endpoint=x', eventHubName: 'hub' }),
    ];
    for (const make of cases) {
      const broker = make();
      await expect(broker.publish({ topic: EVENT_TOPIC_EVENTS, event: makeEvent(1) })).rejects.toThrow(/requires optional dependency|driver|connect|started/i);
    }
  });

  it('effectKindToEventType maps clinical effects to canonical types', () => {
    expect(effectKindToEventType('admit-patient')).toBe('hospitalization.admitted');
    expect(effectKindToEventType('result-lab')).toBe('lab.result-arrived');
    expect(effectKindToEventType('order-med')).toBe('medication.ordered');
    expect(effectKindToEventType('record-vitals')).toBe('vital.observed');
  });
});

// ---------------------------------------------------------------- outbox replay + bridge (sqlite)

describe('EventBroker fabric — outbox replay + realm→broker bridge', () => {  it('replays delivered events from a cursor', async () => {
    const store = await getSqlStore();
    await store.clearOutbox();
    const broker = new InProcessEventBroker();
    await broker.start();
    const outbox = new SqlEventOutbox(store, EVENT_TOPIC_EVENTS);

    const e1 = makeEvent(1); const e2 = makeEvent(2);
    await outbox.enqueue(e1); await outbox.enqueue(e2);
    expect(await outbox.flush(broker)).toBe(2);
    const counts = await outbox.counts();
    expect(counts).toMatchObject({ pending: 0, delivered: 2 });

    // replay after a cursor → both re-published
    let seen = 0;
    await broker.subscribe(BINDING, async () => { seen += 1; });
    const replayed = await outbox.replay(broker, { since: new Date(0).toISOString() });
    expect(replayed).toBe(2);
    expect(seen).toBe(2);
    await broker.stop();
    await store.clearOutbox();
  });

  it('bridge projects a realm effect to a canonical event', () => {
    const emitted = {
      effectId: 'fx-1', presenceId: 'pr-1', agentSpecId: 'md-1',
      emittedAt: '2026-08-16T01:00:00Z', realmAt: '2026-08-16T00:00:00Z',
      effect: { kind: 'admit-patient', patientId: 'p1', facilityId: 'f1', unitId: 'U1' },
      status: 'bound',
    } as never;
    const event = effectToCanonicalEvent(emitted, { realmId: 'realm:r1', facilityId: 'f1', scopeId: 'realm:r1' });
    expect(event.id).toBe('event:realm:realm:r1:fx-1');
    expect(event.type).toBe('hospitalization.admitted');
    expect(event.subjectId).toBe('p1');
    expect(event.classification).toBe('phi');
    expect((event.payload as { realmId: string }).realmId).toBe('realm:r1');
  });
});

// ---------------------------------------------------------------- real brokers (gated)

const RUN_REAL = process.env.RUN_REAL_BROKER_TESTS === '1';

describe.skipIf(!RUN_REAL)('EventBroker conformance — real brokers (RUN_REAL_BROKER_TESTS=1)', () => {
  let redisUrl = process.env.HH_REDIS_URL ?? '';
  let container: { stop(): Promise<unknown> } | undefined;

  beforeAll(async () => {
    if (!redisUrl) {
      const { RedisContainer } = await import('@testcontainers/redis');
      const started = await new RedisContainer('redis:7-alpine').start();
      redisUrl = started.getConnectionUrl();
      container = started;
    }
  }, 120000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  it('redis-streams — publish→consume, ordering, idempotency, health', async () => {
    await runCoreConformance('redis-streams', async () => ({
      broker: new RedisStreamsEventBroker({ url: redisUrl, group: `conformance-${Date.now()}`, consumer: `c-${Date.now()}`, pollMs: 30 }),
      cleanup: async () => {},
    }), true);
  }, 20000);

  it('bullmq — publish→consume, ordering, idempotency, health', async () => {
    await runCoreConformance('bullmq', async () => ({
      broker: new BullMqEventBroker({ url: redisUrl, maxAttempts: 2, backoffMs: 5 }),
      cleanup: async () => {},
    }), true);
  }, 20000);
});
