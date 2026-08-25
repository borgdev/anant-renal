// FHIR/action routes (P2) — entity read, subscription poll validation, and
// realm local-corpus upload used by the FHIR panel + Realm page.

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

function makeRealm(id = 'realm:fx'): string {
  if (RealmRegistry.get(id)) return id;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'FX Dialysis', units: ['U1'], patientCount: 2 });
  realm.start();
  return id;
}

describe('FHIR panel action routes', () => {
  it('reads a realm entity as its FHIR resource', async () => {
    const app = await makeApp();
    const id = makeRealm();
    const res = await app.inject({ method: 'GET', url: `/admin/fhir/entity/${id}/patient/f1-pt-0001` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resourceType: string; id: string };
    expect(body.resourceType).toBe('Patient');
    expect(body.id).toBe('f1-pt-0001');
  });

  it('rejects a subscription poll without a base URL (400, no network)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/fhir/subscription/poll', payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('baseUrl-required');
  });

  it('ingests a realm local-corpus document', async () => {
    const app = await makeApp();
    const id = makeRealm();
    const dataBase64 = Buffer.from('facility protocol v1').toString('base64');
    const res = await app.inject({
      method: 'POST', url: `/admin/realms/${id}/local-corpus`,
      payload: { filename: 'protocol.txt', mimeType: 'text/plain', dataBase64 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; artifactId: string; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe('facility protocol v1'.length);
    expect(body.artifactId).toBeTruthy();
  });
});
