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

// Phase 2 — FHIR entity support: typed R4 model, bundle utilities, effect →
// resource write path, entity serialize round-trips, and bundle → realm ingest
// (consume) — unit + HTTP.

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
import { buildBundle, parseBundle, indexBundle, resolveReference } from '../src/fhir/fhir-bundle.js';
import { hydrateBundle, serializeEntity, RESOURCE_TO_KIND } from '../src/fhir/mapping.js';
import { effectToFhirResource } from '../src/fhir/effect-map.js';
import { ingestCanonicalEvents } from '../src/fhir/canonical.js';
import { exportRealmBundle, serializeRealmEntity } from '../src/fhir/export.js';
import { countsByType } from '../src/hypergraph/queries/healthcare.js';
import type { FhirCtx } from '../src/fhir/types.js';

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

const actor: ActorContext = { actorRef: 'user:ops-1', scopeIds: ['scope:facility-1'], purposeOfUse: 'operations', clearance: 'internal' };

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

function ctx(realmId: string): FhirCtx {
  return { realmId, facilityId: 'f1', scopeId: realmId, sourceId: 'test', ingestedAt: '2026-08-16T00:00:00.000Z' };
}

function makeRealm(id: string) {
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  realm.start();
  return { realm, hg };
}

describe('FHIR bundle utilities', () => {
  it('builds + parses + indexes a collection bundle and resolves references', () => {
    const bundle = buildBundle([
      { resourceType: 'Patient', id: 'p1', identifier: [{ system: 'urn:mrn', value: 'MRN1' }], name: [{ family: 'Doe', given: ['Jane'] }], gender: 'female' },
      { resourceType: 'Encounter', id: 'enc1', status: 'in-progress', subject: { reference: 'Patient/p1' } },
    ], { source: 'test' });
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('collection');
    expect(bundle.entry).toHaveLength(2);
    expect(bundle.total).toBe(2);

    const parsed = parseBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.entry?.[0]?.resource?.resourceType).toBe('Encounter'); // sorted: Encounter < Patient
    const index = indexBundle(parsed);
    expect(index.get('Patient/p1')?.resourceType).toBe('Patient');
    expect(resolveReference({ reference: 'Patient/p1' }, ctx('r1'), index)).toBe('p1');
    expect(resolveReference({ reference: '#frag' }, ctx('r1'), index)).toBe('frag');
    expect(resolveReference(undefined, ctx('r1'), index)).toBeUndefined();
    expect(() => parseBundle({ resourceType: 'Observation' })).toThrow(/invalid-fhir-bundle/);
  });
});

