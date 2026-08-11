import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { dialysisProviderPack } from '../packs/dialysis-provider/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

/** Minimal in-memory stand-in that satisfies the `PostgresEventStore` surface used by the app. */
function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents(q: { scopeId: string; types?: readonly string[]; since?: string; until?: string; limit?: number }) {
      let out = events.filter((e) => e.scopeId === q.scopeId);
      if (q.types) out = out.filter((e) => q.types!.includes(e.type));
      if (q.since) out = out.filter((e) => e.occurredAt >= q.since!);
      if (q.until) out = out.filter((e) => e.occurredAt < q.until!);
      if (q.limit) out = out.slice(0, q.limit);
      return out;
    },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger(q: { scopeId: string; transactionAt?: string; kinds?: readonly LedgerEntry['kind'][]; limit?: number }) {
      let out = ledger.slice();
      if (q.kinds) out = out.filter((e) => q.kinds!.includes(e.kind));
      if (q.transactionAt) out = out.filter((e) => e.transactionAt <= q.transactionAt!);
      if (q.limit) out = out.slice(0, q.limit);
      return out;
    },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
  return store;
}

function actorFor(actor: ActorContext) {
  return async () => actor;
}

const powerUser: ActorContext = {
  actorRef: 'user:md-1', scopeIds: ['scope:facility-1'], purposeOfUse: 'treatment', clearance: 'phi',
};
const readonlyOps: ActorContext = {
  actorRef: 'user:ops-1', scopeIds: ['scope:facility-1'], purposeOfUse: 'operations', clearance: 'internal',
};

const sampleEvent: CanonicalEvent = {
  id: 'ev:1', type: 'lab.result-arrived', occurredAt: '2026-01-01T00:00:00Z',
  scopeId: 'scope:facility-1', subjectId: 'p1', facilityId: 'f1',
  classification: 'phi',
  provenance: { sourceId: 'lab-x', observedAt: '2026-01-01T00:00:00Z', ingestedAt: '2026-01-01T00:00:00Z' },
  payload: { code: 'HGB', value: 10.4 },
};

describe('control-plane API', () => {
  it('GET /health returns readiness', async () => {
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack, dialysisProviderPack],
      authenticate: actorFor(powerUser),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: true, redis: true });
    await app.close();
  });

  it('GET /packs lists installed packs with capabilities', async () => {
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack, dialysisProviderPack],
      authenticate: actorFor(powerUser),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    const res = await app.inject({ method: 'GET', url: '/packs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { packs: Array<{ id: string; capabilities: string[] }> };
    const ids = body.packs.map((p) => p.id);
    expect(ids).toContain('healthcare-core');
    expect(ids).toContain('dialysis-provider');
    await app.close();
  });

  it('POST /events succeeds for scoped PHI actor and stores the event', async () => {
    const store = inMemoryStore();
    const app = await buildApp({
      store,
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: actorFor(powerUser),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    const res = await app.inject({ method: 'POST', url: '/events', payload: sampleEvent });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/events?scopeId=scope:facility-1' });
    expect((list.json() as { events: CanonicalEvent[] }).events.length).toBe(1);
    await app.close();
  });

  it('GET /events filters out events beyond actor clearance', async () => {
    const store = inMemoryStore();
    // Seed with PHI actor first.
    let app = await buildApp({
      store,
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: actorFor(powerUser),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    await app.inject({ method: 'POST', url: '/events', payload: sampleEvent });
    await app.close();
    // Same store, now internal-only actor cannot see PHI events.
    app = await buildApp({
      store,
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: actorFor(readonlyOps),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    const list = await app.inject({ method: 'GET', url: '/events?scopeId=scope:facility-1' });
    expect((list.json() as { events: CanonicalEvent[] }).events.length).toBe(0);
    await app.close();
  });

  it('POST /events rejects out-of-scope writes with 403', async () => {
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: actorFor({ ...powerUser, scopeIds: ['scope:facility-other'] }),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    const res = await app.inject({ method: 'POST', url: '/events', payload: sampleEvent });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('propagates x-trace-id header', async () => {
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: actorFor(powerUser),
      checkHealth: async () => ({ db: true, redis: true }),
    });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-trace-id': 'abc-123' } });
    expect(res.headers['x-trace-id']).toBe('abc-123');
    await app.close();
  });
});
