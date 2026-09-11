/******************************************************************************
 * Outbox drain contract + bridge delivery semantics.
 *
 * These guard the failure that took the dev process down: `flush` was called from
 * TWO places (the realm→broker bridge per effect, and the publisher's interval) and
 * had no total cap, so each call tried to drain the entire queue while concurrent
 * calls swept the same oldest rows. Measured result: 103% CPU, /health timing out
 * entirely, and zero delivery progress while the backlog grew without bound.
 ******************************************************************************/

import { describe, it, expect, beforeEach } from 'vitest';
import { SqlEventOutbox, OutboxPublisher, type EventOutbox } from '../src/server/event-outbox.js';
import { getSqlStore } from '../src/server/sql/index.js';
import { RealmEventBridge } from '../src/server/realm-event-bridge.js';
import type { EventBroker } from '../src/server/event-broker.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { EmittedEffect } from '../src/realm/types.js';
import type { Realm } from '../src/realm/realm.js';

function event(id: string): CanonicalEvent {
  return {
    id,
    type: 'vital.observed',
    occurredAt: '2026-09-11T00:00:00.000Z',
    scopeId: 'sim:test',
    subjectId: 'p-1',
    provenance: { sourceSystem: 'test' },
  } as unknown as CanonicalEvent;
}

/** Broker double that records what it was asked to publish. */
function recordingBroker(opts: { delayMs?: number } = {}): EventBroker & { published: string[] } {
  const published: string[] = [];
  return {
    published,
    driver: 'inprocess',
    async publish(record: { topic: string; event: CanonicalEvent }) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      published.push(record.event.id);
    },
    async subscribe() { /* noop */ },
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async deadLetterSize() { return 0; },
    async health() { return { ok: true }; },
  } as unknown as EventBroker & { published: string[] };
}

describe('outbox drain is bounded and single-flight', () => {
  beforeEach(async () => {
    // NODE_ENV=test → in-memory SQLite, so each test starts from an empty outbox.
    await (await getSqlStore()).clearOutbox();
  });

  it('stops at maxTotal instead of draining the whole queue', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store, 'test.topic');
    for (let i = 0; i < 20; i += 1) await outbox.enqueue(event(`e-${i}`));

    const broker = recordingBroker();
    const delivered = await outbox.flush(broker, { limit: 5, maxTotal: 5 });

    expect(delivered).toBe(5);
    expect(broker.published).toHaveLength(5);
    // work is bounded, not finished — the next tick continues
    expect((await store.outboxCounts()).pending).toBe(15);
  });

  it('collapses concurrent drains so an event is published once', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store, 'test.topic');
    for (let i = 0; i < 10; i += 1) await outbox.enqueue(event(`c-${i}`));

    // the slow publish widens the window in which overlapping drains would collide
    const broker = recordingBroker({ delayMs: 5 });
    const [a, b] = await Promise.all([
      outbox.flush(broker, { limit: 10, maxTotal: 100 }),
      outbox.flush(broker, { limit: 10, maxTotal: 100 }),
    ]);

    // the second caller joins the first drain rather than starting a second one
    expect(a).toBe(10);
    expect(b).toBe(10);
    expect(broker.published).toHaveLength(10);
    expect(new Set(broker.published).size).toBe(10);
  });

  it('reports counts as numbers, never BigInt strings', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store, 'test.topic');
    await outbox.enqueue(event('n-1'));
    const counts = await outbox.counts();
    // Postgres returns COUNT(*) as a string; an uncoerced value leaks into /health
    // and into arithmetic (e.g. alert thresholds).
    expect(typeof counts.pending).toBe('number');
    expect(typeof counts.delivered).toBe('number');
    expect(typeof counts.dead).toBe('number');
  });

  it('keeps a failed flush from rejecting out of the publisher', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store, 'test.topic');
    await outbox.enqueue(event('x-1'));
    const errors: unknown[] = [];
    const publisher = new OutboxPublisher(
      { ...outbox, flush: async () => { throw new Error('store down'); } } as unknown as EventOutbox,
      recordingBroker(),
      { flushIntervalMs: 10_000, onError: (e) => errors.push(e) },
    );
    await publisher.start();
    // an unhandled rejection here would crash the process (Node 22)
    expect(await publisher.flush()).toBe(0);
    expect(errors).toHaveLength(1);
    publisher.stop();
  });
});

describe('the bridge enqueues durably instead of publishing per effect', () => {
  beforeEach(async () => {
    await (await getSqlStore()).clearOutbox();
  });

  function fakeRealm(id: string): { realm: Realm; emit: (effect: EmittedEffect) => void } {
    const listeners: Array<(e: EmittedEffect) => void> = [];
    const realm = {
      id,
      graph: { listKind: () => [{ state: { id: 'f1' } }] },
      ledger: { onAppend: (cb: (e: EmittedEffect) => void) => { listeners.push(cb); return () => undefined; } },
    } as unknown as Realm;
    return { realm, emit: (e) => { for (const l of listeners) l(e); } };
  }

  it('writes a durable row and publishes nothing itself', async () => {
    const store = await getSqlStore();
    const outbox = new SqlEventOutbox(store, 'test.topic');
    const broker = recordingBroker();
    const bridge = new RealmEventBridge({ broker, outbox });
    const { realm, emit } = fakeRealm('realm:bridge-test');
    bridge.attach(realm);

    emit({
      effectId: 'eff-1', presenceId: 'pres-1', agentSpecId: 'agent-1',
      emittedAt: '2026-09-11T00:00:01.000Z', realmAt: '2026-09-11T00:00:01.000Z',
      status: 'bound',
      effect: { kind: 'record-vitals', patientId: 'p-1', hr: 88, spo2: 96, bp: '128/78' },
    } as unknown as EmittedEffect);
    await new Promise((r) => setTimeout(r, 0));

    const stats = bridge.snapshot();
    expect(stats.queued).toBe(1);
    // the write path no longer sweeps the outbox — that was the amplification
    expect(stats.published).toBe(0);
    expect(broker.published).toHaveLength(0);
    expect((await store.outboxCounts()).pending).toBe(1);

    // delivery is the publisher's job, and the row is durable until it happens
    const delivered = await outbox.flush(broker, { limit: 10, maxTotal: 10 });
    expect(delivered).toBe(1);
    expect(broker.published).toEqual(['event:realm:realm:bridge-test:eff-1']);
  });
});
