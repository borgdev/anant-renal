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
 * business logic, computational optimization techniques,
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

// S6 — the two forms a population artifact can take.
//
// The raw form is Synthea's own output, measured at 4,196 KB per patient because each
// bundle is a lifetime record carrying base64 clinical notes and billing. The projected
// form is the same population after `projectBundle`, measured at 49.6 KB per patient.
// Only the second can be committed — 820 MB is not a demo — so this is what makes S6's
// exit criterion reachable: a fresh clone seeds a realm with no JVM.
//
// The tests that matter are not the happy path but the CHUNKING hazards. A projected
// patient can span several bundles, and only the first carries the `Patient` resource —
// so a loader that treats a continuation chunk as a damaged file, or that excludes a
// deceased patient's first chunk but not its later ones, produces a population that
// looks smaller (or, worse, a patient with observations but no chart).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadPopulation } from '../src/population/synthea/population.js';
import { projectPopulation } from '../src/population/synthea/project-population.js';
import { configHashOf, POPULATION_MANIFEST_VERSION } from '../src/population/synthea/manifest.js';
import type { PopulationManifest } from '../src/population/synthea/manifest.js';

const REALM = 'realm:art';
const OTHER_REALM = 'realm:art-other';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const condition = (id: string, subject: string): Obj => ({
  resourceType: 'Condition',
  id,
  subject: { reference: `Patient/${subject}` },
  code: { coding: [{ display: 'End-stage renal disease (disorder)' }] },
});

/** `count` observations, each a DIFFERENT analyte so retention keeps all of them. */
function distinctAnalytes(subject: string, count: number): Obj[] {
  return Array.from({ length: count }, (_, i) => ({
    resourceType: 'Observation',
    id: `obs-${i}`,
    subject: { reference: `Patient/${subject}` },
    status: 'final',
    category: [{ coding: [{ code: 'laboratory' }] }],
    code: { coding: [{ code: `code-${i}` }] },
    effectiveDateTime: '2026-05-20T09:00:00Z',
    valueQuantity: { value: 4 + i / 1000, unit: 'x' },
  }));
}

/**
 * One patient per file, which is the raw form's contract.
 */
