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

// Tests for the population digests (S2).
//
// The load-bearing tests here are the DISCRIMINATING ones. It is easy to write a
// digest test that passes because the digest is a constant, so every "equal"
// assertion is paired with a change that must make it UNequal:
//
//   equal    two runs differing only in clinician names   -> same population
//   unequal  a changed clinical code display              -> different population
//   unequal  a changed laboratory value                   -> different population
//   unequal  an added patient                             -> different population
//
// The first two together are the whole point: they prove the normalisation
// removed the volatile layer WITHOUT blinding the digest to clinical content.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NON_REPRODUCIBLE_LAYERS,
  isPatientBundle,
  normalizeForDigest,
  patientDigestOf,
} from '../src/population/synthea/digest.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'synthea-digest-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A patient bundle shaped like the real ones, with a named clinician. */
function patientBundle(clinician: string, haemoglobin = '13.2') {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: { resourceType: 'Patient', id: 'p-1', name: [{ family: 'Sauer652', given: ['Buffy238'] }] } },
      {
        resource: {
          resourceType: 'Observation',
          id: 'o-1',
          status: 'final',
          // A CODE display: clinical content, must survive normalisation.
          code: { coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin' }] },
          // An ENTITY display: volatile, must be normalised away.
          performer: [{ reference: 'Practitioner/pr-1', display: clinician }],
          valueQuantity: { value: Number.parseFloat(haemoglobin), unit: 'g/dL' },
        },
      },
    ],
  };
}

/** Writes a set of named bundles into a fresh directory and returns it. */
function dirOf(files: Record<string, unknown>): string {
  const d = scratch();
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(d, name), JSON.stringify(body), 'utf8');
  }
  return d;
}

describe('S2 — normalisation separates volatile names from clinical codes', () => {
  it('replaces a display that names an entity, and keeps one that names a code', () => {
    const entity = { reference: 'Practitioner/pr-1', display: 'Dr. Eldridge510 Roob72' };
    const code = { coding: [{ code: '718-7', display: 'Hemoglobin' }] };
    expect(normalizeForDigest(entity)).toEqual({ reference: 'Practitioner/pr-1', display: '<entity>' });
    expect(normalizeForDigest(code)).toEqual({ coding: [{ code: '718-7', display: 'Hemoglobin' }] });
  });

  it('treats an identifier beside a display as an entity too', () => {
    expect(normalizeForDigest({ identifier: { value: 'x' }, display: 'Dr. X' })).toEqual({
      identifier: { value: 'x' },
      display: '<entity>',
    });
  });

  it('normalises nested and array positions, not just top level', () => {
    const bundle = patientBundle('Dr. A');
    const out = normalizeForDigest(bundle) as { entry: Array<{ resource: { performer?: Array<{ display: string }> } }> };
    expect(out.entry[1]!.resource.performer![0]!.display).toBe('<entity>');
  });
});

