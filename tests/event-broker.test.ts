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

// Phase 0 — EventBroker seam + transactional outbox conformance.
// The inprocess driver runs in CI; real-broker drivers (kafka/redis-streams)
// run the same suite when their env is configured (Phase 3 breadth).

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { InProcessEventBroker } from '../src/server/inprocess-event-broker.js';
import { createEventBroker } from '../src/server/event-broker-factory.js';
import { EVENT_TOPIC_EVENTS, decodeCanonicalEvent } from '../src/server/event-broker.js';
import { SqlEventOutbox } from '../src/server/event-outbox.js';
import { getSqlStore } from '../src/server/sql/index.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';

function ev(id: string, type: string = 'patient.registered'): CanonicalEvent {
  return {
    id,
    type: type as CanonicalEvent['type'],
    occurredAt: new Date().toISOString(),
    scopeId: 'scope:f1',
    subjectId: 'pat-1',
    facilityId: 'f1',
    payload: {},
    provenance: { sourceId: 'test', observedAt: new Date().toISOString(), ingestedAt: new Date().toISOString() },
    classification: 'phi',
  };
}

const BINDING = { topic: EVENT_TOPIC_EVENTS, source: 'test', eventType: 'patient.registered' as const, subjectPath: 'subjectId' };

describe('EventBroker — inprocess driver', () => {
  it('round-trips publish → subscribe in order', async () => {
    const b = new InProcessEventBroker();
    await b.start();
    const got: string[] = [];
    await b.subscribe(BINDING, async (m) => { got.push(decodeCanonicalEvent(m.value)!.id); });
    await b.publish({ topic: EVENT_TOPIC_EVENTS, event: ev('e1') });
    await b.publish({ topic: EVENT_TOPIC_EVENTS, event: ev('e2') });
    expect(got).toEqual(['e1', 'e2']);
    expect((await b.health()).ok).toBe(true);
    await b.stop();
  });

  it('dead-letters after maxAttempts', async () => {
    const b = new InProcessEventBroker({ maxAttempts: 2 });
    await b.start();
    await b.subscribe(BINDING, async () => { throw new Error('boom'); });
    await b.publish({ topic: EVENT_TOPIC_EVENTS, event: ev('e1') });
    expect(await b.deadLetterSize()).toBe(1);
    await b.stop();
  });

  it('factory selects inprocess and requires config for SDK-backed drivers', () => {
    expect(createEventBroker({ driver: 'inprocess' }).driver).toBe('inprocess');
    // SDK-backed drivers need their config; missing config throws a clear error.
    expect(() => createEventBroker({ driver: 'rabbitmq' })).toThrow(/requires rabbitmq.url/);
    expect(() => createEventBroker({ driver: 'nats' })).toThrow(/requires nats.url/);
    expect(() => createEventBroker({ driver: 'sqs-sns' })).toThrow(/requires topicArn/);
    // with config, the driver constructs (SDK lazy-loads only on first use)
    expect(createEventBroker({ driver: 'rabbitmq', rabbitmq: { url: 'amqp://localhost' } }).driver).toBe('rabbitmq');
  });
});

describe('SqlEventOutbox — transactional outbox publish path', () => {
  beforeAll(async () => { await getSqlStore(); });
  beforeEach(async () => { await (await getSqlStore()).clearOutbox(); });

  it('enqueue is idempotent by event id', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store);
    await outbox.enqueue(ev('outbox-1'));
    await outbox.enqueue(ev('outbox-1'));
    const c = await outbox.counts();
    expect(c.pending).toBe(1);
  });

  it('flush delivers pending to the broker and marks delivered', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store);
    const broker = new InProcessEventBroker();
    await broker.start();
    const got: string[] = [];
    await broker.subscribe(BINDING, async (m) => { got.push(decodeCanonicalEvent(m.value)!.id); });
    await outbox.enqueue(ev('outbox-2'));
    const delivered = await outbox.flush(broker);
    expect(delivered).toBe(1);
    expect(got).toEqual(['outbox-2']);
    const c = await outbox.counts();
    expect(c.delivered).toBe(1);
    expect(c.pending).toBe(0);
    await broker.stop();
  });

  it('dead-letters undecodable rows after maxAttempts', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store);
    const broker = new InProcessEventBroker();
    await broker.start();
    await store.enqueueOutboxEvent({ id: 'outbox-bad', topic: EVENT_TOPIC_EVENTS, scopeId: 's', eventJson: 'not-json' });
    const delivered = await outbox.flush(broker, { maxAttempts: 1 });
    expect(delivered).toBe(0);
    const c = await outbox.counts();
    expect(c.dead).toBe(1);
    await broker.stop();
  });
});
