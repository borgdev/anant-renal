// FHIR R4 coverage (M24) — the coverage report endpoint + hydrate/ingest/serialize
// round-trip for the new clinical-record, care-coordination and payer resource families.

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
import { hydrateBundle, RESOURCE_TO_KIND, serializeEntity } from '../src/fhir/mapping.js';
import { ingestCanonicalEvents } from '../src/fhir/canonical.js';
import { R4_RESOURCES } from '../src/fhir/r4-inventory.js';
import type { EntityKind } from '../src/realm/types.js';
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

function makeRealm(id = 'realm:cov'): string {
  if (RealmRegistry.get(id)) return id;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Cov Dialysis', units: ['U1'], patientCount: 2 });
  realm.start();
  return id;
}

const ctx: FhirCtx = {
  realmId: 'realm:cov', scopeId: 'realm:cov', sourceId: 'test', ingestedAt: '2026-08-16T12:00:00.000Z', facilityId: 'f1',
};

describe('FHIR R4 coverage report', () => {
  it('reports typed vs mapped vs missing against the official R4 list', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/fhir/coverage' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      r4Total: number; typedTotal: number; mappedTotal: number; missingTotal: number;
      typed: Array<{ resourceType: string; kind: string | null; mapped: boolean }>;
      missing: string[]; auditProvenance: { projected: boolean };
    };
    expect(body.r4Total).toBe(R4_RESOURCES.length); // 144
    expect(body.r4Total).toBe(144);
    expect(body.typedTotal).toBe(62); // 25 original + 15 M24 + 6 C + 8 D + 8 D4
    // all the M24 + C + D + D4 families are typed + mapped
    for (const rt of ['Condition', 'AllergyIntolerance', 'Procedure', 'Immunization', 'DiagnosticReport', 'MedicationAdministration', 'QuestionnaireResponse', 'DocumentReference', 'Communication', 'Appointment', 'Schedule', 'Slot', 'ExplanationOfBenefit', 'Invoice', 'Account', 'ClaimResponse', 'CareTeam', 'Goal', 'Subscription', 'Questionnaire', 'Consent', 'AdverseEvent', 'MedicationStatement', 'MedicationDispense', 'ImagingStudy', 'Specimen', 'DetectedIssue', 'PaymentReconciliation', 'Composition', 'VisionPrescription', 'DeviceUseStatement', 'NutritionOrder', 'SupplyDelivery', 'HealthcareService', 'Endpoint', 'OrganizationAffiliation', 'Substance']) {
      const t = body.typed.find((x) => x.resourceType === rt);
      expect(t).toBeTruthy();
      expect(t!.mapped).toBe(true);
      expect(t!.kind).toBeTruthy();
    }
    expect(body.missingTotal).toBe(144 - 62);
    expect(body.missing).toContain('CapabilityStatement');
    expect(body.missing).not.toContain('Condition');
    expect(body.auditProvenance.projected).toBe(true);
  });

  it('every typed resource maps to a kind via RESOURCE_TO_KIND or is structural-only', () => {
    // The 15 new resources must all have a RESOURCE_TO_KIND entry.
    for (const rt of ['Condition', 'AllergyIntolerance', 'Procedure', 'Immunization', 'DiagnosticReport', 'MedicationAdministration', 'QuestionnaireResponse', 'DocumentReference', 'Communication', 'Appointment', 'Schedule', 'Slot', 'ExplanationOfBenefit', 'Invoice', 'Account']) {
      expect(RESOURCE_TO_KIND[rt]).toBeTruthy();
    }
  });
});

