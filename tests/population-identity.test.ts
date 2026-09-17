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

// S3 — Synthea id → realm-scoped local id.
//
// The properties worth pinning are the ones a refactor would quietly break: that the
// mapping is order-independent (a directory listing is not a stable interface), that a
// regenerated population lands on the SAME local ids, and that all three reference
// forms are rewritten — the bare `urn:uuid:` form being the one whose omission is a
// wrong-patient hazard rather than a cosmetic bug.

import { describe, expect, it } from 'vitest';

import {
  applyPatientIdMap,
  localPatientId,
  localPatientIdPrefix,
  MAX_LOCAL_PATIENTS,
  patientIdsIn,
  planPatientIds,
} from '../src/population/synthea/identity.js';
import type { Bundle } from '../src/fhir/types.js';

function bundleOf(entries: Array<Record<string, unknown>>): Bundle {
  return { resourceType: 'Bundle', type: 'collection', entry: entries.map((resource) => ({ resource })) } as unknown as Bundle;
}

const patient = (id: string): Record<string, unknown> => ({ resourceType: 'Patient', id, gender: 'female', birthDate: '1960-01-01' });

describe('local patient identity (S3)', () => {
  it('sanitises a realm id into a usable id prefix', () => {
    // Realm ids carry a colon by convention (`realm:b3`), and several parsers split on
    // one — cohort work-item references use `~` for exactly this reason.
    expect(localPatientIdPrefix('realm:b3')).toBe('realm-b3');
    expect(localPatientIdPrefix('sim:x')).toBe('sim-x');
    expect(planPatientIds(['a'], 'realm:b3').get('a')).toBe('realm-b3-pt-0001');
  });

  it('zero-pads ordinals so the ids sort', () => {
    expect(localPatientId('r', 0)).toBe('r-pt-0001');
    expect(localPatientId('r', 9)).toBe('r-pt-0010');
    expect(localPatientId('r', 99)).toBe('r-pt-0100');
    const ids = [localPatientId('r', 11), localPatientId('r', 2), localPatientId('r', 100)];
    expect([...ids].sort()).toEqual([localPatientId('r', 2), localPatientId('r', 11), localPatientId('r', 100)]);
  });

  it('assigns ordinals by SORTED Synthea id, independent of input order', () => {
    const a = planPatientIds(['c', 'a', 'b'], 'r');
    const b = planPatientIds(['b', 'c', 'a'], 'r');
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.get('a')).toBe('r-pt-0001');
    expect(a.get('b')).toBe('r-pt-0002');
    expect(a.get('c')).toBe('r-pt-0003');
  });

  it('deduplicates a Synthea id seen twice', () => {
    const map = planPatientIds(['a', 'a', 'b'], 'r');
    expect(map.size).toBe(2);
    expect(map.get('b')).toBe('r-pt-0002');
  });

  it('scopes ids to the realm, so one artifact seeds two realms as two patients', () => {
    const x = planPatientIds(['a'], 'realm:x').get('a');
    const y = planPatientIds(['a'], 'realm:y').get('a');
    expect(x).not.toBe(y);
  });

  it('gives the same local ids to a regenerated population with different Synthea ids', () => {
    // The point of ordinals rather than a hash: a different seed produces entirely
    // different Synthea uuids, and hashing would mint a whole new set of local ids —
    // the realm would accumulate patients instead of patching them.
    const first = [...planPatientIds(['zzz', 'aaa', 'mmm'], 'r').values()];
    const second = [...planPatientIds(['qqq', 'bbb', 'nnn'], 'r').values()];
    expect(second).toEqual(first);
  });

  it('refuses a population larger than the id space', () => {
    const ids = Array.from({ length: MAX_LOCAL_PATIENTS + 1 }, (_, i) => `p${i}`);
    expect(() => planPatientIds(ids, 'r')).toThrow(/population-too-large/);
  });

  it('accepts a population exactly at the limit', () => {
    const ids = Array.from({ length: MAX_LOCAL_PATIENTS }, (_, i) => `p${i}`);
    expect(planPatientIds(ids, 'r').size).toBe(MAX_LOCAL_PATIENTS);
  });

  it('collects every Patient id across bundles', () => {
    const bundles = [bundleOf([patient('a'), { resourceType: 'Condition', id: 'c1' }]), bundleOf([patient('b')])];
    expect(patientIdsIn(bundles)).toEqual(['a', 'b']);
  });
});

