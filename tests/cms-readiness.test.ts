import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('CMS QIP readiness (real cms-data/)', () => {
  it('serves per-measure readiness derived from the public CMS CSVs', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/cms/readiness' });
    expect(res.statusCode).toBe(200);
    const r = res.json().readiness;
    // cms-data/ ships in the repo → the loader returns REAL derived readiness.
    expect(r.source).toBe('real');
    expect(r.measures.length).toBeGreaterThanOrEqual(5);
    for (const m of r.measures) {
      expect(m.measure).toBeTruthy();
      expect(m.complete).toBeGreaterThan(0);
      expect(m.records).toMatch(/^[\d,]+ \/ [\d,]+$/);
      expect(['ready', 'review', 'gap']).toContain(m.state);
    }
    // The facility listing dataset has thousands of dialysis facilities.
    expect(r.totals.facilities).toBeGreaterThan(1000);
    expect(r.national).toBeTruthy();
  });
});
