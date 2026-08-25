// Realm-scoped live pages (P0) — the Episodes / Self-models / Attributions
// list endpoints that power the World + "Agents' inner lives" pages with live
// data instead of the static bundled snapshot.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

const actor: ActorContext = { actorRef: 'user:ops', scopeIds: ['realm:r1', 'scope:*'], purposeOfUse: 'operations', clearance: 'restricted-phi' };

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

function makeRealm(id = 'realm:scope1'): string {
  if (RealmRegistry.get(id)) return id;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Scope Dialysis', units: ['U1'], patientCount: 2 });
  realm.start();
  const md = realm.spawnPresence({ agentSpecId: 'md', runId: 'r', role: 'md', clearance: 'restricted-phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' } });
  realm.emit(md.presenceId, { kind: 'admit-patient', patientId: 'f1-pt-0001', facilityId: 'f1', unitId: 'U1' });
  realm.emit(md.presenceId, { kind: 'record-vitals', patientId: 'f1-pt-0001', hr: 84, bp: '132/80', spo2: 96 });
  realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'f1-pt-0001', code: '17861-6', priority: 'routine' });
  return id;
}

describe('realm-scoped live list endpoints', () => {
  it('serves live episodes, self-models, and attributions per realm', async () => {
    const app = await makeApp();
    const id = makeRealm();

    const eps = await app.inject({ method: 'GET', url: `/admin/realms/${id}/episodes` });
    expect(eps.statusCode).toBe(200);
    expect(Array.isArray((eps.json() as { episodes: unknown[] }).episodes)).toBe(true);

    const sm = await app.inject({ method: 'GET', url: `/admin/realms/${id}/self-models` });
    expect(sm.statusCode).toBe(200);
    const smBody = sm.json() as { selfModels: Array<{ presenceId: string; agentSpecId: string; role: string }> };
    expect(Array.isArray(smBody.selfModels)).toBe(true);

    const att = await app.inject({ method: 'GET', url: `/admin/realms/${id}/attributions` });
    expect(att.statusCode).toBe(200);
    const attBody = att.json() as { attributions: unknown[]; stats: { total: number; byOutcome: Record<string, number> } };
    expect(Array.isArray(attBody.attributions)).toBe(true);
    expect(typeof attBody.stats.total).toBe('number');
    expect(attBody.stats.byOutcome).toBeTypeOf('object');

    const fx = await app.inject({ method: 'GET', url: `/admin/realms/${id}/effects` });
    expect(fx.statusCode).toBe(200);
    expect((fx.json() as { effects: unknown[] }).effects.length).toBeGreaterThanOrEqual(3);
  });

  it('404s for unknown realms and supports episode filters', async () => {
    const app = await makeApp();
    const missing = await app.inject({ method: 'GET', url: '/admin/realms/nope/episodes' });
    expect(missing.statusCode).toBe(404);

    const id = makeRealm();
    const filtered = await app.inject({ method: 'GET', url: `/admin/realms/${id}/episodes?status=open` });
    expect(filtered.statusCode).toBe(200);
    expect(Array.isArray((filtered.json() as { episodes: unknown[] }).episodes)).toBe(true);
  });
});
