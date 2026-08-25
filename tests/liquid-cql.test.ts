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

// Deep slice — CQL scoring of learned trajectories.
//
// The liquid trajectory's projected labs become a FHIR bundle that the REAL CQL measure
// evaluator (cql-execution over a hand-authored ELM, no VSAC needed) scores — so a learned
// trajectory's clinical effect is *scored*, not asserted. Uses the same m21 hypertension
// fixture as the existing measure e2e suite.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeasureEvaluator } from '../src/measures/evaluator.js';
import { ValueSetRegistry } from '../src/measures/value-set-registry.js';
import { buildLabsBundle, scoreLabs, type LabPatient } from '../src/liquid/index.js';
import type { StoredLibrary, StoredMeasure } from '../src/measures/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/m21');

function loadLibrary(): StoredLibrary {
  const elm = JSON.parse(readFileSync(join(FIXTURES, 'm21-basic-library.elm.json'), 'utf8'));
  return {
    id: 'M21Basic/1.0.0', name: 'M21Basic', version: '1.0.0', url: 'urn:test:M21Basic',
    content: { elmJson: elm }, valueSetRefs: [], codeSystemRefs: ['http://snomed.info/sct'],
    upstream: { repo: 'test-fixture/m21', path: 'm21-basic-library.elm.json', blobSha: 'x', commitSha: 'x', rawUrl: 'file://x', fetchedAt: new Date().toISOString(), contentHash: 'x' },
  };
}
function loadMeasure(): StoredMeasure {
  return {
    id: 'ecqm:M21Basic/1.0.0', cmsId: 'M21-BASIC', name: 'M21Basic', title: 'M21 Basic Blood Pressure Screen',
    version: '1.0.0', status: 'active', effectivePeriod: { start: '2025-01-01', end: '2025-12-31' },
    libraryRefs: ['urn:test:M21Basic'],
    raw: {
      resourceType: 'Measure',
      group: [{
        population: [
          { code: { coding: [{ code: 'initial-population' }] }, criteria: { expression: 'Initial Population' } },
          { code: { coding: [{ code: 'denominator' }] }, criteria: { expression: 'Denominator' } },
          { code: { coding: [{ code: 'denominator-exclusion' }] }, criteria: { expression: 'Denominator Exclusions' } },
          { code: { coding: [{ code: 'numerator' }] }, criteria: { expression: 'Numerator' } },
        ],
      }],
    },
    upstream: { repo: 'test-fixture/m21', path: 'measure.json', blobSha: 'x', commitSha: 'x', rawUrl: 'file://x', fetchedAt: new Date().toISOString(), contentHash: 'x' },
  };
}

function labs(k: number, hgb: number, urr: number, phos: number): LabPatient['labs'] {
  return { K: k, HGB: hgb, URR: urr, PHOS: phos };
}

describe('CQL scoring of learned trajectories', () => {
  it('builds a FHIR bundle from liquid labs (Patient + Observations + Condition)', () => {
    const patient: LabPatient = { id: 'p1', labs: labs(4.2, 11.5, 68, 5.1), hypertension: true };
    const bundle = buildLabsBundle(patient) as { resourceType: string; entry: Array<{ resource: { resourceType: string } }> };
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.entry.map((e) => e.resource.resourceType)).toEqual(expect.arrayContaining(['Patient', 'Observation', 'Condition']));
  });

  it('scores a hypertensive patient into the numerator with real CQL', async () => {
    const vsr = new ValueSetRegistry(mkdtempSync(join(tmpdir(), 'hh-vsr-')));
    const evaluator = new MeasureEvaluator({ measures: [loadMeasure()], libraries: [loadLibrary()], valueSetRegistry: vsr });
    const patients: LabPatient[] = [
      { id: 'p-htn', labs: labs(4.2, 11.5, 68, 5.1), hypertension: true },
      { id: 'p-clean', labs: labs(4.2, 12, 70, 4.5), hypertension: false },
    ];
    const result = await scoreLabs(evaluator, 'ecqm:M21Basic/1.0.0', patients);
    expect(result.scored).toBe(true);
    const htn = result.patients.find((p) => p.patientId === 'p-htn')!;
    expect(htn.met).toBe(true); // numerator: essential hypertension
    expect(Object.keys(htn.populations)).toEqual(expect.arrayContaining(['initial-population', 'denominator', 'denominator-exclusion', 'numerator']));
    expect(htn.populations['numerator']).toBe(true);
    const clean = result.patients.find((p) => p.patientId === 'p-clean')!;
    expect(clean.met).toBe(false);
  });

  it('degrades gracefully when the measure store is not loaded', async () => {
    const result = await scoreLabs(undefined, 'ecqm:X', []);
    expect(result.scored).toBe(false);
    expect(result.reason).toBe('measure-store-not-loaded');
  });
});
