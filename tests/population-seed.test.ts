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

// S3 — the end-to-end seeder. This is where the phase's exit criteria are actually
// asserted, so the tests are written as criteria rather than as coverage:
//
//   1. patients exist in the realm with a unit, an age, a problem list and labs;
//   2. the trajectory engine ADVANCES FROM THE SEEDED STATE rather than from zero — a
//      patient seeded with an abnormal haemoglobin is more anaemic, in the engine's own
//      state, than one seeded with a normal one;
//   3. re-running creates NOTHING and reports `already-seeded`;
//   4. a half-seeded realm is REFUSED rather than silently continued;
//   5. the ingest leaves no stale presence behind.
//
// The fixture is hand-written rather than a captured Synthea file, so the test does not
// depend on a gitignored artifact. It uses LITERAL LOINC codes — 718-7 (haemoglobin),
// 2823-3 (potassium), 85354-9 (Synthea's blood-pressure panel) — and not `codeFor`,
// so a mistake in the code registry cannot make the fixture agree with the bug. Those
// three codes were each confirmed present in real generated output.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Realm } from '../src/realm/realm.js';
import { TrajectoryAmbientProcess } from '../src/liquid/trajectory.js';
import { configHashOf, POPULATION_MANIFEST_VERSION, writeManifest } from '../src/population/synthea/manifest.js';
import { projectPopulation } from '../src/population/synthea/project-population.js';
import { seedRealmFromPopulation } from '../src/population/synthea/seed.js';
import type { PopulationManifest } from '../src/population/synthea/manifest.js';
import type { DialysisState } from '../src/liquid/types.js';

const REALM = 'realm:seed';
const FACILITY = 'fac-seed';
const LOCAL_A = 'realm-seed-pt-0001';
const LOCAL_B = 'realm-seed-pt-0002';

const HGB_CODE = '718-7';
const K_CODE = '2823-3';
const BP_PANEL = '85354-9';
const HR_CODE = '8867-4';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;

const patient = (id: string, birthDate: string, gender: string): Obj => ({
  resourceType: 'Patient',
  id,
  name: [{ use: 'official', family: 'Seed', given: ['Test'] }],
  gender,
  birthDate,
  identifier: [{ system: 'https://github.com/synthetichealth/synthea', value: id }],
});

const condition = (id: string, subject: string, display: string): Obj => ({
  resourceType: 'Condition',
  id,
  subject: { reference: `Patient/${subject}` },
  code: { coding: [{ system: 'http://snomed.info/sct', code: '1', display }] },
  onsetDateTime: '2024-01-01',
});

const lab = (id: string, subject: string, code: string, value: number, unit: string, date: string): Obj => ({
  resourceType: 'Observation',
  id,
  subject: { reference: `Patient/${subject}` },
  status: 'final',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
  code: { coding: [{ system: 'http://loinc.org', code, display: code }] },
  effectiveDateTime: date,
  valueQuantity: { value, unit },
});

const vitals = (id: string, subject: string, code: string, value: number, unit: string, date: string, components?: Obj[]): Obj => ({
  resourceType: 'Observation',
  id,
  subject: { reference: `Patient/${subject}` },
  status: 'final',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
  code: { coding: [{ system: 'http://loinc.org', code, display: code }] },
  effectiveDateTime: date,
  ...(components ? { component: components } : { valueQuantity: { value, unit } }),
});

/**
 * Two patients with deliberately different haemoglobins.
 *
 * A: 8.5 g/dL and a potassium, so the primed state is measurable and lands on
 *    `anemic-worsening`. B: 11.2 g/dL and no potassium, so the two patients must be
 *    told apart by the engine rather than by the fixture.
 */