describe('S2 — the digest identifies a population, not a directory', () => {
  it('is EQUAL for two runs differing only in clinician names', () => {
    const a = dirOf({ 'Buffy238_Sauer652_abc.json': patientBundle('Dr. Eldridge510 Roob72') });
    const b = dirOf({ 'Buffy238_Sauer652_abc.json': patientBundle('Dr. Victoria535 Roob72') });
    const da = patientDigestOf(a);
    const db = patientDigestOf(b);
    expect(da.digest).toBe(db.digest);
    expect(da.patientCount).toBe(1);
    expect(da.patientCount).toBe(db.patientCount);
  });

  it('is UNEQUAL when a clinical code display changes', () => {
    const a = dirOf({ 'p.json': patientBundle('Dr. A') });
    const b = dirOf({ 'p.json': patientBundle('Dr. A') });
    const altered = patientBundle('Dr. A') as { entry: Array<{ resource: Record<string, unknown> }> };
    const obs = altered.entry[1]!.resource;
    (obs.code as { coding: Array<{ display: string }> }).coding[0]!.display = 'Haemoglobin';
    writeFileSync(join(b, 'p.json'), JSON.stringify(altered), 'utf8');
    // The normalisation must not have blinded the digest to coding.
    expect(patientDigestOf(a).digest).not.toBe(patientDigestOf(b).digest);
  });

  it('is UNEQUAL when a laboratory value changes', () => {
    const a = dirOf({ 'p.json': patientBundle('Dr. A', '13.2') });
    const b = dirOf({ 'p.json': patientBundle('Dr. A', '7.1') });
    expect(patientDigestOf(a).digest).not.toBe(patientDigestOf(b).digest);
  });

  it('is UNEQUAL when a patient is added', () => {
    const a = dirOf({ 'p1.json': patientBundle('Dr. A') });
    const b = dirOf({ 'p1.json': patientBundle('Dr. A'), 'p2.json': patientBundle('Dr. A') });
    expect(patientDigestOf(a).digest).not.toBe(patientDigestOf(b).digest);
    expect(patientDigestOf(b).patientCount).toBe(2);
  });

  it('is UNEQUAL when a patient bundle is renamed', () => {
    const a = dirOf({ 'Buff238_Sauer652_aaa.json': patientBundle('Dr. A') });
    const b = dirOf({ 'Buff238_Sauer652_bbb.json': patientBundle('Dr. A') });
    expect(patientDigestOf(a).digest).not.toBe(patientDigestOf(b).digest);
  });

  it('is independent of directory order', () => {
    const a = dirOf({ 'p1.json': patientBundle('Dr. A'), 'p2.json': patientBundle('Dr. B') });
    const b = dirOf({ 'p2.json': patientBundle('Dr. B'), 'p1.json': patientBundle('Dr. A') });
    expect(patientDigestOf(a).digest).toBe(patientDigestOf(b).digest);
  });

  it('IGNORES the non-reproducible aggregate files', () => {
    // Measured: practitionerInformation is regenerated with different UUIDs and
    // names every run, and hospitalInformation's FILENAME carries an epoch. Either
    // one folded into a "same population?" digest would answer no forever.
    const practitioner = () => ({
      resourceType: 'Bundle',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'pr-1', name: [{ family: 'Roob72' }] } }],
    });
    const hospital = () => ({
      resourceType: 'Bundle',
      entry: [{ resource: { resourceType: 'Organization', id: 'org-1', name: 'MGH' } }],
    });
    const a = dirOf({
      'p.json': patientBundle('Dr. A'),
      'practitionerInformation111.json': practitioner(),
      'hospitalInformation999.json': hospital(),
    });
    const b = dirOf({
      'p.json': patientBundle('Dr. A'),
      'practitionerInformation222.json': practitioner(),
      'hospitalInformation888.json': hospital(),
    });
    expect(patientDigestOf(a).digest).toBe(patientDigestOf(b).digest);
    expect(patientDigestOf(a).patientCount).toBe(1);
  });
});

describe('S2 — a digest that cannot be trusted says so', () => {
  it('decides "patient bundle" by content, not by filename', () => {
    const practitioner = {
      resourceType: 'Bundle',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'pr-1' } }],
    };
    // Named to look like a patient, but it holds none.
    expect(isPatientBundle(practitioner)).toBe(false);
    expect(isPatientBundle(patientBundle('Dr. A'))).toBe(true);
    expect(isPatientBundle({ resourceType: 'Patient' })).toBe(false);
    expect(isPatientBundle(null)).toBe(false);
  });

  it('reports "empty" rather than a constant when there is nothing to hash', () => {
    expect(patientDigestOf(join(tmpdir(), 'definitely-not-here-9f8a'))).toEqual({
      digest: 'empty',
      patientCount: 0,
      unreadable: [],
    });
    const noPatients = dirOf({
      'hospitalInformation1.json': { resourceType: 'Bundle', entry: [] },
    });
    expect(patientDigestOf(noPatients).digest).toBe('empty');
    expect(patientDigestOf(noPatients).patientCount).toBe(0);
  });

  it('refuses a clean answer when a file is malformed', () => {
    const d = dirOf({ 'p.json': patientBundle('Dr. A') });
    writeFileSync(join(d, 'broken.json'), '{ not json', 'utf8');
    const result = patientDigestOf(d);
    expect(result.digest).toBe('incomplete');
    expect(result.unreadable).toEqual(['broken.json']);
  });

  it('records the layers that are known not to reproduce', () => {
    // If this list is ever emptied, the two-digest design stops being justified
    // and this test should fail so the reasoning gets revisited.
    expect(NON_REPRODUCIBLE_LAYERS).toContain('practitioner-roster');
    expect(NON_REPRODUCIBLE_LAYERS.length).toBeGreaterThan(0);
  });
});