function writeRaw(opts: { realmId?: string; patients: Array<{ id: string; entries: Obj[] }> }): string {
  const realmId = opts.realmId ?? REALM;
  const root = tempRoot('hh-art-');
  const fhir = join(root, realmId, 'fhir');
  mkdirSync(fhir, { recursive: true });

  opts.patients.forEach((p, i) => {
    writeFileSync(join(fhir, `patient-${i}.json`), JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: p.entries.map((resource) => ({ resource })) }), 'utf8');
  });

  const config = { generatorVersion: 'synthea-7-test', population: opts.patients.length, seed: 424242, referenceDate: '20260601' };
  const manifest: PopulationManifest = {
    manifestVersion: POPULATION_MANIFEST_VERSION,
    realmId,
    generator: 'synthea-reference',
    config,
    configHash: configHashOf(config),
    outputDigest: 'raw-output-digest',
    patientDigest: 'raw-patient-digest',
    patientCount: opts.patients.length,
    nonReproducible: ['practitioner-roster'],
    generatedAt: '2026-06-01T00:00:00.000Z',
    fileCount: opts.patients.length,
    argv: ['--realm', realmId],
    records: { total: opts.patients.length, alive: opts.patients.length, dead: 0 },
  };
  writeFileSync(join(root, realmId, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return root;
}

/**
 * Two patients: A is large enough to CHUNK (600 distinct analytes across the 500-entry
 * ceiling) and also carries droppable content, B fits in one bundle. Names chosen so
 * `planPatientIds` sorts A first, which makes the chunk grouping deterministic.
 */
function twoPatients(): Array<{ id: string; entries: Obj[] }> {
  return [
    { id: 'syn-a', entries: [{ resourceType: 'Patient', id: 'syn-a', gender: 'female', birthDate: '1958-04-11' }, condition('c-a', 'syn-a'), ...distinctAnalytes('syn-a', 600), ...droppable('syn-a')] },
    { id: 'syn-b', entries: [{ resourceType: 'Patient', id: 'syn-b', gender: 'male', birthDate: '1971-09-30' }, condition('c-b', 'syn-b'), ...distinctAnalytes('syn-b', 1)] },
  ];
}

/**
 * Content the projection is expected to DROP, so the reduction assertions mean something.
 *
 * A fixture of nothing but distinct analytes and recognised conditions projects 1:1 — the
 * reduction comes from excluding resource types and capping history, so a fixture without
 * either cannot exercise it.
 */
function droppable(subject: string): Obj[] {
  return [
    // An excluded resource TYPE (Encounters become admit/discharge effects; see projection.ts).
    ...Array.from({ length: 5 }, (_, i) => ({ resourceType: 'Encounter', id: `enc-${i}`, subject: { reference: `Patient/${subject}` }, status: 'finished' })),
    // Repeated analytes, which retention caps at the newest value.
    ...Array.from({ length: 10 }, (_, i) => ({
      resourceType: 'Observation',
      id: `dup-${i}`,
      subject: { reference: `Patient/${subject}` },
      status: 'final',
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { coding: [{ code: 'repeat-1' }] },
      effectiveDateTime: `2026-05-${String(i + 1).padStart(2, '0')}T09:00:00Z`,
      valueQuantity: { value: 4 + i, unit: 'x' },
    })),
  ];
}

describe('projecting a population into the committed form (S6)', () => {
  it('writes both files and reduces the entry count', () => {
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');

    const result = projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    expect(result.patients).toBe(2);
    expect(existsSync(join(seedRoot, REALM, 'manifest.json'))).toBe(true);
    expect(existsSync(join(seedRoot, REALM, 'bundles.json'))).toBe(true);
    expect(result.outputEntries).toBeLessThan(result.inputEntries);
    // A's retained entries across the 500-entry ceiling is 2 chunks; B is 1.
    expect(result.bundles).toBe(3);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('records the form and what the projection did', () => {
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    const manifest = JSON.parse(readFileSync(join(seedRoot, REALM, 'manifest.json'), 'utf8')) as PopulationManifest;
    expect(manifest.artifactForm).toBe('projected');
    expect(manifest.projected).toMatchObject({ bundles: 3 });
    expect(manifest.projected!.inputEntries).toBeGreaterThan(manifest.projected!.outputEntries);
  });

  it('carries the provenance identity over, and recomputes only the output digest', () => {
    // The two forms of one population must share an identity, because `configHash` and
    // `patientDigest` describe the GENERATION — which projecting does not change. The
    // output digest is the only field that answers a question about this file.
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    const raw = JSON.parse(readFileSync(join(rawRoot, REALM, 'manifest.json'), 'utf8')) as PopulationManifest;
    const projected = JSON.parse(readFileSync(join(seedRoot, REALM, 'manifest.json'), 'utf8')) as PopulationManifest;

    expect(projected.configHash).toBe(raw.configHash);
    expect(projected.patientDigest).toBe(raw.patientDigest);
    expect(projected.patientCount).toBe(raw.patientCount);
    expect(projected.generatedAt).toBe(raw.generatedAt);
    expect(projected.outputDigest).not.toBe(raw.outputDigest);
    expect(projected.outputDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects the raw form explicitly, so a projected artifact is never re-projected', () => {
    // Reading the projected form here would apply retention a second time and report the
    // residue as a fresh measurement. The form is pinned rather than inferred.
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    const first = projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    // Projecting again reads the SAME raw input, so it is stable rather than cumulative.
    const second = projectPopulation({ realmId: REALM, rawRoot, seedRoot });
    expect(second.outputEntries).toBe(first.outputEntries);
    expect(second.bundles).toBe(first.bundles);
  });
});

describe('loading either form (S6)', () => {
  it('reads the projected form and reports it', () => {
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    const loaded = loadPopulation(REALM, { seedRoot, root: rawRoot });
    expect(loaded.form).toBe('projected');
    expect(loaded.directory).toBe(join(seedRoot, REALM));
    expect(loaded.patientsRead).toBe(2);
    // One bundle per CHUNK, so a chunked patient contributes more than one.
    expect(loaded.bundles).toHaveLength(3);
    expect(loaded.unreadable).toEqual([]);
  });

  it('PREFERS the projected form when both exist', () => {
    // The projected form is the committed one, so it is what a clone will have — and
    // preferring it keeps a running deployment on the bytes that were reviewed.
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    expect(loadPopulation(REALM, { seedRoot, root: rawRoot }).form).toBe('projected');
  });

  it('reads the raw form when there is no projected artifact', () => {
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');

    const loaded = loadPopulation(REALM, { seedRoot, root: rawRoot });
    expect(loaded.form).toBe('raw-fhir');
    expect(loaded.patientsRead).toBe(2);
    // One bundle per patient in the raw form.
    expect(loaded.bundles).toHaveLength(2);
  });

  it('honours an explicit form and never falls back', () => {
    // The same rule as the required manifest: silently reading a different artifact than
    // the one asked for is how a provenance guarantee stops meaning anything.
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    expect(loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'raw-fhir' }).form).toBe('raw-fhir');
    expect(loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'projected' }).form).toBe('projected');

    // Asking for a form that is not there fails rather than quietly reading the other.
    const onlyRaw = tempRoot('hh-art-empty-');
    expect(() => loadPopulation(REALM, { seedRoot: onlyRaw, root: rawRoot, form: 'projected' })).toThrow(/population-not-found/);
    expect(() => loadPopulation(REALM, { seedRoot, root: onlyRaw, form: 'raw-fhir' })).toThrow(/population-not-found/);
  });

  it('reports where to look when neither form exists', () => {
    const rawRoot = writeRaw({ patients: twoPatients() });
    const empty = tempRoot('hh-art-empty-');
    expect(() => loadPopulation('realm:absent', { seedRoot: empty, root: rawRoot })).toThrow(/population-not-found.*population:generate/s);
  });

  it('treats a projected manifest with no bundles as incomplete, not as empty', () => {
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });
    rmSync(join(seedRoot, REALM, 'bundles.json'));

    expect(() => loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'projected' })).toThrow(/population-incomplete.*--project/s);
  });
});