describe('Effect → FHIR write path', () => {
  it('projects clinical effects onto R4 resources with coded subjects', () => {
    const c = ctx('realm:w');
    const resources = effectToFhirResource({ kind: 'order-lab', patientId: 'p1', code: '17861-6', priority: 'stat', encounterId: 'enc1' }, { ctx: c });
    expect(resources[0]!.resourceType).toBe('ServiceRequest');
    const sr = resources[0] as { status: string; intent: string; priority: string; subject?: { reference: string }; code: { coding?: Array<{ system: string; code: string }> } };
    expect(sr.status).toBe('active');
    expect(sr.priority).toBe('stat');
    expect(sr.subject?.reference).toBe('Patient/p1');
    expect(sr.code.coding?.[0]?.code).toBe('17861-6');

    const med = effectToFhirResource({ kind: 'order-med', patientId: 'p1', code: '853653', dose: '50 mg', route: 'PO', frequency: 'Q8H' }, { ctx: c });
    expect(med[0]!.resourceType).toBe('MedicationRequest');

    const res = effectToFhirResource({ kind: 'result-lab', orderId: 'ord-1', code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' }, { ctx: c });
    expect(res[0]!.resourceType).toBe('Observation');
    const obs = res[0] as { valueQuantity?: { value?: number; unit?: string }; interpretation?: Array<{ coding?: Array<{ code?: string }> }> };
    expect(obs.valueQuantity).toMatchObject({ value: 4.2, unit: 'mg/dL' });
    expect(obs.interpretation?.[0]?.coding?.[0]?.code).toBe('H');

    const vitals = effectToFhirResource({ kind: 'record-vitals', patientId: 'p1', hr: 74, bp: '120/80', spo2: 98 }, { ctx: c });
    expect(vitals).toHaveLength(3); // hr + bp + spo2
    const vitalCodes = vitals.map((v) => (v as { code: { coding?: Array<{ code?: string }> } }).code.coding?.[0]?.code);
    expect(vitalCodes).toEqual(expect.arrayContaining(['8867-4', '55284-4', '2708-6']));

    const claim = effectToFhirResource({ kind: 'submit-claim', encounterId: 'enc1', payerId: 'payer1', cptCodes: ['99213'], icd10Codes: ['E11.9'] }, { ctx: c });
    expect(claim[0]!.resourceType).toBe('Claim');
    expect((claim[0] as { item?: Array<{ productOrService?: { coding?: Array<{ code?: string }> } }> }).item?.[0]?.productOrService?.coding?.[0]?.code).toBe('99213');

    expect(effectToFhirResource({ kind: 'record-agent-thought', note: 'x' }, { ctx: c })).toEqual([]);
  });
});

describe('Entity → FHIR serialize (produce path)', () => {
  it('exports a seeded realm + effect entities as an R4 bundle', () => {
    const { realm, hg } = makeRealm('realm:ex');
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Anant Dialysis', units: ['U1'], patientCount: 1 });
    const md = realm.spawnPresence({ agentSpecId: 'rounding-md', runId: 'r1', role: 'md', clearance: 'restricted-phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' } });
    realm.emit(md.presenceId, { kind: 'admit-patient', patientId: 'p1', facilityId: 'f1', unitId: 'U1' });
    realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'p1', code: '17861-6', priority: 'routine', encounterId: 'enc1' });
    const orderId = realm.graph.listKind('order')[0]!.id;
    realm.emit(md.presenceId, { kind: 'result-lab', orderId, code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' });

    const bundle = exportRealmBundle(realm, ctx('realm:ex'));
    const types = (bundle.entry ?? []).map((e) => e.resource?.resourceType);
    expect(types).toContain('Patient');
    expect(types).toContain('Organization');
    expect(types).toContain('Location');
    expect(types).toContain('ServiceRequest');
    expect(types).toContain('Observation');

    // single-entity serialize
    const pRes = serializeRealmEntity(realm, 'patient', 'p1', ctx('realm:ex'));
    expect(pRes[0]!.resourceType).toBe('Patient');
    const resultRec = realm.graph.listKind('result')[0]!;
    const res = serializeEntity(resultRec, ctx('realm:ex'));
    expect(res[0]!.resourceType).toBe('Observation');

    // ingest rode the hypergraph (Phase 1b bridge)
    const snap = hg.now();
    const counts = countsByType(snap);
    expect(counts['patient']).toBeGreaterThanOrEqual(1);
    expect(counts['effect']).toBeGreaterThanOrEqual(3);
    void counts;
  });
});

describe('Bundle → realm ingest (consume path)', () => {
  it('hydrates a synthetic bundle and applies effects + structural upserts to a realm', () => {
    const { realm, hg } = makeRealm('realm:in');
    const md = realm.spawnPresence({ agentSpecId: 'fhir-ingest', runId: 'ingest-1', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' } });

    const bundle = {
      resourceType: 'Bundle', type: 'collection',
      entry: [
        { resource: { resourceType: 'Organization', id: 'f1', name: 'Anant Dialysis', type: [{ coding: [{ code: 'prov' }] }] } },
        { resource: { resourceType: 'Location', id: 'U1', name: 'Unit One', partOf: { reference: 'Organization/f1' } } },
        { resource: { resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe', given: ['Jane'] }], gender: 'female', identifier: [{ system: 'urn:mrn', value: 'MRN-1' }] } },
        { resource: { resourceType: 'Encounter', id: 'enc1', status: 'in-progress', subject: { reference: 'Patient/p1' } } },
        { resource: { resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order', subject: { reference: 'Patient/p1' }, code: { coding: [{ system: 'http://loinc.org', code: '17861-6' }] }, priority: 'routine' } },
        { resource: { resourceType: 'Observation', id: 'obs1', status: 'final', category: [{ coding: [{ code: 'laboratory' }] }], subject: { reference: 'Patient/p1' }, code: { coding: [{ system: 'http://loinc.org', code: '17861-6' }] }, valueQuantity: { value: 4.2, unit: 'mg/dL' }, interpretation: [{ coding: [{ code: 'H' }] }] } },
        { resource: { resourceType: 'MedicationRequest', id: 'mr1', status: 'active', intent: 'order', subject: { reference: 'Patient/p1' }, medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '853653' }] } } },
        { resource: { resourceType: 'CarePlan', id: 'cp1', status: 'active', intent: 'plan', subject: { reference: 'Patient/p1' }, title: 'Dialysis plan' } },
        { resource: { resourceType: 'Coverage', id: 'cov1', status: 'active', kind: 'group', beneficiary: { reference: 'Patient/p1' }, identifier: [{ value: 'POL-1' }] } },
      ],
    } as never;

    const events = hydrateBundle(bundle as never, ctx('realm:in'));
    expect(events.length).toBeGreaterThanOrEqual(9);
    expect(events.every((e) => e.classification === 'phi')).toBe(true);

    const result = ingestCanonicalEvents({ realm, ctx: ctx('realm:in'), presence: md, events });
    // effects: admit + order-lab + result-lab + order-med + update-care-plan
    expect(result.effects.length).toBeGreaterThanOrEqual(5);
    expect(result.effects.filter((e) => e.status !== 'shadow' && e.status !== 'bound')).toHaveLength(0);
    // structural upserts: org f1, unit U1, patient p1, coverage cov1
    expect(result.structural.map((r) => r.kind)).toEqual(expect.arrayContaining(['org-node', 'unit', 'patient', 'insurance']));

    expect(realm.graph.listKind('patient').length).toBeGreaterThanOrEqual(1);
    expect(realm.graph.listKind('order').length).toBeGreaterThanOrEqual(1);
    expect(realm.graph.listKind('result').length).toBeGreaterThanOrEqual(1);
    expect(realm.graph.listKind('medication').length).toBeGreaterThanOrEqual(1);
    // patient from bundle carries demographics
    const p = realm.graph.get(realm.graph.urnFor('patient', 'p1'))!;
    expect(p.state['sex']).toBe('female');
    // insurance structural upsert carries policy number
    const cov = realm.graph.listKind('insurance').find((c) => c.state['policyNumber'] === 'POL-1');
    expect(cov).toBeDefined();

    // ride the hypergraph: patient/org/unit/insurance/order/result/medication nodes
    const counts = countsByType(hg.now());
    expect(counts['patient']).toBeGreaterThanOrEqual(1);
    expect(counts['order']).toBeGreaterThanOrEqual(1);
    expect(counts['result']).toBeGreaterThanOrEqual(1);
  });
});

describe('FHIR HTTP routes', () => {
  it('ingest → export → entity routes', async () => {
    const app = await makeApp();
    // create a seeded realm (facility + units + patients)
    let res = await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:fh', mode: 'sim', seed: { facilityId: 'f1', kind: 'dialysis', name: 'Anant Dialysis', units: ['U1'], patientCount: 1 } } });
    expect(res.statusCode).toBe(200);

    const bundle = {
      resourceType: 'Bundle', type: 'collection',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p9', name: [{ family: 'X', given: ['Y'] }], gender: 'male' } },
        { resource: { resourceType: 'Encounter', id: 'enc9', status: 'in-progress', subject: { reference: 'Patient/p9' } } },
        { resource: { resourceType: 'ServiceRequest', id: 'sr9', status: 'active', intent: 'order', subject: { reference: 'Patient/p9' }, code: { coding: [{ code: '17861-6' }] } } },
        { resource: { resourceType: 'Observation', id: 'obs9', status: 'final', category: [{ coding: [{ code: 'laboratory' }] }], subject: { reference: 'Patient/p9' }, code: { coding: [{ code: '17861-6' }] }, valueQuantity: { value: 4.2, unit: 'mg/dL' } } },
      ],
    };

    res = await app.inject({ method: 'POST', url: '/admin/fhir/ingest', payload: { realmId: 'realm:fh', bundle } });
    expect(res.statusCode).toBe(200);
    const ingest = res.json() as { hydrated: number; effectsApplied: number; structuralUpserts: number; persisted: number; skipped: string[] };
    expect(ingest.hydrated).toBe(4);
    expect(ingest.effectsApplied).toBeGreaterThanOrEqual(3); // admit + order + result
    expect(ingest.structuralUpserts).toBeGreaterThanOrEqual(1); // patient p9
    expect(ingest.persisted).toBe(4);

    // export the realm as a bundle
    res = await app.inject({ method: 'GET', url: '/admin/fhir/export/realm:fh' });
    expect(res.statusCode).toBe(200);
    const exported = res.json() as { resourceType: string; entry: Array<{ resource: { resourceType: string } }> };
    expect(exported.resourceType).toBe('Bundle');
    const types = exported.entry.map((e) => e.resource.resourceType);
    expect(types).toContain('Patient');
    expect(types).toContain('ServiceRequest');
    expect(types).toContain('Observation');

    // single entity as FHIR
    res = await app.inject({ method: 'GET', url: '/admin/fhir/entity/realm:fh/patient/p9' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { resourceType: string }).resourceType).toBe('Patient');

    // durable mirror
    res = await app.inject({ method: 'GET', url: '/admin/fhir/resources?realmId=realm:fh' });
    expect((res.json() as { resources: unknown[] }).resources.length).toBe(4);

    // mapping metadata
    res = await app.inject({ method: 'GET', url: '/admin/fhir/map' });
    expect((res.json() as { resourceToKind: Record<string, string> }).resourceToKind['Patient']).toBe('patient');
    void RESOURCE_TO_KIND;
  });
});