describe('applyPatientIdMap (S3)', () => {
  it('rewrites the patient id, a Patient/<id> reference, and a bare urn:uuid reference', () => {
    const bundle = bundleOf([
      patient('syn-1'),
      { resourceType: 'Observation', id: 'o1', subject: { reference: 'Patient/syn-1' } },
      { resourceType: 'Observation', id: 'o2', subject: { reference: 'urn:uuid:syn-1' } },
    ]);
    const rewrites = applyPatientIdMap(bundle, new Map([['syn-1', 'r-pt-0001']]));

    expect(bundle.entry![0]!.resource!.id).toBe('r-pt-0001');
    expect(rewrites).toBe(3);
    const refs = bundle.entry!.slice(1).map((e) => (e.resource as { subject?: { reference?: string } }).subject?.reference);
    expect(refs).toEqual(['Patient/r-pt-0001', 'Patient/r-pt-0001']);
  });

  it('rewrites a bare urn:uuid reference even when the target is in ANOTHER bundle', () => {
    // This is the case that makes the rewrite load-bearing. A Synthea patient file runs
    // to ~17,000 entries against the ingest's 500-entry ceiling, so S3 splits it: an
    // observation can land in a chunk that does not contain its patient, and
    // `resolveBundleReferences` only resolves same-bundle targets. Without this
    // rewrite the surviving `urn:uuid:` reaches the reducer, which CREATES a patient
    // under it — a phantom second chart.
    const chunkWithoutPatient = bundleOf([{ resourceType: 'Observation', id: 'o2', subject: { reference: 'urn:uuid:syn-1' } }]);
    const map = planPatientIds(['syn-1'], 'realm:z');
    expect(applyPatientIdMap(chunkWithoutPatient, map)).toBe(1);
    expect((chunkWithoutPatient.entry![0]!.resource as { subject?: { reference?: string } }).subject?.reference).toBe('Patient/realm-z-pt-0001');
  });

  it('leaves a non-patient urn reference alone', () => {
    const bundle = bundleOf([
      patient('syn-1'),
      { resourceType: 'Observation', id: 'o1', subject: { reference: 'urn:uuid:some-practitioner' } },
      { resourceType: 'Observation', id: 'o2', encounter: { reference: 'urn:uuid:some-encounter' } },
    ]);
    expect(applyPatientIdMap(bundle, new Map([['syn-1', 'r-pt-0001']]))).toBe(1);
    expect((bundle.entry![1]!.resource as { subject?: { reference?: string } }).subject?.reference).toBe('urn:uuid:some-practitioner');
    expect((bundle.entry![2]!.resource as { encounter?: { reference?: string } }).encounter?.reference).toBe('urn:uuid:some-encounter');
  });

  it('does not rewrite arbitrary strings that merely contain the uuid', () => {
    // Deliberately not a deep string rewrite: string surgery is the bespoke FHIR
    // parser this design exists to avoid, and it would corrupt free text.
    const bundle = bundleOf([
      patient('syn-1'),
      { resourceType: 'Observation', id: 'o1', note: [{ text: 'see urn:uuid:syn-1 for details' }], valueString: 'urn:uuid:syn-1' },
    ]);
    applyPatientIdMap(bundle, new Map([['syn-1', 'r-pt-0001']]));
    const obs = bundle.entry![1]!.resource as { note?: Array<{ text?: string }>; valueString?: string };
    expect(obs.note?.[0]?.text).toBe('see urn:uuid:syn-1 for details');
    expect(obs.valueString).toBe('urn:uuid:syn-1');
  });

  it('leaves entry.fullUrl alone, so same-chunk lookups keep working', () => {
    const bundle = bundleOf([patient('syn-1')]);
    bundle.entry![0]!.fullUrl = 'urn:uuid:syn-1';
    applyPatientIdMap(bundle, new Map([['syn-1', 'r-pt-0001']]));
    expect(bundle.entry![0]!.fullUrl).toBe('urn:uuid:syn-1');
    expect(bundle.entry![0]!.resource!.id).toBe('r-pt-0001');
  });

  it('is a no-op for an id already mapped to itself', () => {
    const bundle = bundleOf([patient('r-pt-0001')]);
    expect(applyPatientIdMap(bundle, new Map([['r-pt-0001', 'r-pt-0001']]))).toBe(0);
  });

  it('is idempotent — a second application changes nothing', () => {
    const map = new Map([['syn-1', 'r-pt-0001']]);
    const bundle = bundleOf([patient('syn-1'), { resourceType: 'Observation', id: 'o1', subject: { reference: 'urn:uuid:syn-1' } }]);
    expect(applyPatientIdMap(bundle, map)).toBe(2);
    expect(applyPatientIdMap(bundle, map)).toBe(0);
  });

  it('tolerates a cyclic resource graph', () => {
    // `referenceStrings` carries a seen-set; a Synthea bundle is not cyclic, but a
    // walker without one would hang rather than fail, which is the worst outcome.
    const self: Record<string, unknown> = { resourceType: 'Observation', id: 'o1' };
    self.subject = self;
    const bundle = bundleOf([patient('syn-1'), self]);
    expect(() => applyPatientIdMap(bundle, new Map([['syn-1', 'r-pt-0001']]))).not.toThrow();
  });
});