describe('chunked patients are handled as patients, not as files (S6)', () => {
  it('keeps a multi-chunk patient whole', () => {
    // Chunk 2 of patient A carries no `Patient` resource. The raw form treats that as a
    // damaged file — correctly, since one file is one patient there — so the projected
    // form must be read differently or a chunked patient would fail the whole load.
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    const projected = projectPopulation({ realmId: REALM, rawRoot, seedRoot });
    expect(projected.bundles).toBe(3);

    const loaded = loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'projected' });
    expect(loaded.unreadable).toEqual([]);
    expect(loaded.bundles).toHaveLength(3);
    // ...and exactly two patients are counted, not three.
    expect(loaded.patientsRead).toBe(2);
  });

  it('stops `limit` at a patient boundary rather than mid-patient', () => {
    // Splitting a patient would leave observations behind whose chunk has no chart, and
    // `record-vitals` CREATES a patient it does not find — so a mid-patient cut produces
    // a phantom rather than a smaller population.
    const rawRoot = writeRaw({ patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    const loaded = loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'projected', limit: 1 });
    expect(loaded.patientsRead).toBe(1);
    // Patient A's BOTH chunks, and not B's.
    expect(loaded.bundles).toHaveLength(2);
    const hasPatient = loaded.bundles.map((b) => (b.entry ?? []).some((e) => e.resource?.resourceType === 'Patient'));
    expect(hasPatient).toEqual([true, false]);

    // The raw form counts patients too, not files, so the flag means the same thing.
    expect(loadPopulation(REALM, { root: rawRoot, form: 'raw-fhir', limit: 1 }).patientsRead).toBe(1);
  });

  it('excludes EVERY chunk of a deceased patient, not just the one with the Patient', () => {
    // Excluding only the Patient chunk would leave that patient's observations to be
    // ingested, and an effect for an unknown patient creates one — a phantom chart
    // carrying half of somebody who died.
    const patients = twoPatients();
    // Mark A deceased, keeping it first in the sort order.
    patients[0]!.entries[0] = { ...patients[0]!.entries[0]!, deceasedBoolean: true };
    const rawRoot = writeRaw({ patients });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    const loaded = loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'projected' });
    expect(loaded.deceasedExcluded).toHaveLength(1);
    expect(loaded.patientsRead).toBe(1);
    expect(loaded.bundles).toHaveLength(1);
    expect(loaded.bundles.every((b) => (b.entry ?? []).some((e) => e.resource?.resourceType === 'Patient'))).toBe(true);
  });

  it('excludes a deceased patient from the raw form too', () => {
    const patients = twoPatients();
    patients[0]!.entries[0] = { ...patients[0]!.entries[0]!, deceasedDateTime: '2025-01-01T00:00:00Z' };
    const rawRoot = writeRaw({ patients });

    const loaded = loadPopulation(REALM, { root: rawRoot, form: 'raw-fhir' });
    expect(loaded.deceasedExcluded).toHaveLength(1);
    expect(loaded.patientsRead).toBe(1);
  });

  it('keeps deceased patients when asked, chunked or not', () => {
    const patients = twoPatients();
    patients[0]!.entries[0] = { ...patients[0]!.entries[0]!, deceasedBoolean: true };
    const rawRoot = writeRaw({ patients });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: REALM, rawRoot, seedRoot });

    const loaded = loadPopulation(REALM, { seedRoot, root: rawRoot, form: 'projected', includeDeceased: true });
    expect(loaded.deceasedExcluded).toEqual([]);
    expect(loaded.patientsRead).toBe(2);
    expect(loaded.bundles).toHaveLength(3);
  });
});

