/******************************************************************************
 * R0 — live event wall (bounded canonical-event ring + /api/live/* routes).
 *
 * Pure unit coverage for `src/server/live-event-feed.ts` plus route-level checks
 * that the live tail, filters, status and the SSE `?once=1` snapshot all work
 * without any external broker (the feed is pushed directly — deterministic).
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent, CanonicalEventType } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { LiveEventFeed, type LiveEventRow } from '../src/server/live-event-feed.js';

const AT = '2026-09-01T09:00:00.000Z';

function ev(id: string, type: CanonicalEventType, realm: string, facility: string): CanonicalEvent {
  return {
    id,
    type,
    occurredAt: AT,
    scopeId: realm,
    subjectId: `patient:${id}`,
    ...(facility ? { facilityId: facility } : {}),
    payload: { patientId: id, source: 'test' },
    provenance: { sourceId: 'test:seed', observedAt: AT, ingestedAt: AT },
    classification: 'confidential',
  } as CanonicalEvent;
}

/* ---------- pure feed ---------- */

describe('LiveEventFeed', () => {
  it('retains a newest-first bounded ring', () => {
    const feed = new LiveEventFeed('inprocess', 'anant.canonical.events', 3);
    feed.push(ev('ev-1', 'lab.result-arrived', 'realm:r1', 'fac-1'));
    feed.push(ev('ev-2', 'vital.observed', 'realm:r1', 'fac-1'));
    feed.push(ev('ev-3', 'treatment.completed', 'realm:r1', 'fac-1'));
    feed.push(ev('ev-4', 'lab.result-arrived', 'realm:r2', 'fac-2'));
    feed.push(ev('ev-5', 'vital.observed', 'realm:r2', 'fac-2'));
    expect(feed.size()).toBe(3);
    expect(feed.rows().map((r) => r.eventId)).toEqual(['ev-5', 'ev-4', 'ev-3']);
  });

  it('maps canonical fields onto the row shape', () => {
    const feed = new LiveEventFeed('inprocess', 't');
    feed.push(ev('ev-1', 'lab.result-arrived', 'realm:r1', 'fac-1'));
    const row = feed.rows()[0] as LiveEventRow;
    expect(row.eventId).toBe('ev-1');
    expect(row.eventType).toBe('lab.result-arrived');
    expect(row.realmId).toBe('realm:r1');
    expect(row.facilityId).toBe('fac-1');
    expect(row.subjectId).toBe('patient:ev-1');
    expect(row.patientId).toBe('ev-1');
    expect(row.recordedTime).toBe(AT);
    expect(row.sourceSystem).toBe('broker');
  });

  it('filters the tail by facility/realm and caps limit', () => {
    const feed = new LiveEventFeed('inprocess', 't', 100);
    feed.push(ev('ev-1', 'lab.result-arrived', 'realm:r1', 'fac-1'));
    feed.push(ev('ev-2', 'vital.observed', 'realm:r1', 'fac-2'));
    feed.push(ev('ev-3', 'treatment.completed', 'realm:r2', 'fac-1'));
    expect(feed.rows({ facilityId: 'fac-1' }).map((r) => r.eventId)).toEqual(['ev-3', 'ev-1']);
    expect(feed.rows({ realmId: 'realm:r1' }).map((r) => r.eventId)).toEqual(['ev-2', 'ev-1']);
    expect(feed.rows({ facilityId: 'fac-1', realmId: 'realm:r2' }).map((r) => r.eventId)).toEqual(['ev-3']);
    expect(feed.rows({ limit: 1 }).length).toBe(1);
  });

  it('notifies subscribers on push and unsubscribes cleanly', () => {
    const feed = new LiveEventFeed('inprocess', 't');
    const seen: string[] = [];
    const off = feed.subscribe((row) => seen.push(row.eventId));
    feed.push(ev('ev-1', 'lab.result-arrived', 'realm:r1', 'fac-1'));
    feed.push(ev('ev-2', 'vital.observed', 'realm:r1', 'fac-1'));
    expect(seen).toEqual(['ev-1', 'ev-2']);
    off();
    feed.push(ev('ev-3', 'treatment.completed', 'realm:r1', 'fac-1'));
    expect(seen).toEqual(['ev-1', 'ev-2']);
  });
});

/* ---------- routes ---------- */

function inMemoryStore() {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, event: CanonicalEvent) { events.push(event); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}
const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;
type App = Awaited<ReturnType<typeof build>>;
async function build(feed: LiveEventFeed) {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    liveEventFeed: feed,
  });
}

describe('live wall routes (/api/live/*)', () => {
  let app: App;
  let feed: LiveEventFeed;
  beforeAll(async () => {
    feed = new LiveEventFeed('inprocess', 'anant.canonical.events', 200);
    feed.push(ev('ev-1', 'lab.result-arrived', 'realm:r1', 'fac-1'));
    feed.push(ev('ev-2', 'vital.observed', 'realm:r1', 'fac-2'));
    feed.push(ev('ev-3', 'treatment.completed', 'realm:r2', 'fac-1'));
    app = await build(feed);
  });
  afterAll(async () => { await app.close(); });

  it('GET /api/live/status reports the driver, topic and retained count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/live/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().driver).toBe('inprocess');
    expect(res.json().topic).toBe('anant.canonical.events');
    expect(res.json().retained).toBe(3);
  });

  it('GET /api/live/events returns the newest-first tail', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/live/events' });
    const body = res.json();
    expect(body.events.map((e: { eventId: string }) => e.eventId)).toEqual(['ev-3', 'ev-2', 'ev-1']);
    expect(body.retained).toBe(3);
  });

  it('GET /api/live/events filters by facility and realm', async () => {
    const byFac = await app.inject({ method: 'GET', url: '/api/live/events?facilityId=fac-1' });
    expect(byFac.json().events.map((e: { eventId: string }) => e.eventId)).toEqual(['ev-3', 'ev-1']);
    const byRealm = await app.inject({ method: 'GET', url: '/api/live/events?realmId=realm:r2' });
    expect(byRealm.json().events.map((e: { eventId: string }) => e.eventId)).toEqual(['ev-3']);
    const capped = await app.inject({ method: 'GET', url: '/api/live/events?limit=1' });
    expect(capped.json().events.length).toBe(1);
  });

  it('GET /api/live/stream?once=1 writes an SSE snapshot then closes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/live/stream?once=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const text = String(res.body);
    expect(text).toContain('event: hello');
    expect(text).toContain('event: events');
    expect(text).toContain('"eventId":"ev-3"');
  });
});