function bundleA(): Obj {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: patient('syn-a', '1958-04-11', 'female') },
      { resource: condition('c-a-esrd', 'syn-a', 'End-stage renal disease (disorder)') },
      { resource: condition('c-a-htn', 'syn-a', 'Essential hypertension (disorder)') },
      { resource: condition('c-a-admin', 'syn-a', 'Medication review due (situation)') },
      // A SUPERSEDED haemoglobin, then the current one. Retention must keep the newer
      // value, and it is the newer value the engine must be primed from.
      { resource: lab('l-a-hgb-old', 'syn-a', HGB_CODE, 7.1, 'g/dL', '2025-11-02T09:00:00Z') },
      { resource: lab('l-a-hgb', 'syn-a', HGB_CODE, 8.5, 'g/dL', '2026-05-20T09:00:00Z') },
      { resource: lab('l-a-k', 'syn-a', K_CODE, 5.0, 'mmol/L', '2026-05-20T09:05:00Z') },
      { resource: vitals('v-a-hr', 'syn-a', HR_CODE, 88, 'beats/min', '2026-05-20T09:10:00Z') },
      {
        resource: vitals('v-a-bp', 'syn-a', BP_PANEL, 0, 'mm[Hg]', '2026-05-20T09:11:00Z', [
          { code: { coding: [{ code: '8480-6' }] }, valueQuantity: { value: 148, unit: 'mm[Hg]' } },
          { code: { coding: [{ code: '8462-4' }] }, valueQuantity: { value: 88, unit: 'mm[Hg]' } },
        ]),
      },
      // Excluded types: present so the report has something to be honest about.
      { resource: { resourceType: 'Encounter', id: 'e-a', status: 'finished', subject: { reference: 'Patient/syn-a' } } },
      { resource: { resourceType: 'Immunization', id: 'i-a', status: 'completed', occurrenceDateTime: '2020-01-01' } },
    ],
  };
}

function bundleB(): Obj {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: patient('syn-b', '1971-09-30', 'male') },
      { resource: condition('c-b-dm2', 'syn-b', 'Diabetes mellitus type 2 (disorder)') },
      { resource: condition('c-b-ckd', 'syn-b', 'Chronic kidney disease stage 3 (disorder)') },
      { resource: lab('l-b-hgb', 'syn-b', HGB_CODE, 11.2, 'g/dL', '2026-05-18T09:00:00Z') },
      { resource: vitals('v-b-hr', 'syn-b', HR_CODE, 76, 'beats/min', '2026-05-18T09:10:00Z') },
    ],
  };
}

/** Write a population artifact for `realmId` to a temp root and return that root. */
function writePopulation(realmId: string = REALM, bundles: Obj[] = [bundleA(), bundleB()]): string {
  const root = mkdtempSync(join(tmpdir(), 'hh-pop-'));
  roots.push(root);
  const fhir = join(root, realmId, 'fhir');
  mkdirSync(fhir, { recursive: true });

  const config = { generatorVersion: 'synthea-7-test', population: bundles.length, seed: 424242, referenceDate: '20260601' };
  const manifest: PopulationManifest = {
    manifestVersion: POPULATION_MANIFEST_VERSION,
    realmId,
    generator: 'synthea-reference',
    config,
    configHash: configHashOf(config),
    outputDigest: 'test-output-digest',
    patientDigest: 'test-patient-digest',
    patientCount: bundles.length,
    nonReproducible: ['practitioner-roster', 'provider-display-names'],
    generatedAt: '2026-06-01T00:00:00.000Z',
    fileCount: bundles.length,
    argv: ['--realm', realmId],
    records: { total: bundles.length, alive: bundles.length, dead: 0 },
  };
  writeManifest(root, manifest);
  bundles.forEach((b, i) => writeFileSync(join(fhir, `patient-${i}.json`), JSON.stringify(b), 'utf8'));
  return root;
}

function patientState(realm: Realm, localId: string): Record<string, unknown> {
  const rec = realm.graph.get(realm.graph.urnFor('patient', localId));
  expect(rec, `patient ${localId} should exist`).toBeDefined();
  return (rec!.state ?? {}) as Record<string, unknown>;
}

function liquidOf(realm: Realm, localId: string): DialysisState | undefined {
  return (patientState(realm, localId)['liquid'] as { state?: DialysisState } | undefined)?.state;
}

interface Harness {
  readonly realm: Realm;
  readonly proc: TrajectoryAmbientProcess;
}

async function harness(id = REALM): Promise<Harness> {
  const realm = new Realm({ id, mode: 'sim', trajectoryEngine: 'liquid' });
  const proc = realm.ambient.list().find((p) => p instanceof TrajectoryAmbientProcess) as TrajectoryAmbientProcess;
  await proc.whenReady();
  return { realm, proc };
}

const SEED_OPTS = { facilityId: FACILITY, facilityKind: 'dialysis' as const, facilityName: 'Seed Dialysis', units: ['A', 'B'] };

