// Phase A + B + C (+D) — FHIR Bundle ingestion semantics.
//   A: bundle-aware reference resolution (urn:uuid/fullUrl → Type/id) +
//      structural-first ordering so effects never create phantom entities.
//   B: transaction (atomic + rollback) / batch (independent) / collection,
//      entry.request.method (POST/PUT/DELETE/GET) + If-None-Exist dedup,
//      and transaction/batch-response Bundles with per-entry status.
//   C: public /api/v1/fhir endpoint, bundle.id idempotency, message bundles,
//      entry-count size guard (413), and dry-run previews.

import { beforeEach, describe, expect, it } from 'vitest';
import { RealmRegistry } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { ingestFhirBundle, clearBundleIngestLedger, MAX_BUNDLE_ENTRIES } from '../src/fhir/bundle-ingest.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { Bundle, FhirCtx } from '../src/fhir/types.js';

function ctx(realmId: string): FhirCtx {
  return { realmId, facilityId: 'f1', scopeId: realmId, sourceId: 'test', ingestedAt: '2026-08-16T00:00:00.000Z' };
}

function makeRealm(id: string) {
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  realm.start();
  return { realm, hg };
}

function cleanup(...ids: string[]) {
  for (const id of ids) RealmRegistry.remove(id);
}

