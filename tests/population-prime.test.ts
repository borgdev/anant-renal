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

// S3 — priming the engine from measured observations.
//
// The property this file exists to pin is stated once, precisely: seeding a dimension
// so that the engine's NEXT projected value EQUALS the value that was measured. That is
// what makes `anemia_severity` mean what the chart says, and it is why the inverse is
// derived from `DIALYSIS_PROJECTION` rather than from a restated constant — if the two
// ever drift, the round-trip below fails.
//
// The second property is honesty about provenance. Synthea supplies a haemoglobin and
// rarely a phosphate, has no dialysis adequacy at all, and has no intra-dialytic
// signal. Each dimension records how it got its value, and these tests assert the LABELS
// rather than only the numbers, so a covariate cannot quietly become a measurement.

import { describe, expect, it } from 'vitest';

import { DIALYSIS_PROJECTION, projectDialysisState } from '../src/liquid/project.js';
import { invertProjection, primeDialysisState, primeEngine } from '../src/population/synthea/prime.js';
import { Realm } from '../src/realm/realm.js';
import type { DialysisState } from '../src/liquid/types.js';
import type { DimensionSource, PrimeResult } from '../src/population/synthea/prime.js';

const NEUTRAL: DialysisState = { vitals_instability: 0, deterioration_risk: 0, ktv_adequacy: 0, phosphate: 0, anemia_severity: 0 };

/** The source recorded for a dimension, or a failure explaining its absence. */
function sourceOf(result: PrimeResult, dim: string): DimensionSource {
  const found = result.dimensions.find((d) => d.dim === dim);
  expect(found, `no entry for ${dim}`).toBeDefined();
  return found!.source;
}

function valueOf(result: PrimeResult, dim: string): number {
  return result.dimensions.find((d) => d.dim === dim)!.value;
}

function entryOf(result: PrimeResult, dim: string) {
  return result.dimensions.find((d) => d.dim === dim)!;
}

describe('invertProjection (S3)', () => {
  it('maps the projection endpoints onto the dimension endpoints', () => {
    for (const [label, projection] of Object.entries(DIALYSIS_PROJECTION)) {
      expect(invertProjection(projection, projection.atZero), label).toBeCloseTo(0, 12);
      expect(invertProjection(projection, projection.atOne), label).toBeCloseTo(1, 12);
    }
  });

  it('maps the midpoint to 0.5, including where atOne is BELOW atZero', () => {
    // HGB and spo2 descend: a lower observation is a worse patient. A sign error here
    // would invert every anaemia, which is the class of mistake worth a test.
    expect(invertProjection(DIALYSIS_PROJECTION.HGB, 10.5)).toBeCloseTo(0.5, 12);
    expect(invertProjection(DIALYSIS_PROJECTION.spo2, 94)).toBeCloseTo(0.5, 12);
    expect(invertProjection(DIALYSIS_PROJECTION.K, 5.0)).toBeCloseTo(0.5, 12);
    expect(invertProjection(DIALYSIS_PROJECTION.PHOS, 5.5)).toBeCloseTo(0.5, 12);
  });

  it('clamps outside the projected range rather than leaving the declared domain', () => {
    expect(invertProjection(DIALYSIS_PROJECTION.HGB, 15)).toBe(0);
    expect(invertProjection(DIALYSIS_PROJECTION.HGB, 4)).toBe(1);
    expect(invertProjection(DIALYSIS_PROJECTION.K, 9)).toBe(0);
  });

  it('returns 0 for a degenerate projection rather than dividing by zero', () => {
    const degenerate = { dim: 'phosphate' as const, atZero: 4, atOne: 4, round: Math.round, unit: '' };
    expect(invertProjection(degenerate, 7)).toBe(0);
  });
});