describe('FHIR ingest → realm round-trip for the new families', () => {
  it('hydrates a clinical-record Bundle and upserts structural entities', async () => {
    const id = makeRealm();
    const realm = RealmRegistry.get(id)!;
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        { resource: { resourceType: 'Condition', id: 'c1', code: { coding: [{ system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes mellitus' }] }, subject: { reference: 'Patient/f1-pt-0001' }, clinicalStatus: { coding: [{ code: 'active' }] }, recordedDate: '2026-08-16' } },
        { resource: { resourceType: 'Immunization', id: 'imm1', status: 'completed', vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '140', display: 'Influenza' }] }, patient: { reference: 'Patient/f1-pt-0001' }, occurrenceDateTime: '2026-08-01' } },
        { resource: { resourceType: 'Account', id: 'acct1', status: 'active', name: 'Episode 42', subject: [{ reference: 'Patient/f1-pt-0001' }] } },
      ],
    };
    const events = hydrateBundle(bundle as never, ctx);
    const result = ingestCanonicalEvents({ realm, ctx, presence: { presenceId: 'p-ingest' } as never, events });

    expect(result.resourceCount).toBe(3);
    expect(result.structural.length).toBe(3);
    expect(result.structural.map((r) => r.kind).sort()).toEqual(['account', 'condition', 'immunization']);

    const cond = realm.graph.listKind('condition');
    expect(cond.length).toBe(1);
    expect((cond[0]!.state as { code: string }).code).toBe('73211009');
    expect((cond[0]!.state as { patientId: string }).patientId).toBe('f1-pt-0001');
    expect(realm.graph.listKind('account').length).toBe(1);
    expect(realm.graph.listKind('immunization').length).toBe(1);
  });

  it('serializes the new kinds back to their FHIR resourceType', async () => {
    const id = makeRealm();
    const realm = RealmRegistry.get(id)!;
    realm.graph.create('procedure', 'proc1', { patientId: 'f1-pt-0001', code: '50300', codeSystem: 'http://www.ama-assn.org/go/cpt', status: 'completed', performedAt: '2026-08-10' });
    realm.graph.create('invoice', 'inv1', { subjectId: 'f1-pt-0001', status: 'issued', totalNet: 1250, currency: 'USD' });
    realm.graph.create('slot', 'slot1', { scheduleId: 'sch1', status: 'free', start: '2026-08-17T09:00:00Z', end: '2026-08-17T09:30:00Z' });

    const proc = serializeEntity(realm.graph.listKind('procedure')[0]!, ctx);
    expect(proc[0]!.resourceType).toBe('Procedure');
    expect((proc[0] as { code?: { coding?: Array<{ code?: string }> } }).code?.coding?.[0]?.code).toBe('50300');

    const inv = serializeEntity(realm.graph.listKind('invoice')[0]!, ctx);
    expect(inv[0]!.resourceType).toBe('Invoice');
    expect((inv[0] as { totalNet?: { value?: number; currency?: string } }).totalNet).toEqual({ value: 1250, currency: 'USD' });

    const slot = serializeEntity(realm.graph.listKind('slot')[0]!, ctx);
    expect(slot[0]!.resourceType).toBe('Slot');
    expect((slot[0] as { status?: string }).status).toBe('free');
  });

  it('serializes every M24 + C-batch kind to its FHIR resourceType', async () => {
    const id = makeRealm('realm:cov-serialize');
    const realm = RealmRegistry.get(id)!;
    const cases: Array<[EntityKind, string, Record<string, unknown>, string, string]> = [
      ['condition', 'c1', { code: '73211009', codeSystem: 'http://snomed.info/sct', patientId: 'f1-pt-0001' }, 'Condition', 'code'],
      ['allergy', 'a1', { code: '91935009', patientId: 'f1-pt-0001' }, 'AllergyIntolerance', 'code'],
      ['procedure', 'p1', { code: '50300', patientId: 'f1-pt-0001' }, 'Procedure', 'status'],
      ['immunization', 'i1', { vaccineCode: '140', patientId: 'f1-pt-0001' }, 'Immunization', 'vaccineCode'],
      ['diagnostic-report', 'dr1', { code: '11502-2', patientId: 'f1-pt-0001', resultIds: ['r1'] }, 'DiagnosticReport', 'result'],
      ['medication-admin', 'ma1', { code: '853653', patientId: 'f1-pt-0001' }, 'MedicationAdministration', 'medicationCodeableConcept'],
      ['questionnaire-response', 'qr1', { questionnaire: 'https://example.org/q', subjectId: 'f1-pt-0001' }, 'QuestionnaireResponse', 'questionnaire'],
      ['document-reference', 'doc1', { type: '18842-5', subjectId: 'f1-pt-0001', url: 'https://x/y.pdf' }, 'DocumentReference', 'content'],
      ['communication', 'cm1', { payloadText: 'Reminder', subjectId: 'f1-pt-0001' }, 'Communication', 'payload'],
      ['appointment', 'ap1', { patientId: 'f1-pt-0001', start: '2026-08-17T09:00:00Z' }, 'Appointment', 'participant'],
      ['schedule', 'sch1', { actorRef: 'Practitioner/s1' }, 'Schedule', 'actor'],
      ['slot', 's1', { scheduleId: 'sch1', start: '2026-08-17T09:00:00Z', end: '2026-08-17T09:30:00Z' }, 'Slot', 'schedule'],
      ['explanation-of-benefit', 'eob1', { patientId: 'f1-pt-0001', use: 'claim', totalAmount: 500 }, 'ExplanationOfBenefit', 'use'],
      ['invoice', 'inv1', { subjectId: 'f1-pt-0001', totalNet: 100 }, 'Invoice', 'totalNet'],
      ['account', 'acct1', { name: 'Episode', subjectRef: 'Patient/f1-pt-0001' }, 'Account', 'name'],
      ['claim-response', 'cr1', { patientId: 'f1-pt-0001', use: 'claim', totalAmount: 400 }, 'ClaimResponse', 'use'],
      ['care-team', 'ct1', { patientId: 'f1-pt-0001', name: 'Care team' }, 'CareTeam', 'status'],
      ['goal', 'g1', { patientId: 'f1-pt-0001', description: 'Kt/V >= 1.2', targetValue: 1.2 }, 'Goal', 'description'],
      ['subscription', 'sub1', { criteria: 'Observation?category=laboratory', reason: 'lab results' }, 'Subscription', 'criteria'],
      ['questionnaire', 'q1', { title: 'SDOH Screen', status: 'active', url: 'https://x/q' }, 'Questionnaire', 'title'],
      ['consent', 'cs1', { patientId: 'f1-pt-0001', scope: 'patient-privacy', category: 'research' }, 'Consent', 'scope'],
      ['adverse-event', 'ae1', { patientId: 'f1-pt-0001', code: 'falls', actuality: 'actual' }, 'AdverseEvent', 'status'],
      ['medication-statement', 'ms1', { patientId: 'f1-pt-0001', code: '853653' }, 'MedicationStatement', 'medicationCodeableConcept'],
      ['medication-dispense', 'md1', { patientId: 'f1-pt-0001', code: '853653', quantity: 30 }, 'MedicationDispense', 'quantity'],
      ['imaging-study', 'is1', { patientId: 'f1-pt-0001', modality: 'CT' }, 'ImagingStudy', 'series'],
      ['specimen', 'sp1', { patientId: 'f1-pt-0001', type: 'BLD' }, 'Specimen', 'type'],
      ['detected-issue', 'di1', { patientId: 'f1-pt-0001', code: 'drug-drug', severity: 'high' }, 'DetectedIssue', 'status'],
      ['payment-reconciliation', 'pr1', { paymentAmount: 500, status: 'active' }, 'PaymentReconciliation', 'paymentAmount'],
      ['composition', 'co1', { patientId: 'f1-pt-0001', title: 'Discharge summary' }, 'Composition', 'title'],
      ['vision-prescription', 'vp1', { patientId: 'f1-pt-0001', product: 'LENS' }, 'VisionPrescription', 'lensSpecification'],
      ['device-use', 'du1', { patientId: 'f1-pt-0001', deviceId: 'dev1' }, 'DeviceUseStatement', 'device'],
      ['nutrition-order', 'no1', { patientId: 'f1-pt-0001', dietType: 'low-sodium' }, 'NutritionOrder', 'oralDiet'],
      ['supply-delivery', 'sd1', { patientId: 'f1-pt-0001', type: 'device', quantity: 2 }, 'SupplyDelivery', 'quantity'],
      ['healthcare-service', 'hs1', { orgId: 'org1', name: 'Dialysis', category: 'renal' }, 'HealthcareService', 'name'],
      ['endpoint', 'ep1', { connectionType: 'hl7-fhir-rest', address: 'https://x/fhir', name: 'FHIR' }, 'Endpoint', 'address'],
      ['org-affiliation', 'oa1', { orgId: 'org1', participantOrgId: 'org2', code: 'provider' }, 'OrganizationAffiliation', 'code'],
      ['substance', 'sub1', { code: '124302', description: 'heparin' }, 'Substance', 'code'],
    ];
    for (const [kind, entityId, state, rt, key] of cases) {
      realm.graph.create(kind, entityId, state);
      const rec = realm.graph.listKind(kind)[0]!;
      const out = serializeEntity(rec, ctx);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]!.resourceType).toBe(rt);
      expect((out[0] as unknown as Record<string, unknown>)[key]).toBeTruthy();
    }
  });

  it('hydrates + structural-upserts the remaining M24 kinds (B4)', async () => {
    const id = makeRealm('realm:cov-hydrate');
    const realm = RealmRegistry.get(id)!;
    const resources = [
      { resourceType: 'AllergyIntolerance', id: 'al1', code: { coding: [{ code: '91935009' }] }, patient: { reference: 'Patient/f1-pt-0001' } },
      { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final', code: { coding: [{ code: '11502-2' }] }, subject: { reference: 'Patient/f1-pt-0001' }, result: [{ reference: 'Observation/o1' }] },
      { resourceType: 'MedicationAdministration', id: 'ma1', status: 'completed', medicationCodeableConcept: { coding: [{ code: '853653' }] }, subject: { reference: 'Patient/f1-pt-0001' } },
      { resourceType: 'DocumentReference', id: 'doc1', status: 'current', type: { coding: [{ code: '18842-5' }] }, subject: { reference: 'Patient/f1-pt-0001' }, content: [{ attachment: { url: 'https://x/y.pdf', title: 'Consent' } }] },
      { resourceType: 'Appointment', id: 'ap1', status: 'booked', start: '2026-08-17T09:00:00Z', participant: [{ actor: { reference: 'Patient/f1-pt-0001' }, status: 'accepted' }] },
      { resourceType: 'Slot', id: 'sl1', status: 'free', schedule: { reference: 'Schedule/sch1' }, start: '2026-08-17T09:00:00Z', end: '2026-08-17T09:30:00Z' },
      { resourceType: 'ExplanationOfBenefit', id: 'eob1', status: 'active', use: 'claim', patient: { reference: 'Patient/f1-pt-0001' } },
      { resourceType: 'Invoice', id: 'inv1', status: 'issued', subject: { reference: 'Patient/f1-pt-0001' }, totalNet: { value: 100, currency: 'USD' } },
    ];
    const events = hydrateBundle({ resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) } as never, ctx);
    const result = ingestCanonicalEvents({ realm, ctx, presence: { presenceId: 'p-ingest' } as never, events });
    expect(result.resourceCount).toBe(resources.length);
    expect(result.structural.length).toBe(resources.length);
    for (const kind of ['allergy', 'diagnostic-report', 'medication-admin', 'document-reference', 'appointment', 'slot', 'explanation-of-benefit', 'invoice'] as const) {
      expect(realm.graph.listKind(kind).length).toBe(1);
    }
  });

  it('hydrates + structural-upserts the D4 kinds (VisionPrescription … Substance)', async () => {
    const id = makeRealm('realm:cov-hydrate-d4');
    const realm = RealmRegistry.get(id)!;
    const resources = [
      { resourceType: 'VisionPrescription', id: 'vp1', status: 'active', patient: { reference: 'Patient/f1-pt-0001' }, lensSpecification: [{ product: { coding: [{ code: 'LENS' }] }, eye: 'right' }] },
      { resourceType: 'DeviceUseStatement', id: 'du1', status: 'active', subject: { reference: 'Patient/f1-pt-0001' }, device: { reference: 'Device/dev1' }, reasonCode: [{ coding: [{ code: '410493006' }] }] },
      { resourceType: 'NutritionOrder', id: 'no1', status: 'active', patient: { reference: 'Patient/f1-pt-0001' }, oralDiet: { type: [{ coding: [{ code: 'low-sodium' }] }] } },
      { resourceType: 'SupplyDelivery', id: 'sd1', status: 'completed', patient: { reference: 'Patient/f1-pt-0001' }, type: { coding: [{ code: 'device' }] }, quantity: { value: 2, unit: 'ea' }, suppliedItem: { itemCodeableConcept: { coding: [{ code: '33195000' }] } } },
      { resourceType: 'HealthcareService', id: 'hs1', active: true, providedBy: { reference: 'Organization/org1' }, name: 'Dialysis', category: [{ coding: [{ code: 'renal' }] }] },
      { resourceType: 'Endpoint', id: 'ep1', status: 'active', connectionType: { code: 'hl7-fhir-rest' }, name: 'FHIR', address: 'https://x/fhir', payloadType: [{ coding: [{ code: 'any' }] }] },
      { resourceType: 'OrganizationAffiliation', id: 'oa1', active: true, organization: { reference: 'Organization/org1' }, participatingOrganization: { reference: 'Organization/org2' }, code: [{ coding: [{ code: 'provider' }] }] },
      { resourceType: 'Substance', id: 'sub1', status: 'active', code: { coding: [{ system: 'http://snomed.info/sct', code: '124302' }] }, description: 'heparin' },
    ];
    const events = hydrateBundle({ resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) } as never, ctx);
    const result = ingestCanonicalEvents({ realm, ctx, presence: { presenceId: 'p-ingest' } as never, events });
    expect(result.resourceCount).toBe(resources.length);
    expect(result.structural.length).toBe(resources.length);
    for (const kind of ['vision-prescription', 'device-use', 'nutrition-order', 'supply-delivery', 'healthcare-service', 'endpoint', 'org-affiliation', 'substance'] as const) {
      expect(realm.graph.listKind(kind).length).toBe(1);
    }
    expect((realm.graph.listKind('substance')[0]!.state as { code: string }).code).toBe('124302');
    expect((realm.graph.listKind('nutrition-order')[0]!.state as { dietType: string }).dietType).toBe('low-sodium');
    expect((realm.graph.listKind('endpoint')[0]!.state as { address: string }).address).toBe('https://x/fhir');
  });
});