describe('one artifact, one realm (§9.5)', () => {
  it('refuses an artifact labelled for a different realm', () => {
    // The directory name is the realm id. A manifest naming another realm means the
    // artifact was COPIED rather than generated, and seeding it would mint this realm's
    // patients from another realm's people.
    const rawRoot = writeRaw({ realmId: OTHER_REALM, patients: twoPatients() });
    // Make the directory look like REALM's while the manifest still says otherwise.
    mkdirSync(join(rawRoot, REALM, 'fhir'), { recursive: true });
    writeFileSync(join(rawRoot, REALM, 'manifest.json'), readFileSync(join(rawRoot, OTHER_REALM, 'manifest.json')));

    expect(() => loadPopulation(REALM, { root: rawRoot, form: 'raw-fhir' })).toThrow(/population-mislabelled.*realm:art-other/s);
  });

  it('refuses a projected artifact labelled for a different realm', () => {
    const rawRoot = writeRaw({ realmId: OTHER_REALM, patients: twoPatients() });
    const seedRoot = tempRoot('hh-art-seed-');
    projectPopulation({ realmId: OTHER_REALM, rawRoot, seedRoot });
    // Copy OTHER_REALM's projected artifact into REALM's directory.
    mkdirSync(join(seedRoot, REALM), { recursive: true });
    for (const f of ['manifest.json', 'bundles.json']) {
      writeFileSync(join(seedRoot, REALM, f), readFileSync(join(seedRoot, OTHER_REALM, f)));
    }

    expect(() => loadPopulation(REALM, { seedRoot, form: 'projected' })).toThrow(/population-mislabelled/);
  });
});