describe('the inverse round-trips through the engine\'s own projection (S3)', () => {
  it('seeding a haemoglobin makes the projected haemoglobin the same value', () => {
    for (const observed of [8.0, 8.5, 9.7, 10.9, 12.3, 13.0]) {
      const state: DialysisState = { ...NEUTRAL, anemia_severity: invertProjection(DIALYSIS_PROJECTION.HGB, observed) };
      expect(projectDialysisState(state).labs.HGB, `HGB ${observed}`).toBeCloseTo(observed, 6);
    }
  });

  it('holds for potassium, phosphate, URR, heart rate and saturation', () => {
    const cases: Array<[string, 'K' | 'PHOS' | 'URR' | 'hr' | 'spo2', number[]]> = [
      ['K', 'K', [3.5, 4.8, 5.0, 6.5]],
      ['PHOS', 'PHOS', [3.5, 5.5, 7.2, 7.5]],
      ['URR', 'URR', [55, 70, 85]],
      ['hr', 'hr', [70, 85, 100]],
      ['spo2', 'spo2', [90, 93, 98]],
    ];
    for (const [label, key, observations] of cases) {
      for (const observed of observations) {
        const projection = DIALYSIS_PROJECTION[key];
        const state: DialysisState = { ...NEUTRAL, [projection.dim]: invertProjection(projection, observed) };
        const projected = projectDialysisState(state);
        const actual = label === 'hr' ? projected.hr : label === 'spo2' ? projected.spo2 : projected.labs[label as 'K' | 'PHOS' | 'URR'];
        expect(actual, `${label} ${observed}`).toBeCloseTo(observed, 6);
      }
    }
  });

  it('holds for the state primeDialysisState actually produces', () => {
    // The integration form of the property above: the value the seeder writes is the
    // value the engine will report on its next tick.
    const primed = primeDialysisState({ labs: { HGB: 8.5, K: 4.8 } });
    const projected = projectDialysisState(primed.state);
    expect(projected.labs.HGB).toBe(8.5);
    expect(projected.labs.K).toBe(4.8);
  });

  it('does not restate the engine constants — it derives from the table', () => {
    // If `prime.ts` hard-coded 13 and 8, this would still pass; if `project.ts` changed
    // them, it would fail. That asymmetry is the point: the numbers live in one place.
    const midpoint = (DIALYSIS_PROJECTION.HGB.atZero + DIALYSIS_PROJECTION.HGB.atOne) / 2;
    const primed = primeDialysisState({ labs: { HGB: midpoint } });
    expect(valueOf(primed, 'anemia_severity')).toBeCloseTo(0.5, 12);
  });
});

describe('primeDialysisState provenance (S3)', () => {
  it('marks a haemoglobin as MEASURED — it is the analyte this dimension projects to', () => {
    const primed = primeDialysisState({ labs: { HGB: 8.5 } });
    expect(valueOf(primed, 'anemia_severity')).toBeCloseTo(0.9, 12);
    expect(sourceOf(primed, 'anemia_severity')).toBe('measured');
    expect(entryOf(primed, 'anemia_severity').observed).toBe('HGB=8.5 g/dL');
  });

  it('marks serum phosphate as MEASURED', () => {
    const primed = primeDialysisState({ labs: { PHOS: 6.5 } });
    expect(valueOf(primed, 'phosphate')).toBeCloseTo(0.75, 12);
    expect(sourceOf(primed, 'phosphate')).toBe('measured');
  });

  it('marks adequacy from potassium as an ENGINE COVARIATE, never as measured', () => {
    // The plan (§4.6) declares this gap. Synthea has no Kt/V and no URR, so adequacy is
    // taken from potassium through the engine's own coupling — enough to make the
    // projected potassium match the chart, but not evidence the patient is adequately
    // dialysed. The note has to say so.
    const primed = primeDialysisState({ labs: { K: 5.0 } });
    expect(sourceOf(primed, 'ktv_adequacy')).toBe('engine-covariate');
    const entry = entryOf(primed, 'ktv_adequacy');
    expect(entry.observed).toBe('K=5 mmol/L');
    expect(valueOf(primed, 'ktv_adequacy')).toBeCloseTo(0.5, 12);
    expect(entry.note).toMatch(/NOT a measured adequacy/);
  });

  it('marks resting heart rate as an ENGINE COVARIATE', () => {
    // Synthea records outpatient vital signs, not the intradialytic series the fluid/IDH
    // pack reasons over.
    const primed = primeDialysisState({ vitals: { hr: 95 } });
    expect(sourceOf(primed, 'vitals_instability')).toBe('engine-covariate');
    expect(entryOf(primed, 'vitals_instability').observed).toBe('hr=95 bpm');
  });

  it('leaves deterioration_risk at the engine default and says there is no source', () => {
    // No Synthea concept projects to it, and inventing an initial value would be
    // indistinguishable from a measurement.
    const primed = primeDialysisState({ labs: { HGB: 8.5, K: 5, PHOS: 6, URR: 70 }, vitals: { hr: 90, spo2: 95 } });
    expect(sourceOf(primed, 'deterioration_risk')).toBe('no-source');
    expect(valueOf(primed, 'deterioration_risk')).toBe(0);
    expect(primed.noSource).toContain('deterioration_risk');
  });

  it('prefers a DIRECT measurement over a covariate for the same dimension', () => {
    // URR is a real adequacy measure; potassium is a stand-in. A chart with both must
    // use the URR.
    const primed = primeDialysisState({ labs: { URR: 85, K: 6.5 } });
    expect(sourceOf(primed, 'ktv_adequacy')).toBe('measured');
    expect(valueOf(primed, 'ktv_adequacy')).toBeCloseTo(1, 12);
    expect(entryOf(primed, 'ktv_adequacy').observed).toBe('URR=85%');
  });

  it('falls back from heart rate to oxygen saturation', () => {
    const withHr = primeDialysisState({ vitals: { hr: 85, spo2: 88 } });
    expect(entryOf(withHr, 'vitals_instability').observed).toBe('hr=85 bpm');
    const withoutHr = primeDialysisState({ vitals: { spo2: 90 } });
    expect(entryOf(withoutHr, 'vitals_instability').observed).toBe('spo2=90%');
    expect(valueOf(withoutHr, 'vitals_instability')).toBeCloseTo(1, 12);
  });

  it('produces a fully default state with no input, and names every gap', () => {
    const primed = primeDialysisState({});
    expect(primed.state).toEqual(NEUTRAL);
    expect([...primed.noSource].sort()).toEqual(['anemia_severity', 'deterioration_risk', 'ktv_adequacy', 'phosphate', 'vitals_instability']);
    expect(primed.saturated).toEqual([]);
    expect(primed.dimensions).toHaveLength(5);
  });

  it('keeps every primed dimension inside [0,1]', () => {
    const primed = primeDialysisState({ labs: { HGB: 20, K: 1, PHOS: 0.5, URR: 5 }, vitals: { hr: 300, spo2: 40 } });
    for (const d of primed.dimensions) {
      expect(d.value, d.dim).toBeGreaterThanOrEqual(0);
      expect(d.value, d.dim).toBeLessThanOrEqual(1);
    }
  });

  it('reports saturation instead of hiding a value outside the engine range', () => {
    // A haemoglobin of 16 is above the engine's ceiling of 13: the dimension clamps, and
    // the caller is TOLD, because silently clamping is how a projection starts quietly
    // disagreeing with the chart it was seeded from.
    const primed = primeDialysisState({ labs: { HGB: 16 } });
    expect(valueOf(primed, 'anemia_severity')).toBe(0);
    expect(primed.saturated).toHaveLength(1);
    expect(primed.saturated[0]).toMatch(/HGB=16 outside engine range \[13, 8\] g\/dL/);
  });

  it('reports saturation for a value below the range too', () => {
    const primed = primeDialysisState({ labs: { HGB: 4 } });
    expect(valueOf(primed, 'anemia_severity')).toBe(1);
    expect(primed.saturated).toHaveLength(1);
  });

  it('does not report saturation for a value exactly on a boundary', () => {
    expect(primeDialysisState({ labs: { HGB: 13 } }).saturated).toEqual([]);
    expect(primeDialysisState({ labs: { HGB: 8 } }).saturated).toEqual([]);
  });
});