function makeApp(clearance: 'internal' | 'phi' | 'restricted-phi' = 'restricted-phi', scopeIds: string[] = ['scope:*']) {
  return buildApp({
    store: {
      applyMigrations: async () => undefined,
      appendEvent: async () => undefined,
      queryEvents: async () => [],
      appendLedger: async () => undefined,
      queryLedger: async () => [],
      appendAudit: async () => undefined,
      withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
      saveFhirResource: async () => undefined,
    } as never,
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => ({ actorRef: 'user:test', scopeIds, purposeOfUse: 'operations', clearance }),
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('Phase A — bundle reference resolution + structural-first ingest', () => {
  it('resolves urn:uuid / fullUrl references to the real entry id (no phantom patient)', async () => {
    const { realm } = makeRealm('realm:ba-refs');
    try {
      const bundle: Bundle = {
        resourceType: 'Bundle', type: 'transaction',
        entry: [
          // effect-able ServiceRequest appears FIRST and references the patient by urn:uuid
          { fullUrl: 'urn:uuid:abc-123', resource: { resourceType: 'ServiceRequest', id: 'sr-1', status: 'active', intent: 'order', subject: { reference: 'urn:uuid:abc-123' }, code: { coding: [{ code: '17861-6' }] } } },
          // the Patient entry (id patient-42) carries that fullUrl — appears LATER
          { fullUrl: 'urn:uuid:abc-123', resource: { resourceType: 'Patient', id: 'patient-42', name: [{ family: 'Doe' }], gender: 'female' } },
        ],
      };
      const result = await ingestFhirBundle(realm, ctx('realm:ba-refs'), bundle, {});
      expect(result.rolledBack).toBe(false);
      expect(result.summary.structuralUpserts).toBe(1);
      expect(result.summary.effectsApplied).toBeGreaterThanOrEqual(1);

      // Exactly ONE patient — the referenced patient-42, NOT a phantom "urn:uuid:abc-123".
      const patients = realm.graph.listKind('patient');
      expect(patients.length).toBe(1);
      expect(patients[0]!.id).toBe('patient-42');
      // The order targets that patient.
      const orders = realm.graph.listKind('order');
      expect(orders.length).toBe(1);
      expect((orders[0]!.state as { patientId: string }).patientId).toBe('patient-42');
    } finally {
      cleanup('realm:ba-refs');
    }
  });

  it('#contained-style references resolve to the bundled entity id', async () => {
    const { realm } = makeRealm('realm:ba-contained');
    try {
      const bundle: Bundle = {
        resourceType: 'Bundle', type: 'transaction',
        entry: [
          { resource: { resourceType: 'Encounter', id: 'enc-1', status: 'in-progress', subject: { reference: '#p-ref' } } },
          { resource: { resourceType: 'Patient', id: 'p-ref', name: [{ family: 'C' }], gender: 'female' } },
        ],
      };
      const result = await ingestFhirBundle(realm, ctx('realm:ba-contained'), bundle, {});
      expect(result.rolledBack).toBe(false);
      expect(result.summary.effectsApplied).toBeGreaterThanOrEqual(1); // admit-patient
      const patients = realm.graph.listKind('patient');
      expect(patients.length).toBe(1);
      expect(patients[0]!.id).toBe('p-ref'); // #p-ref resolved to the real patient, no phantom
    } finally {
      cleanup('realm:ba-contained');
    }
  });
});

describe('Phase B — transaction atomicity', () => {
  it('rolls back the whole realm when any entry fails', async () => {
    const { realm } = makeRealm('realm:ba-tx-rollback');
    try {
      realm.graph.create('patient', 'seed-1', { name: 'Seed' });
      const bundle = {
        resourceType: 'Bundle', type: 'transaction',
        entry: [
          { resource: { resourceType: 'Patient', id: 'p-new', name: [{ family: 'New' }], gender: 'female' } },
          { resource: { resourceType: 'Foo', id: 'f-1' } }, // unmapped → fails
        ],
      } as unknown as Bundle;
      const result = await ingestFhirBundle(realm, ctx('realm:ba-tx-rollback'), bundle, {});
      expect(result.mode).toBe('transaction');
      expect(result.rolledBack).toBe(true);
      expect(result.response?.type).toBe('transaction-response');
      expect(result.entries.some((e) => e.status >= 400)).toBe(true);

      // The realm was swapped back to the pre-ingest snapshot.
      const after = RealmRegistry.get('realm:ba-tx-rollback')!;
      expect(after).not.toBe(realm); // swapped
      expect(after.graph.listKind('patient').length).toBe(1);
      expect(after.graph.get(after.graph.urnFor('patient', 'seed-1'))).toBeTruthy();
      expect(after.graph.get(after.graph.urnFor('patient', 'p-new'))).toBeUndefined();
      // transient ingest presence is NOT retained after rollback
      expect(after.presences.list().length).toBe(0);
    } finally {
      cleanup('realm:ba-tx-rollback');
    }
  });

  it('applies a valid transaction and returns a transaction-response Bundle', async () => {
    const { realm } = makeRealm('realm:ba-tx-ok');
    try {
      const bundle: Bundle = {
        resourceType: 'Bundle', type: 'transaction',
        entry: [
          { resource: { resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }], gender: 'female' } },
          { resource: { resourceType: 'Encounter', id: 'enc1', status: 'in-progress', subject: { reference: 'Patient/p1' } } },
        ],
      };
      const result = await ingestFhirBundle(realm, ctx('realm:ba-tx-ok'), bundle, {});
      expect(result.rolledBack).toBe(false);
      expect(result.mode).toBe('transaction');
      expect(result.response?.type).toBe('transaction-response');
      expect(result.entries.length).toBe(2);
      expect(result.entries.every((e) => e.status >= 200 && e.status < 300)).toBe(true);
      expect(result.summary.structuralUpserts).toBe(1);
      expect(result.summary.effectsApplied).toBeGreaterThanOrEqual(1); // admit-patient
      expect(realm.graph.listKind('patient').length).toBe(1);
    } finally {
      cleanup('realm:ba-tx-ok');
    }
  });
});

describe('Phase B — batch independence + request methods', () => {
  it('batch applies good entries independently and reports per-entry errors without rolling back', async () => {
    const { realm } = makeRealm('realm:ba-batch');
    try {
      const bundle = {
        resourceType: 'Bundle', type: 'batch',
        entry: [
          { resource: { resourceType: 'Patient', id: 'p-ok', name: [{ family: 'Ok' }], gender: 'female' } },
          { resource: { resourceType: 'Foo', id: 'bad' } },
        ],
      } as unknown as Bundle;
      const result = await ingestFhirBundle(realm, ctx('realm:ba-batch'), bundle, {});
      expect(result.mode).toBe('batch');
      expect(result.rolledBack).toBe(false);
      expect(result.response?.type).toBe('batch-response');
      expect(result.entries[0]!.status).toBe(201);
      expect(result.entries[1]!.status).toBe(422);
      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(1);
      expect(realm.graph.get(realm.graph.urnFor('patient', 'p-ok'))).toBeTruthy();
    } finally {
      cleanup('realm:ba-batch');
    }
  });

  it('honors entry.request.method: PUT updates, If-None-Exist dedups, GET reads, DELETE removes', async () => {
    const { realm } = makeRealm('realm:ba-methods');
    try {
      realm.graph.create('patient', 'p1', { name: 'Before' });
      const bundle: Bundle = {
        resourceType: 'Bundle', type: 'batch',
        entry: [
          { request: { method: 'PUT', url: 'Patient/p1' }, resource: { resourceType: 'Patient', id: 'p1', name: [{ family: 'After' }], gender: 'female' } },
          { request: { method: 'POST', url: 'Patient/p-dup', ifNoneExist: 'Patient?id=p-dup' }, resource: { resourceType: 'Patient', id: 'p-dup', gender: 'female' } },
          { request: { method: 'POST', url: 'Patient/p-dup', ifNoneExist: 'Patient?id=p-dup' }, resource: { resourceType: 'Patient', id: 'p-dup', gender: 'female' } },
          { request: { method: 'GET', url: 'Patient/p1' }, resource: { resourceType: 'Patient', id: 'p1' } },
          { request: { method: 'DELETE', url: 'Patient/p-dup' }, resource: { resourceType: 'Patient', id: 'p-dup' } },
        ],
      };
      const result = await ingestFhirBundle(realm, ctx('realm:ba-methods'), bundle, {});
      // PUT=200, create=201, dedup=200, GET=200, DELETE=204
      expect(result.entries.map((e) => e.status)).toEqual([200, 201, 200, 200, 204]);
      // PUT actually updated the entity
      const p1 = realm.graph.get(realm.graph.urnFor('patient', 'p1'))!;
      expect((p1.state as { name: unknown }).name).toBe('After');
      // DELETE removed p-dup
      expect(realm.graph.get(realm.graph.urnFor('patient', 'p-dup'))).toBeUndefined();
    } finally {
      cleanup('realm:ba-methods');
    }
  });
});

describe('Phase A/B — HTTP route surface', () => {
  it('POST /admin/fhir/ingest returns transaction-response + rollback flag on atomic failure', async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:ba-http', mode: 'sim' } });
      const res = await app.inject({
        method: 'POST', url: '/admin/fhir/ingest',
        payload: {
          realmId: 'realm:ba-http',
          bundle: {
            resourceType: 'Bundle', type: 'transaction',
            entry: [
              { resource: { resourceType: 'Patient', id: 'http-pt', name: [{ family: 'H' }], gender: 'female' } },
              { resource: { resourceType: 'Bogus', id: 'x' } },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { mode: string; rolledBack: boolean; bundleType: string; response?: { type: string }; hydrated: number };
      expect(body.mode).toBe('transaction');
      expect(body.rolledBack).toBe(true);
      expect(body.bundleType).toBe('transaction');
      expect(body.response?.type).toBe('transaction-response');
      // rolled back — no http-pt patient survived
      const realm = RealmRegistry.get('realm:ba-http')!;
      expect(realm.graph.get(realm.graph.urnFor('patient', 'http-pt'))).toBeUndefined();
    } finally {
      cleanup('realm:ba-http');
      await app.close();
    }
  });
});

describe('Phase C — public endpoint, idempotency, message, size guard, dry-run', () => {
  beforeEach(() => clearBundleIngestLedger());

  it('POST /api/v1/fhir ingests a transaction bundle and returns a transaction-response', async () => {
    const app = await makeApp('restricted-phi');
    try {
      await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:pub', mode: 'sim' } });
      const res = await app.inject({
        method: 'POST', url: '/api/v1/fhir',
        payload: {
          realmId: 'realm:pub',
          bundle: {
            resourceType: 'Bundle', type: 'transaction', id: 'bundle-pub-1',
            entry: [
              { resource: { resourceType: 'Patient', id: 'pub-pt', name: [{ family: 'P' }], gender: 'female' } },
              { resource: { resourceType: 'Encounter', id: 'pub-enc', status: 'in-progress', subject: { reference: 'Patient/pub-pt' } } },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { mode: string; rolledBack: boolean; response?: { type: string }; applied: number };
      expect(body.mode).toBe('transaction');
      expect(body.rolledBack).toBe(false);
      expect(body.response?.type).toBe('transaction-response');
      expect(body.applied).toBe(2);
      expect(RealmRegistry.get('realm:pub')!.graph.listKind('patient').length).toBe(1);
    } finally {
      cleanup('realm:pub');
      await app.close();
    }
  });

  it('denies /api/v1/fhir below phi clearance', async () => {
    const app = await makeApp('internal');
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/fhir', payload: { realmId: 'realm:pub', bundle: { resourceType: 'Bundle', type: 'collection', entry: [] } } });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: string }).error).toBe('clearance-denied');
    } finally {
      await app.close();
    }
  });

  it('reconciles a repeated bundle by id (idempotent, no double-apply) and 409s on content mismatch', async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:idem', mode: 'sim' } });
      const payload = (name: string) => ({
        realmId: 'realm:idem',
        bundle: {
          resourceType: 'Bundle', type: 'transaction', id: 'bundle-idem',
          entry: [{ resource: { resourceType: 'Patient', id: 'idem-pt', name: [{ family: name }], gender: 'female' } }],
        },
      });
      const first = await app.inject({ method: 'POST', url: '/admin/fhir/ingest', payload: payload('First') });
      expect(first.statusCode).toBe(200);
      // Same id + same content → replay, no duplicate patient.
      const second = await app.inject({ method: 'POST', url: '/admin/fhir/ingest', payload: payload('First') });
      expect(second.statusCode).toBe(200);
      expect((second.json() as { duplicate: boolean }).duplicate).toBe(true);
      expect(RealmRegistry.get('realm:idem')!.graph.listKind('patient').length).toBe(1);
      // Same id + different content → 409 conflict.
      const conflict = await app.inject({ method: 'POST', url: '/admin/fhir/ingest', payload: payload('Changed') });
      expect(conflict.statusCode).toBe(409);
      expect((conflict.json() as { error: string }).error).toBe('bundle-conflict');
    } finally {
      cleanup('realm:idem');
      await app.close();
    }
  });

  it('processes a message bundle and returns a message-response with an OperationOutcome', async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:msg', mode: 'sim' } });
      const res = await app.inject({
        method: 'POST', url: '/admin/fhir/ingest',
        payload: {
          realmId: 'realm:msg',
          bundle: {
            resourceType: 'Bundle', type: 'message',
            entry: [
              { resource: { resourceType: 'MessageHeader', id: 'mh-1', eventCoding: { code: 'admit' } } },
              { resource: { resourceType: 'Patient', id: 'msg-pt', name: [{ family: 'M' }], gender: 'female' } },
              { resource: { resourceType: 'Encounter', id: 'msg-enc', status: 'in-progress', subject: { reference: 'Patient/msg-pt' } } },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { mode: string; response?: { type: string; entry: Array<{ resource: { issue: Array<{ severity: string }> } }> }; applied: number; summary: { structuralUpserts: number; effectsApplied: number } };
      expect(body.mode).toBe('message');
      expect(body.response?.type).toBe('message-response');
      expect(body.response?.entry[0]?.resource?.issue[0]?.severity).toBe('information');
      // all 3 entries handled (header acknowledged + patient + encounter); the
      // realm mutations are 1 structural + 1 effect — the header is NOT an entity.
      expect(body.applied).toBe(3);
      expect(body.summary.structuralUpserts).toBe(1);
      expect(body.summary.effectsApplied).toBeGreaterThanOrEqual(1);
      expect(RealmRegistry.get('realm:msg')!.graph.listKind('patient').length).toBe(1);
    } finally {
      cleanup('realm:msg');
      await app.close();
    }
  });

  it('rejects oversized bundles with 413', async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:big', mode: 'sim' } });
      const entry = Array.from({ length: MAX_BUNDLE_ENTRIES + 1 }, (_, i) => ({ resource: { resourceType: 'Patient', id: `pt-${i}`, gender: 'female' } }));
      const res = await app.inject({ method: 'POST', url: '/admin/fhir/ingest', payload: { realmId: 'realm:big', bundle: { resourceType: 'Bundle', type: 'collection', entry } } });
      expect(res.statusCode).toBe(413);
      expect((res.json() as { error: string }).error).toContain('bundle-too-large');
    } finally {
      cleanup('realm:big');
      await app.close();
    }
  });

  it('dry-run previews without persisting (rolled back, dryRun flag)', async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:dry', mode: 'sim' } });
      const res = await app.inject({
        method: 'POST', url: '/admin/fhir/ingest',
        payload: {
          realmId: 'realm:dry',
          dryRun: true,
          bundle: {
            resourceType: 'Bundle', type: 'transaction',
            entry: [{ resource: { resourceType: 'Patient', id: 'dry-pt', name: [{ family: 'D' }], gender: 'female' } }],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { dryRun: boolean; rolledBack: boolean; applied: number };
      expect(body.dryRun).toBe(true);
      expect(body.rolledBack).toBe(true);
      expect(body.applied).toBe(1);
      // nothing persisted — the realm was rolled back to its pre-ingest state
      expect(RealmRegistry.get('realm:dry')!.graph.get(RealmRegistry.get('realm:dry')!.graph.urnFor('patient', 'dry-pt'))).toBeUndefined();
    } finally {
      cleanup('realm:dry');
      await app.close();
    }
  });
});
