/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// F3 — identity. THIS FILE IS THE WRONG-PATIENT GUARDRAIL.
//
// The property that matters most is negative: given an inbound Patient the
// harness cannot place with confidence, **no write may be constructed**. Every
// other assertion here is supporting evidence for that one.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDENTIFIER_SYSTEMS,
  IdentifierSystemRegistry,
  PatientIdentityService,
  UnresolvedPatientIdentityError,
  birthDateAgreement,
  correctionFrom,
  correctionFromStatus,
  crossReferenceId,
  demographicsFromPatient,
  nameSimilarity,
  normaliseIdentifier,
  normaliseName,
  outboundPatientIdentity,
  requirePatientIdentity,
  resolvePatientIdentity,
  stableResourceId,
  type IdentityLinkStore,
  type LocalPatientDemographics,
  type PatientCrossReference,
} from '../src/fhir/identity.js';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { ingestFhirBundle } from '../src/fhir/bundle-ingest.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import type { Bundle, FhirCtx } from '../src/fhir/types.js';

function ctx(realmId: string): FhirCtx {
  return { realmId, facilityId: 'f1', scopeId: realmId, sourceId: 'test', ingestedAt: '2026-09-13T00:00:00.000Z' };
}

/** Minimal in-memory link store — the durable one is the workspace adapter. */
function memoryLinkStore(): IdentityLinkStore & { rows: PatientCrossReference[] } {
  const rows: PatientCrossReference[] = [];
  return {
    rows,
    listCrossReferences: async (realmId?: string) => (realmId ? rows.filter((r) => r.realmId === realmId) : rows),
    saveCrossReference: async (ref: PatientCrossReference) => {
      const at = rows.findIndex((r) => r.id === ref.id);
      if (at >= 0) rows[at] = ref;
      else rows.push(ref);
      return ref;
    },
    deleteCrossReference: async (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
  };
}

const POPULATION: LocalPatientDemographics[] = [
  { localPatientId: 'f1-pt-0001', family: 'Okafor', given: 'Ada', birthDate: '1968-04-12', sex: 'female', identifiers: [{ system: 'urn:mrn', value: 'MRN-0001' }] },
  { localPatientId: 'f1-pt-0002', family: 'Lindqvist', given: 'Bo', birthDate: '1955-11-30', sex: 'male', identifiers: [{ system: 'urn:mrn', value: 'MRN-0002' }] },
];

const registry = new IdentifierSystemRegistry();

describe('F3 · identifier systems are declared, not assumed', () => {
  it('ships a seeded registry that knows which systems are authoritative', () => {
    expect(DEFAULT_IDENTIFIER_SYSTEMS.length).toBeGreaterThan(3);
    expect(registry.isAuthoritative('urn:mrn')).toBe(true);
    expect(registry.lookup('http://hl7.org/fhir/sid/us-npi')?.entityKind).toBe('practitioner');
  });

  it('registers a connection-specific assigner OID', () => {
    const r = new IdentifierSystemRegistry();
    r.registerOid('urn:oid:1.2.840.114350', { label: 'Epic MRN namespace' });
    expect(r.lookup('urn:oid:1.2.840.114350')?.kind).toBe('oid');
    expect(r.isAuthoritative('urn:oid:1.2.840.114350')).toBe(true);
  });

  it('populates FhirCtx.identifierSystems — declared in types.ts and never set before F3', () => {
    expect(Object.keys(registry.toCtxMap()).length).toBe(registry.systems().length);
  });
});

describe('F3 · normalisation is what makes a match a match', () => {
  it('ignores punctuation, case, diacritics and honorifics in names', () => {
    expect(normaliseName("Dr. José  O'Brien-Smith")).toBe('jose o brien smith');
    expect(normaliseName('SMITH')).toBe('smith');
  });

  it('ignores dashes and spaces in identifiers', () => {
    expect(normaliseIdentifier(' MRN-00 01 ')).toBe('mrn0001');
    expect(normaliseIdentifier('123-45-6789')).toBe('123456789');
  });

  it('scores name similarity order-insensitively and tolerates a typo', () => {
    expect(nameSimilarity('Okafor Ada', 'Ada Okafor')).toBe(1);
    expect(nameSimilarity('Okafor', 'Okafur')).toBeGreaterThan(0.8);
    expect(nameSimilarity('Okafor', 'Lindqvist')).toBeLessThan(0.4);
  });

  it('treats a transposed day/month birth date as a transcription error, and a different year as nothing', () => {
    expect(birthDateAgreement('1968-04-12', '1968-04-12').points).toBe(1);
    expect(birthDateAgreement('1968-04-12', '1968-12-04').points).toBe(0.5);
    expect(birthDateAgreement('1968-04-12', '1969-04-12').points).toBe(0);
  });

  it('reads demographics off a FHIR Patient', () => {
    const d = demographicsFromPatient({
      resourceType: 'Patient', id: 'e63a', birthDate: '1968-04-12', gender: 'female',
      name: [{ family: 'Okafor', given: ['Ada'] }],
      identifier: [{ system: 'urn:mrn', value: 'MRN-0001' }],
    });
    expect(d).toMatchObject({ family: 'Okafor', given: 'Ada', birthDate: '1968-04-12', sex: 'female' });
    expect(d.identifiers).toEqual([{ system: 'urn:mrn', value: 'MRN-0001' }]);
  });
});

describe('F3 · the matching ladder', () => {
  it('rung (a): an exact identifier on an authoritative system resolves at 1.0', () => {
    const r = resolvePatientIdentity({ identifiers: [{ system: 'urn:mrn', value: 'MRN-0002' }] }, POPULATION, registry);
    expect(r.status).toBe('resolved');
    expect(r.localPatientId).toBe('f1-pt-0002');
    expect(r.confidence).toBe(1);
    expect(r.method).toBe('exact-identifier');
    expect(r.blocksWrite).toBe(false);
  });

  it('does NOT treat a match on a non-authoritative system as an exact identifier', () => {
    // A local id echoed back is not evidence of who the patient is.
    const r = resolvePatientIdentity({ identifiers: [{ system: 'urn:ananthealth:local-patient-id', value: 'f1-pt-0001' }] }, POPULATION, registry);
    expect(r.method).not.toBe('exact-identifier');
  });

  it('rung (b): a prior cross-reference resolves at 1.0 even with no identifiers supplied', async () => {
    const store = memoryLinkStore();
    const svc = new PatientIdentityService(registry, store);
    await svc.link({ realmId: 'r1', localPatientId: 'f1-pt-0001', remoteSystem: 'urn:oid:1.2.840.114350', remotePatientId: 'e63a-remote', confidence: 1, method: 'cross-reference', linkedBy: 'registrar', verified: true });

    const r = await svc.resolve({ identifiers: [{ system: 'urn:oid:1.2.840.114350', value: 'e63a-remote' }] }, POPULATION, { realmId: 'r1' });
    expect(r.status).toBe('resolved');
    expect(r.localPatientId).toBe('f1-pt-0001');
    expect(r.method).toBe('cross-reference');
  });

  it('rung (c): exact demographics resolve at 0.95', () => {
    const r = resolvePatientIdentity(
      { family: 'Lindqvist', given: 'Bo', birthDate: '1955-11-30', sex: 'male' },
      POPULATION, registry,
    );
    expect(r.status).toBe('resolved');
    expect(r.localPatientId).toBe('f1-pt-0002');
    expect(r.confidence).toBe(0.95);
    expect(r.method).toBe('demographics');
  });

  it('a demographic match that disagrees on sex does not resolve', () => {
    const r = resolvePatientIdentity(
      { family: 'Lindqvist', given: 'Bo', birthDate: '1955-11-30', sex: 'female' },
      POPULATION, registry,
    );
    expect(r.status).not.toBe('resolved');
    expect(r.blocksWrite).toBe(true);
  });

  it('rung (d): a fuzzy match is a LEAD — it never auto-applies, even when it is the only candidate', () => {
    // Same family name, a mis-typed given name, and only the birth year in common.
    const r = resolvePatientIdentity(
      { family: 'Okafor', given: 'Adah', birthDate: '1968-01-01', sex: 'female' },
      POPULATION, registry,
    );
    expect(r.status).toBe('ambiguous');
    expect(r.blocksWrite).toBe(true);
    expect(r.candidates[0]?.method).toBe('fuzzy');
    // The ceiling is what makes it unusable for a write: resemblance is not identity.
    expect(r.candidates[0]!.confidence).toBeLessThanOrEqual(0.9);
    expect(r.reasons.join(' ')).toMatch(/human must confirm/);
  });

  it('reports `unresolved` (not an error) when nothing matches, and blocks', () => {
    const r = resolvePatientIdentity({ family: 'Nobody', given: 'Here', birthDate: '1900-01-01' }, POPULATION, registry);
    expect(r.status).toBe('unresolved');
    expect(r.candidates).toEqual([]);
    expect(r.blocksWrite).toBe(true);
  });

  it('two equally-plausible candidates produce `ambiguous` rather than a coin flip', () => {
    const twins: LocalPatientDemographics[] = [
      { localPatientId: 'pt-a', family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01', sex: 'female' },
      { localPatientId: 'pt-b', family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01', sex: 'female' },
    ];
    const r = resolvePatientIdentity({ family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01', sex: 'female' }, twins, registry);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBe(2);
    expect(r.blocksWrite).toBe(true);
  });

  it('raises an ambiguity task rather than dropping it', () => {
    const seen: string[] = [];
    resolvePatientIdentity({ family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01' }, [
      { localPatientId: 'pt-a', family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01' },
      { localPatientId: 'pt-b', family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01' },
    ], registry, { onAmbiguous: (r) => seen.push(r.status) });
    expect(seen).toEqual(['ambiguous']);
  });

  it('an identifier-only deployment can switch demographic inference off', () => {
    const r = resolvePatientIdentity(
      { family: 'Lindqvist', given: 'Bo', birthDate: '1955-11-30', sex: 'male' },
      POPULATION, registry, { allowDemographics: false },
    );
    expect(r.status).toBe('unresolved');
    expect(r.blocksWrite).toBe(true);
  });
});

describe('F3 · THE GUARDRAIL — no write without a resolved identity', () => {
  it('requirePatientIdentity THROWS on ambiguous — the write cannot be constructed', () => {
    const r = resolvePatientIdentity({ family: 'Okafor', given: 'Adah', birthDate: '1968-01-01' }, POPULATION, registry);
    let thrown: unknown;
    try { requirePatientIdentity(r); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(UnresolvedPatientIdentityError);
    expect((thrown as UnresolvedPatientIdentityError).code).toBe('unresolved-patient-identity');
  });

  it('requirePatientIdentity THROWS on unresolved', () => {
    const r = resolvePatientIdentity({ family: 'Ghost', given: 'Patient' }, POPULATION, registry);
    expect(() => requirePatientIdentity(r)).toThrow(/unresolved-patient-identity|patient identity unresolved/);
  });

  it('requirePatientIdentity RETURNS the local id when resolved — and only then', () => {
    const ok = resolvePatientIdentity({ identifiers: [{ system: 'urn:mrn', value: 'MRN-0001' }] }, POPULATION, registry);
    expect(requirePatientIdentity(ok)).toBe('f1-pt-0001');
  });
});

describe('F3 · cross-reference records are evidence, not just pointers', () => {
  it('records who linked it, when, how, and whether a human verified it', async () => {
    const svc = new PatientIdentityService(registry, memoryLinkStore(), () => '2026-09-13T12:00:00.000Z');
    const ref = await svc.link({
      realmId: 'r1', localPatientId: 'f1-pt-0001', remoteSystem: 'urn:oid:1.2.840.114350',
      remotePatientId: 'e63a', confidence: 0.95, method: 'demographics', linkedBy: 'registrar',
    });
    expect(ref.verified).toBe(true); // demographics are exact-match, not resemblance
    expect(ref.linkedAt).toBe('2026-09-13T12:00:00.000Z');
    expect(ref.id).toBe(crossReferenceId('f1-pt-0001', 'urn:oid:1.2.840.114350', 'e63a'));
  });

  it('marks a fuzzy-derived link as UNVERIFIED', async () => {
    const svc = new PatientIdentityService(registry, memoryLinkStore());
    const ref = await svc.link({
      localPatientId: 'f1-pt-0001', remoteSystem: 'urn:oid:x', remotePatientId: 'y',
      confidence: 0.8, method: 'fuzzy', linkedBy: 'importer',
    });
    expect(ref.verified).toBe(false);
  });

  it('is idempotent per (patient, system, remote id) — re-deriving updates the evidence', async () => {
    const store = memoryLinkStore();
    const svc = new PatientIdentityService(registry, store);
    await svc.link({ localPatientId: 'p1', remoteSystem: 's', remotePatientId: 'r', confidence: 0.8, method: 'fuzzy', linkedBy: 'a' });
    await svc.link({ localPatientId: 'p1', remoteSystem: 's', remotePatientId: 'r', confidence: 1, method: 'cross-reference', linkedBy: 'b', verified: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.verified).toBe(true);
  });

  it('a human can verify an inferred link', async () => {
    const store = memoryLinkStore();
    const svc = new PatientIdentityService(registry, store);
    await svc.link({ localPatientId: 'p1', remoteSystem: 's', remotePatientId: 'r', confidence: 0.8, method: 'fuzzy', linkedBy: 'importer' });
    const verified = await svc.verify('p1', 's', 'r', 'dr-who');
    expect(verified.verified).toBe(true);
    expect(verified.linkedBy).toBe('dr-who');
  });

  it('a merge RE-POINTS the cross-reference and retires the old row', async () => {
    const store = memoryLinkStore();
    const svc = new PatientIdentityService(registry, store);
    await svc.link({ localPatientId: 'dup-1', remoteSystem: 'urn:oid:1.2.840.114350', remotePatientId: 'e63a', confidence: 1, method: 'cross-reference', linkedBy: 'registrar' });
    const moved = await svc.mergeInto('dup-1', 'survivor', 'registrar');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.localPatientId).toBe('survivor');
    // The MOVED row is the live answer for this remote identity.
    expect(moved[0]!.supersededBy).toBeUndefined();
    // The link survives the merge — it now points at the survivor.
    expect(moved[0]!.remotePatientId).toBe('e63a');

    const found = await svc.findLink('urn:oid:1.2.840.114350', 'e63a');
    expect(found?.localPatientId).toBe('survivor');
    // The OLD row must be gone. If both survive, a lookup by remote id can still
    // resolve to the merged-away patient and send data back to the dead chart.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.localPatientId).toBe('survivor');
  });

  it('retires the stale row even when the store cannot delete', async () => {
    // A store without delete support must not leave a link that still resolves
    // to the merged-away patient.
    const rows: PatientCrossReference[] = [];
    const noDelete: IdentityLinkStore = {
      listCrossReferences: async () => rows,
      saveCrossReference: async (ref: PatientCrossReference) => {
        const at = rows.findIndex((r) => r.id === ref.id);
        if (at >= 0) rows[at] = ref;
        else rows.push(ref);
        return ref;
      },
    };
    const svc = new PatientIdentityService(registry, noDelete);
    await svc.link({ localPatientId: 'dup-1', remoteSystem: 's', remotePatientId: 'r', confidence: 1, method: 'cross-reference', linkedBy: 'registrar' });
    await svc.mergeInto('dup-1', 'survivor', 'registrar');

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.localPatientId === 'dup-1')?.supersededBy).toBe('survivor');
    expect((await svc.findLink('s', 'r'))?.localPatientId).toBe('survivor');
  });

  it('a merged-away link no longer resolves — the live row is the only answer', async () => {
    const store = memoryLinkStore();
    const svc = new PatientIdentityService(registry, store);
    await svc.link({ localPatientId: 'dup-1', remoteSystem: 's', remotePatientId: 'r', confidence: 1, method: 'cross-reference', linkedBy: 'registrar' });
    await svc.mergeInto('dup-1', 'survivor', 'registrar');
    // The moved row is LIVE: it must not carry supersededBy, or the merge would
    // resolve to nothing and the patient would read as unknown.
    expect(store.rows[0]!.supersededBy).toBeUndefined();
  });
});

describe('F3 · outbound identity is the receiving system’s name for the patient', () => {
  const link: PatientCrossReference = {
    id: 'x', localPatientId: 'f1-pt-0001', remoteSystem: 'urn:oid:1.2.840.114350', remotePatientId: 'e63a',
    confidence: 1, method: 'cross-reference', linkedBy: 'registrar', linkedAt: '2026-09-13T00:00:00.000Z', verified: true,
  };

  it('emits Patient/<remoteId> plus our MRN as an identifier', () => {
    const out = outboundPatientIdentity({ localPatientId: 'f1-pt-0001', localMrn: 'MRN-0001', links: [link] });
    expect(out.subjectReference).toBe('Patient/e63a');
    expect(out.remapped).toBe(true);
    expect(out.identifiers).toEqual([
      { system: 'urn:oid:1.2.840.114350', value: 'e63a' },
      { system: 'urn:mrn', value: 'MRN-0001' },
    ]);
  });

  it('falls back to the local id when there is no verified link', () => {
    const out = outboundPatientIdentity({ localPatientId: 'f1-pt-0001', localMrn: 'MRN-0001', links: [{ ...link, verified: false }] });
    expect(out.subjectReference).toBe('Patient/f1-pt-0001');
    expect(out.remapped).toBe(false);
  });
});

describe('F3 · stable outbound ids turn a retried push into an update', () => {
  it('derives the SAME id from the same effect, so push PUTs instead of POSTing a duplicate', () => {
    expect(stableResourceId('event:abc-123')).toBe(stableResourceId('event:abc-123'));
    expect(stableResourceId('event:abc-123')).toMatch(/^[0-9a-f]{32}$/);
    expect(stableResourceId('event:abc-124')).not.toBe(stableResourceId('event:abc-123'));
    expect(stableResourceId('event:abc-123', 'obs')).toMatch(/^[0-9a-f]{32}-obs$/);
  });
});

describe('F3 · corrections supersede, they never delete', () => {
  it('detects entered-in-error on any resource', () => {
    const c = correctionFrom({ resourceType: 'Observation', id: 'o1', status: 'entered-in-error' });
    expect(c).toMatchObject({ action: 'entered-in-error', resourceId: 'o1' });
  });

  it('detects a Patient merge via link replaced-by', () => {
    const c = correctionFrom({ resourceType: 'Patient', id: 'dup-1', link: [{ type: 'replaced-by' }] });
    expect(c?.action).toBe('merge');
  });

  it('treats 410 Gone on a re-fetch as a deletion notice, not a transport error', () => {
    expect(correctionFromStatus(410, 'Observation')?.action).toBe('deleted');
    expect(correctionFromStatus(500, 'Observation')).toBeUndefined();
  });

  it('says nothing about a normal resource', () => {
    expect(correctionFrom({ resourceType: 'Patient', id: 'p1', status: 'active' })).toBeUndefined();
  });
});

/* ------------------------------------------------- the guard, end to end */

let realmSeq = 0;
function makeRealm() {
  const id = `realm:f3-${++realmSeq}`;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  realm.start();
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Anant Dialysis', units: ['U1'], patientCount: 1 });
  const localPatientId = realm.graph.listKind('patient')[0]!.id;
  return { realm, localPatientId, id };
}

function patientBundle(patient: Record<string, unknown>, type: Bundle['type'] = 'transaction'): Bundle {
  return {
    resourceType: 'Bundle',
    type,
    entry: [{ resource: patient as never, request: { method: 'POST', url: 'Patient' } }],
  } as Bundle;
}

function populationFor(localPatientId: string): LocalPatientDemographics[] {
  return [{ localPatientId, family: 'Okafor', given: 'Ada', birthDate: '1968-04-12', sex: 'female', identifiers: [{ system: 'urn:mrn', value: 'MRN-0001' }] }];
}

describe('F3 · an inbound Patient is written against the LOCAL patient, not its remote id', () => {
  it('resolves by MRN and does NOT create a second chart', async () => {
    const { realm, localPatientId, id } = makeRealm();
    const before = realm.graph.listKind('patient').length;

    const result = await ingestFhirBundle(
      realm,
      ctx(id),
      patientBundle({
        resourceType: 'Patient', id: 'e63a-remote-999', gender: 'female', birthDate: '1968-04-12',
        name: [{ family: 'Okafor', given: ['Ada'] }],
        identifier: [{ system: 'urn:mrn', value: 'MRN-0001' }],
      }),
      { identity: { registry, population: populationFor(localPatientId), links: [] } },
    );

    expect(result.applied).toBe(1);
    expect(result.rolledBack).toBe(false);
    // The remote id must NOT have become a patient: that is the phantom chart.
    expect(realm.graph.get(realm.graph.urnFor('patient', 'e63a-remote-999'))).toBeUndefined();
    expect(realm.graph.listKind('patient')).toHaveLength(before);
    expect(realm.graph.get(realm.graph.urnFor('patient', localPatientId))).toBeDefined();
  });

  it('an UNRESOLVABLE patient FAILS the entry and rolls the transaction back', async () => {
    const { realm, localPatientId, id } = makeRealm();
    const before = realm.graph.listKind('patient').length;

    const result = await ingestFhirBundle(
      realm,
      ctx(id),
      patientBundle({
        resourceType: 'Patient', id: 'unknown-remote', gender: 'male', birthDate: '1999-02-02',
        name: [{ family: 'Never-Seen', given: ['Nils'] }],
        identifier: [{ system: 'urn:mrn', value: 'MRN-9999' }],
      }),
      { identity: { registry, population: populationFor(localPatientId), links: [] } },
    );

    expect(result.rolledBack).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.summary.skipped.join(' ')).toMatch(/patient-identity-unresolved/);
    // Nothing was created — the population is untouched.
    expect(realm.graph.listKind('patient')).toHaveLength(before);
    expect(realm.graph.get(realm.graph.urnFor('patient', 'unknown-remote'))).toBeUndefined();
  });

  it('an AMBIGUOUS patient fails the entry — a wrong-patient write is not attempted', async () => {
    const { realm, localPatientId, id } = makeRealm();
    const twins: LocalPatientDemographics[] = [
      { localPatientId, family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01', sex: 'female' },
      { localPatientId: `${localPatientId}-twin`, family: 'Nguyen', given: 'Kim', birthDate: '1970-01-01', sex: 'female' },
    ];
    const result = await ingestFhirBundle(
      realm,
      ctx(id),
      patientBundle({
        resourceType: 'Patient', id: 'kt-remote', gender: 'female', birthDate: '1970-01-01',
        name: [{ family: 'Nguyen', given: ['Kim'] }],
      }),
      { identity: { registry, population: twins, links: [] } },
    );

    expect(result.applied).toBe(0);
    expect(result.summary.skipped.join(' ')).toMatch(/patient-identity-ambiguous/);
    expect(realm.graph.get(realm.graph.urnFor('patient', 'kt-remote'))).toBeUndefined();
  });

  it('without an identity snapshot the pre-F3 adopt-by-remote-id behaviour is preserved', async () => {
    // Documented, not accidental: a same-system replay is the case where the
    // remote id IS the local id. An EMR feed must pass a snapshot.
    const { realm, id } = makeRealm();
    const result = await ingestFhirBundle(realm, ctx(id), patientBundle({ resourceType: 'Patient', id: 'plain-1', gender: 'male' }), {});
    expect(result.applied).toBe(1);
    expect(realm.graph.get(realm.graph.urnFor('patient', 'plain-1'))).toBeDefined();
  });
});

/* ------------------------------------------------------------ the API surface */

const actor: ActorContext = { actorRef: 'user:ops', scopeIds: ['scope:*'], purposeOfUse: 'operations', clearance: 'restricted-phi' };

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit() { /* noop */ },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('F3 · the identity API answers "who is this?" without writing anything', () => {
  it('reports an unresolvable patient as blocked, not as a 500', async () => {
    const app = await makeApp();
    const { id } = makeRealm();
    const res = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/resolve',
      payload: { realmId: id, patient: { resourceType: 'Patient', id: 'nope', name: [{ family: 'Stranger', given: ['Nils'] }], birthDate: '1999-02-02' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; writesBlocked: boolean };
    expect(body.status).toBe('unresolved');
    expect(body.writesBlocked).toBe(true);
  });

  it('400s without a patient and 404s for an unknown realm', async () => {
    const app = await makeApp();
    const { id } = makeRealm();
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/identity/resolve', payload: { realmId: id } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/identity/resolve', payload: { realmId: 'realm:nope', patient: {} } })).statusCode).toBe(404);
  });

  it('a recorded link makes the SAME patient resolve on the next encounter', async () => {
    const app = await makeApp();
    const { id, localPatientId } = makeRealm();
    const systems = 'urn:oid:1.2.840.114350';

    // 1. Without a link, an EMR-native identifier resolves to nothing.
    const before = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/resolve',
      payload: { realmId: id, patient: { resourceType: 'Patient', id: 'e63a', identifier: [{ system: systems, value: 'remote-1' }] } },
    });
    expect((before.json() as { status: string }).status).toBe('unresolved');

    // 2. A human records the link.
    const linked = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/link',
      payload: { realmId: id, localPatientId, remoteSystem: systems, remotePatientId: 'remote-1', actor: 'registrar' },
    });
    expect(linked.statusCode).toBe(200);
    expect((linked.json() as { link: { verified: boolean } }).link.verified).toBe(true);

    // 3. Now the same EMR identifier resolves — no demographics required.
    const after = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/resolve',
      payload: { realmId: id, patient: { resourceType: 'Patient', id: 'e63a', identifier: [{ system: systems, value: 'remote-1' }] } },
    });
    const resolution = after.json() as { status: string; localPatientId: string; method: string; writesBlocked: boolean };
    expect(resolution.status).toBe('resolved');
    expect(resolution.localPatientId).toBe(localPatientId);
    expect(resolution.method).toBe('cross-reference');
    expect(resolution.writesBlocked).toBe(false);

    // And the evidence is listable.
    const list = await app.inject({ method: 'GET', url: `/admin/fhir/identity/links/${encodeURIComponent(id)}` });
    expect((list.json() as { count: number; unverified: number }).count).toBe(1);
    expect((list.json() as { unverified: number }).unverified).toBe(0);
  });

  it('requires the link fields, and merges a duplicate', async () => {
    const app = await makeApp();
    const { id, localPatientId } = makeRealm();
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/identity/link', payload: { localPatientId } })).statusCode).toBe(400);

    await app.inject({
      method: 'POST', url: '/admin/fhir/identity/link',
      payload: { realmId: id, localPatientId: 'dup-9', remoteSystem: 'urn:oid:9', remotePatientId: 'r9', actor: 'registrar' },
    });
    const merged = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/link',
      payload: { merge: { fromLocalPatientId: 'dup-9', toLocalPatientId: localPatientId }, actor: 'registrar' },
    });
    expect(merged.statusCode).toBe(200);
    expect((merged.json() as { merged: number }).merged).toBe(1);

    // The merged-away id no longer resolves; the survivor does.
    const res = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/resolve',
      payload: { realmId: id, patient: { resourceType: 'Patient', id: 'e', identifier: [{ system: 'urn:oid:9', value: 'r9' }] } },
    });
    expect((res.json() as { localPatientId: string }).localPatientId).toBe(localPatientId);
  });

  it('registers a connection-specific identifier system durably', async () => {
    const app = await makeApp();
    const before = await app.inject({ method: 'GET', url: '/admin/fhir/identity/systems' });
    const beforeCount = (before.json() as { systems: unknown[] }).systems.length;

    const created = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/systems',
      payload: { oid: '1.2.840.114350.1', label: 'Epic MRN assigner' },
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as { system: { kind: string; authoritative: boolean } }).system).toMatchObject({ kind: 'oid', authoritative: true });

    const after = await app.inject({ method: 'GET', url: '/admin/fhir/identity/systems' });
    expect((after.json() as { systems: unknown[] }).systems.length).toBe(beforeCount + 1);
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/identity/systems', payload: {} })).statusCode).toBe(400);
  });
});