describe('primeEngine (S3)', () => {
  it('seeds a liquid realm through its ambient process', () => {
    const realm = new Realm({ id: 'realm:prime-liquid', mode: 'sim', trajectoryEngine: 'liquid' });
    const outcome = primeEngine(realm, 'pt-1', { ...NEUTRAL, anemia_severity: 0.9 });
    expect(outcome.seeded).toBe(true);
    expect(outcome.engine).toBe('liquid');
    realm.stop();
  });

  it('reports the legacy engine as absent rather than throwing', () => {
    // `trajectoryEngine` is a per-realm setting. Seeding a legacy realm is a no-op by
    // design — the legacy process has no transportable state vector — so a seeder must
    // not treat it as a failure.
    const realm = new Realm({ id: 'realm:prime-legacy', mode: 'sim' });
    const outcome = primeEngine(realm, 'pt-1', { ...NEUTRAL, anemia_severity: 0.9 });
    expect(outcome.seeded).toBe(false);
    expect(outcome.engine).toBe('absent');
    expect(outcome.reason).toMatch(/legacy/);
    realm.stop();
  });

  it('names a liquid realm with no trajectory process as a misconfiguration', () => {
    // Distinct from the legacy case, and worth distinguishing: a realm that CLAIMS the
    // liquid engine and cannot accept a seed is broken, not merely different.
    const realm = new Realm({ id: 'realm:prime-broken', mode: 'sim', trajectoryEngine: 'liquid' });
    realm.ambient.unregister('trajectory.liquid');
    const outcome = primeEngine(realm, 'pt-1', { ...NEUTRAL, anemia_severity: 0.9 });
    expect(outcome.seeded).toBe(false);
    expect(outcome.engine).toBe('absent');
    expect(outcome.reason).toMatch(/no TrajectoryAmbientProcess/);
    realm.stop();
  });
});