describe('seedRealmFromPopulation — the exit criteria (S3)', () => {
  it('ingests, enriches and primes a realm from a population artifact', async () => {
    const { realm } = await harness();
    try {
      const root = writePopulation();
      const report = await seedRealmFromPopulation(realm, { realmId: REALM, root, ...SEED_OPTS });

      expect(report.guard.verdict).toBe('fresh');
      expect(report.patients.seeded).toBe(2);
      expect(report.patients.bundlesRead).toBe(2);
      expect(report.projection.inputEntries).toBe(16);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);

      // --- patients exist, and carry the renal shape ---------------------------
      expect(realm.graph.listKind('patient').map((p) => p.id).sort()).toEqual([LOCAL_A, LOCAL_B]);

      const a = patientState(realm, LOCAL_A);
      expect(a['admitted']).toBe(true);
      expect(a['facilityId']).toBe(FACILITY);
      expect(a['unitId']).toBe(`${FACILITY}-A`);
      expect(a['age']).toBe(new Date('2026-06-01T00:00:00.000Z').getUTCFullYear() - 1958);
      expect(a['dialysisVintageYears']).toBeGreaterThan(0);
      expect(a['access']).toMatchObject({ type: expect.stringMatching(/^(avf|avg|catheter)$/) });
      // THE durable half: never overwritten by the engine.
      expect(a['problemList']).toEqual(['ESRD', 'HTN']);
      expect(a['trajectory']).toBe('anemic-worsening');

      const b = patientState(realm, LOCAL_B);
      expect(b['problemList']).toEqual(['CKD', 'DM2']);
      expect(b['unitId']).toBe(`${FACILITY}-B`);

      // --- the unit relation exists, once -------------------------------------
      const unitUrn = realm.graph.urnFor('unit', `${FACILITY}-A`);
      const rec = realm.graph.get(realm.graph.urnFor('patient', LOCAL_A))!;
      expect(rec.relations['in-unit']).toEqual([unitUrn]);

      // --- labs are the MEASURED values, and the newest per analyte ------------
      expect(a['labs']).toMatchObject({ HGB: 8.5, K: 5.0 });
      expect(a['lastVitals']).toMatchObject({ hr: 88, bp: '148/88' });
      expect(b['labs']).toMatchObject({ HGB: 11.2 });
      expect(Object.keys(a['labs'] as Obj)).not.toContain('PHOS');

      // --- the report is honest about what it excluded -------------------------
      expect(report.projection.dropped.map((d) => d.resourceType).sort()).toEqual(expect.arrayContaining(['Encounter', 'Immunization']));
      expect(report.enrich.problemTerms.map((p) => p.term).sort()).toEqual(['CKD', 'DM2', 'ESRD', 'HTN']);
      // §8 #7 — the problem list is now projected from the graph's `condition`
      // entities, and the bundle parse is retained ONLY to be compared against it.
      // This is that comparison, and zero is the only acceptable value: the two
      // sources read the same vocabulary over the same displays, so a non-zero count
      // means the id join or the entity kind has drifted — which would otherwise
      // present as "these patients happen to have no conditions", since an empty
      // problem list is legitimate for 67 of the 150 real patients.
      //
      // Asserted alongside the term list above rather than instead of it: the terms
      // prove the projection produced the RIGHT answer, this proves it produced it
      // from the graph rather than by luck.
      expect(report.enrich.problemReconcileMisses).toBe(0);
      expect(report.enrich.unmatchedConditions.map((u) => u.display)).toContain('Medication review due (situation)');
      expect(report.enrich.ageRange).toEqual({ min: 54, max: 68 });
      expect(report.observations.withLabs).toBe(2);
      expect(report.observations.newestDays).toMatchObject({ min: expect.any(Number), median: expect.any(Number), max: expect.any(Number) });

      // --- the engine was seeded, not left at zero -----------------------------
      expect(report.prime.engine).toBe('liquid');
      expect(report.prime.seeded).toBe(2);
      expect(report.prime.bySource.find((s) => s.source === 'measured')!.patients).toBe(2);
      expect(report.prime.bySource.find((s) => s.source === 'engine-covariate')!.patients).toBe(2);
      expect(report.prime.noSourceDimensions).toContain('deterioration_risk');
    } finally {
      realm.stop();
    }
  });

  it('EXIT CRITERION: the engine advances from the seeded state, not from zero', async () => {
    // The phase's headline criterion. Two patients, one anaemic and one not, and the
    // engine's OWN state must tell them apart — a single realm-wide default would give
    // both the same value.
    const { realm, proc } = await harness();
    try {
      const root = writePopulation();
      await seedRealmFromPopulation(realm, { realmId: REALM, root, ...SEED_OPTS });
      expect(proc.seededPatientIds()).toEqual(expect.arrayContaining([LOCAL_A, LOCAL_B]));

      // Before any tick, `enrichPatient` has written the measured values.
      expect(patientState(realm, LOCAL_A)['labs']).toMatchObject({ HGB: 8.5 });

      // One hour of realm time. `liquid` state is written ONLY by the engine's tick, so
      // its presence proves the engine ran — and its value proves what it started from.
      realm.clock.advanceBy(60 * 60 * 1000);

      const stateA = liquidOf(realm, LOCAL_A);
      const stateB = liquidOf(realm, LOCAL_B);
      expect(stateA, 'the engine did not tick for patient A').toBeDefined();
      expect(stateB, 'the engine did not tick for patient B').toBeDefined();

      expect(stateA!.anemia_severity).toBeGreaterThan(0.5);
      expect(stateA!.anemia_severity).toBeGreaterThan(stateB!.anemia_severity);

      // And it survives projection: the engine's reported haemoglobin still reflects the
      // chart, rather than snapping to the model default of 13 g/dL.
      const labsA = patientState(realm, LOCAL_A)['labs'] as { HGB: number };
      const labsB = patientState(realm, LOCAL_B)['labs'] as { HGB: number };
      expect(labsA.HGB).toBeLessThan(10);
      expect(labsA.HGB).toBeLessThan(labsB.HGB);
    } finally {
      realm.stop();
    }
  });

  it('EXIT CRITERION: re-running creates nothing and reports already-seeded', async () => {
    const { realm } = await harness();
    try {
      const root = writePopulation();
      const first = await seedRealmFromPopulation(realm, { realmId: REALM, root, ...SEED_OPTS });
      expect(first.guard.verdict).toBe('fresh');

      const entitiesAfterFirst = realm.graph.listKind('patient').length;
      const ledgerAfterFirst = realm.ledger.listAll().length;

      const second = await seedRealmFromPopulation(realm, { realmId: REALM, root, ...SEED_OPTS });
      expect(second.guard.verdict).toBe('already-seeded');
      expect(second.patients.seeded).toBe(0);
      expect(second.ingest.chunks).toBe(0);
      expect(second.observations.withLabs).toBe(0);
      expect(second.guard.detail).toMatch(/already present/);

      // Nothing changed: same patients, and NO new ledger entries.
      expect(realm.graph.listKind('patient').length).toBe(entitiesAfterFirst);
      expect(realm.ledger.listAll().length).toBe(ledgerAfterFirst);
      // The ids are stable across runs — that is what makes this possible.
      expect(realm.graph.listKind('patient').map((p) => p.id).sort()).toEqual([LOCAL_A, LOCAL_B]);
    } finally {
      realm.stop();
    }
  });

  it('EXIT CRITERION: refuses a half-seeded realm rather than duplicating', async () => {
    // `result-lab` is not an upsert — the reducer calls `graph.create` with no existence
    // check, so a second ingest of the same bundle THROWS out of `ingestFhirBundle`.
    // Neither continuing nor stopping silently is acceptable: a realm holding half a
    // population has quietly wrong cohorts, denominators and chair counts.
    const { realm } = await harness('realm:seed-partial');
    try {
      const root = writePopulation('realm:seed-partial');
      // One of the two planned patients already exists, as if a previous run died.
      realm.graph.create('patient', 'realm-seed-partial-pt-0001', { admitted: true });

      await expect(seedRealmFromPopulation(realm, { realmId: 'realm:seed-partial', root, ...SEED_OPTS })).rejects.toThrow(/partial-population/);
      // It refused BEFORE writing anything.
      expect(realm.graph.listKind('patient')).toHaveLength(1);
    } finally {
      realm.stop();
    }
  });

  it('EXIT CRITERION: leaves no stale ingest presence behind', async () => {
    const { realm } = await harness();
    try {
      const root = writePopulation();
      const before = realm.presences.list().length;
      await seedRealmFromPopulation(realm, { realmId: REALM, root, ...SEED_OPTS });

      // `ingestFhirBundle` spawns a presence per call and never retires it, so an
      // unguarded seeder would leave hundreds behind in a real population.
      expect(realm.presences.list()).toHaveLength(before);
      expect(realm.presences.list().some((p) => /population-seed|fhir-ingest/.test(p.agentSpecId))).toBe(false);
    } finally {
      realm.stop();
    }
  });
});

describe('seedRealmFromPopulation — guards and options (S3)', () => {
  it('creates the facility and its units before admitting anyone', async () => {
    const { realm } = await harness('realm:seed-fac');
    try {
      const root = writePopulation('realm:seed-fac');
      await seedRealmFromPopulation(realm, { realmId: 'realm:seed-fac', root, ...SEED_OPTS });
      const facility = realm.graph.get(realm.graph.urnFor('facility', FACILITY));
      expect(facility?.state).toMatchObject({ kind: 'dialysis', name: 'Seed Dialysis' });
      expect(realm.graph.listKind('unit').map((u) => u.id).sort()).toEqual([`${FACILITY}-A`, `${FACILITY}-B`]);
    } finally {
      realm.stop();
    }
  });

  it('reports a missing population with the command that would create it', async () => {
    const { realm } = await harness('realm:seed-missing');
    try {
      const empty = mkdtempSync(join(tmpdir(), 'hh-pop-empty-'));
      roots.push(empty);
      await expect(seedRealmFromPopulation(realm, { realmId: 'realm:seed-missing', root: empty, ...SEED_OPTS })).rejects.toThrow(
        /population-not-found.*population:generate/s,
      );
    } finally {
      realm.stop();
    }
  });

  it('reports an incomplete artifact rather than seeding around it', async () => {
    const { realm } = await harness('realm:seed-incomplete');
    try {
      const root = writePopulation('realm:seed-incomplete');
      rmSync(join(root, 'realm:seed-incomplete', 'fhir'), { recursive: true, force: true });
      await expect(seedRealmFromPopulation(realm, { realmId: 'realm:seed-incomplete', root, ...SEED_OPTS })).rejects.toThrow(/population-incomplete/);
    } finally {
      realm.stop();
    }
  });

  it('seeds only the durable half when seedObservationState is false', async () => {
    // The escape hatch exists so a caller can compare a primed engine against the static
    // path; without it the comparison is impossible.
    const { realm } = await harness('realm:seed-durable');
    try {
      const root = writePopulation('realm:seed-durable');
      const report = await seedRealmFromPopulation(realm, { realmId: 'realm:seed-durable', root, ...SEED_OPTS, seedObservationState: false });
      const a = patientState(realm, 'realm-seed-durable-pt-0001');

      // `labs` has exactly ONE writer — `enrichPatient` — so the flag is observable here.
      expect(a['labs']).toBeUndefined();
      // `lastVitals` does NOT, and the difference is worth pinning rather than
      // glossing over: the INGEST emits its own `record-vitals` effect for the
      // vital-signs observations, and that happens whatever this flag says. So the
      // flag suppresses the ENRICH assertion of a measurement, not the ingest's
      // record of one. A reader trusting the flag to mean "no clinical values at all"
      // would be wrong.
      //
      // Both vitals survive, which is itself a regression check: the heart rate comes
      // from the `8867-4` observation and the blood pressure from the `85354-9` panel's
      // components. They are two separate `record-vitals` effects, and the reducer used
      // to rebuild `lastVitals` from scratch on each one — so whichever arrived second
      // erased the first.
      expect(a['lastVitals']).toMatchObject({ hr: 88, bp: '148/88' });

      // The durable half is still written — that is the point of the flag.
      expect(a['problemList']).toEqual(['ESRD', 'HTN']);
      // And the engine is still seeded: priming reads the SUMMARY, not the graph.
      expect(report.prime.seeded).toBe(2);
      expect(report.observations.withLabs).toBe(2);
    } finally {
      realm.stop();
    }
  });

  it('honours a limit and a projection option', async () => {
    const { realm } = await harness('realm:seed-limit');
    try {
      const root = writePopulation('realm:seed-limit');
      const report = await seedRealmFromPopulation(realm, { realmId: 'realm:seed-limit', root, ...SEED_OPTS, limit: 1 });
      expect(report.patients.bundlesRead).toBe(1);
      expect(report.patients.seeded).toBe(1);
      expect(realm.graph.listKind('patient')).toHaveLength(1);
    } finally {
      realm.stop();
    }
  });

  it('is deterministic — the same artifact seeds two realms identically', async () => {
    // Ordinals rather than hashes exist for this: the same artifact must produce the same
    // local ids and the same charts, so a re-seed patches rather than grows. Two
    // separate roots hold byte-identical artifacts for the same realm id, and two
    // separate Realm objects are seeded from them.
    const one = await harness('realm:seed-det');
    const two = await harness('realm:seed-det');
    try {
      const rootOne = writePopulation('realm:seed-det');
      const rootTwo = writePopulation('realm:seed-det');
      await seedRealmFromPopulation(one.realm, { realmId: 'realm:seed-det', root: rootOne, ...SEED_OPTS });
      await seedRealmFromPopulation(two.realm, { realmId: 'realm:seed-det', root: rootTwo, ...SEED_OPTS });

      const snapshot = (realm: Realm) =>
        realm.graph
          .listKind('patient')
          .map((p) => {
            const s = p.state as Obj;
            // `lastVitals.at` is a wall-clock stamp taken when the vital was recorded, so
            // it differs by a millisecond between two realms created in sequence. It is
            // not part of the chart's deterministic content and is compared separately.
            const lv = { ...((s['lastVitals'] as Obj | undefined) ?? {}) };
            delete lv['at'];
            return { id: p.id, problemList: s['problemList'], labs: s['labs'], lastVitals: lv, unitId: s['unitId'], trajectory: s['trajectory'], access: s['access'] };
          })
          .sort((a, b) => a.id.localeCompare(b.id));

      const snapshotOne = snapshot(one.realm);
      expect(snapshotOne).toHaveLength(2);
      // Identical local ids — the property that lets a re-seed patch rather than grow.
      expect(snapshotOne.map((p) => p.id)).toEqual(['realm-seed-det-pt-0001', 'realm-seed-det-pt-0002']);
      // `access` and `unitId` carry no clock reading, so they compare exactly.
      expect(snapshot(two.realm)).toEqual(snapshotOne);
      // The `at` stamps are individually well-formed even though they are not compared.
      for (const p of two.realm.graph.listKind('patient')) {
        expect(((p.state as Obj)['lastVitals'] as Obj)['at']).toEqual(expect.any(String));
      }
    } finally {
      one.realm.stop();
      two.realm.stop();
    }
  });

  it('seeds the SAME charts from the projected form as from the raw form', async () => {
    // The two forms must be interchangeable, because the committed one has to be able to
    // stand in for the raw one. Anything less and committing the projected artifact would
    // change what a demo realm looks like — which is the kind of difference nobody would
    // notice until a screen disagreed with a screenshot.
    const seedRoot = mkdtempSync(join(tmpdir(), 'hh-proj-seed-'));
    roots.push(seedRoot);

    const fromRaw = await harness('realm:seed-proj');
    const fromProjected = await harness('realm:seed-proj');
    try {
      const rawRoot = writePopulation('realm:seed-proj');
      const projected = projectPopulation({ realmId: 'realm:seed-proj', rawRoot, seedRoot });
      expect(projected.patients).toBe(2);

      const rawReport = await seedRealmFromPopulation(fromRaw.realm, { realmId: 'realm:seed-proj', root: rawRoot, form: 'raw-fhir', ...SEED_OPTS });
      const projectedReport = await seedRealmFromPopulation(fromProjected.realm, { realmId: 'realm:seed-proj', seedRoot, form: 'projected', ...SEED_OPTS });

      // The form is reported, so a caller can tell which bytes were read.
      expect(rawReport.provenance.artifactForm).toBe('raw-fhir');
      expect(projectedReport.provenance.artifactForm).toBe('projected');
      expect(projectedReport.patients.seeded).toBe(rawReport.patients.seeded);

      // The same charts: ids, problems, unit, labs, vitals, trajectory, access.
      const snapshot = (realm: Realm) =>
        realm.graph
          .listKind('patient')
          .map((p) => {
            const s = p.state as Obj;
            const lv = { ...((s['lastVitals'] as Obj | undefined) ?? {}) };
            delete lv['at'];
            return { id: p.id, problemList: s['problemList'], labs: s['labs'], lastVitals: lv, unitId: s['unitId'], trajectory: s['trajectory'], access: s['access'] };
          })
          .sort((a, b) => a.id.localeCompare(b.id));

      const rawSnapshot = snapshot(fromRaw.realm);
      expect(rawSnapshot).toHaveLength(2);
      expect(snapshot(fromProjected.realm)).toEqual(rawSnapshot);
    } finally {
      fromRaw.realm.stop();
      fromProjected.realm.stop();
    }
  });
});
