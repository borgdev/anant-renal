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

// S3, step 3 — priming the engine from measured data.
//
// The exit criterion this file exists to satisfy: *the trajectory engine advances
// from the seeded state rather than from zero — a patient seeded with an abnormal
// Synthea haemoglobin starts in a non-zero `anemia_severity` and moves.*
//
// ---------------------------------------------------------------------------
// WHY THIS INVERTS THE PROJECTION INSTEAD OF REPLAYING THE HISTORY
// ---------------------------------------------------------------------------
// The plan (§4.5(3)) offers two routes to a primed engine and calls the warm-up
// replay the preferred one: feed the observation history as a sequence of steps so
// the engine's own dynamics produce the state. This file takes the other route, and
// the reason is a property of the engine rather than a preference.
//
// `stepWithEvents` does not take observations. It takes a FIVE-ELEMENT EVENT VECTOR,
// and `TrajectoryAmbientProcess.#eventVector` reduces a haemoglobin to one binary
// feature — `lab_marker_elevated`, set when `HGB < 10`. The cardiac and phosphate
// features are thresholds in the same way. So a replay of a haemoglobin history
// cannot recover a haemoglobin: HGB 8.9 and HGB 7.1 produce the *same* event vector,
// and `anemia_severity` converges to whatever the baseline ODE drives it to. Replay
// would satisfy the letter of "seeded, not zero" while making `anemia_severity`
// uncorrelated with the chart it was seeded from.
//
// Inverting the engine's own declared projection (`DIALYSIS_PROJECTION`, in
// `src/liquid/project.ts`) makes the dimension reproduce the measurement exactly:
// seeding `anemia_severity = (13 - HGB) / 5` means the next tick's projected HGB is
// the HGB that was measured. That is the property worth having, and it is why the
// inverse lives here (population side) while the numbers stay in the engine.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED AND WHAT IS COVARIATION
// ---------------------------------------------------------------------------
// Every dimension primed here records HOW it got its value, because the honest
// answer differs per dimension and the plan (§4.6) predicts it: Synthea supplies
// haemoglobin and sometimes phosphate, has no dialysis adequacy at all, and has no
// intra-dialytic signal. Marking a covariate as measured would be the silent
// invention §4.6 warns against, so the distinction is carried in the data:
//
//   `measured`          — the dimension was inverted from the analyte it projects to.
//   `engine-covariate`  — no measurement of this dimension exists; it was inverted
//                         from a DIFFERENT analyte that the engine's own projection
//                         couples to it. This keeps the engine's projected chart
//                         consistent with what was measured. It is not a clinical
//                         claim that the patient's adequacy or instability is known.
//   `no-source`         — nothing to invert. Left at the engine default, and named.

import { DIALYSIS_PROJECTION, type DimensionProjection } from '../../liquid/project.js';
import { TrajectoryAmbientProcess } from '../../liquid/trajectory.js';
import type { DialysisDim, DialysisLabs, DialysisState } from '../../liquid/types.js';
import type { Realm } from '../../realm/realm.js';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Invert an affine projection: the dimension position that produces `observed`.
 *
 * Clamped to [0,1], so a value outside the engine's projected range (a haemoglobin of
 * 15 when the engine's floor is 13) saturates at the boundary rather than driving the
 * dimension out of its declared domain. The saturation is real information and is
 * reported by the caller, not hidden.
 */
export function invertProjection(projection: DimensionProjection, observed: number): number {
  const span = projection.atOne - projection.atZero;
  if (span === 0) return 0;
  return clamp01((observed - projection.atZero) / span);
}

export type DimensionSource = 'measured' | 'engine-covariate' | 'no-source';

export interface PrimedDimension {
  readonly dim: DialysisDim;
  readonly value: number;
  readonly source: DimensionSource;
  /** The analyte actually inverted, when there was one. */
  readonly observed?: string;
  readonly note: string;
}

export interface PrimeResult {
  readonly state: DialysisState;
  readonly dimensions: readonly PrimedDimension[];
  /** Dimensions left at the engine default because the population has no source. */
  readonly noSource: readonly DialysisDim[];
  /** Analytes present in the chart but outside the engine's projected range. */
  readonly saturated: readonly string[];
}

export interface PrimeInput {
  readonly labs?: Partial<DialysisLabs> | undefined;
  readonly vitals?: { readonly hr?: number; readonly spo2?: number } | undefined;
}

/**
 * Compute the engine's initial condition from measured observations.
 *
 * Precedence within a dimension is deliberate: a DIRECT measurement wins over a
 * covariate, so a chart with both a URR and a potassium initialises adequacy from
 * the URR. Synthea has no URR, which is why the covariate path is the one that
 * actually runs on a generated population — and why it says so.
 */
export function primeDialysisState(input: PrimeInput): PrimeResult {
  const labs = input.labs ?? {};
  const vitals = input.vitals ?? {};
  const dimensions: PrimedDimension[] = [];
  const saturated: string[] = [];

  /** Invert, recording saturation when the observed value fell outside the range. */
  const invert = (label: string, projection: DimensionProjection, observed: number): number => {
    const value = invertProjection(projection, observed);
    const raw = projection.atOne === projection.atZero ? 0 : (observed - projection.atZero) / (projection.atOne - projection.atZero);
    if (raw < -1e-9 || raw > 1 + 1e-9) saturated.push(`${label}=${observed} outside engine range [${projection.atZero}, ${projection.atOne}] ${projection.unit}`);
    return value;
  };

  // ---- anemia_severity: measured haemoglobin ---------------------------------
  let anemia = 0;
  if (typeof labs.HGB === 'number') {
    anemia = invert('HGB', DIALYSIS_PROJECTION.HGB, labs.HGB);
    dimensions.push({
      dim: 'anemia_severity',
      value: anemia,
      source: 'measured',
      observed: `HGB=${labs.HGB} g/dL`,
      note: 'Inverted from haemoglobin — the measurement this dimension projects to.',
    });
  } else {
    dimensions.push({
      dim: 'anemia_severity',
      value: 0,
      source: 'no-source',
      note: 'No haemoglobin observation in the ingested window.',
    });
  }

  // ---- phosphate: measured serum phosphate (sparse in Synthea) ---------------
  let phosphate = 0;
  if (typeof labs.PHOS === 'number') {
    phosphate = invert('PHOS', DIALYSIS_PROJECTION.PHOS, labs.PHOS);
    dimensions.push({
      dim: 'phosphate',
      value: phosphate,
      source: 'measured',
      observed: `PHOS=${labs.PHOS} mg/dL`,
      note: 'Inverted from serum phosphate.',
    });
  } else {
    dimensions.push({
      dim: 'phosphate',
      value: 0,
      source: 'no-source',
      note: 'No phosphate observation — Synthea emits it rarely (48 observations in a 150-patient sample).',
    });
  }

  // ---- ktv_adequacy: URR if present, else the engine's potassium coupling ----
  let ktv = 0;
  if (typeof labs.URR === 'number') {
    ktv = invert('URR', DIALYSIS_PROJECTION.URR, labs.URR);
    dimensions.push({
      dim: 'ktv_adequacy',
      value: ktv,
      source: 'measured',
      observed: `URR=${labs.URR}%`,
      note: 'Inverted from the urea reduction ratio.',
    });
  } else if (typeof labs.K === 'number') {
    ktv = invert('K', DIALYSIS_PROJECTION.K, labs.K);
    dimensions.push({
      dim: 'ktv_adequacy',
      value: ktv,
      source: 'engine-covariate',
      observed: `K=${labs.K} mmol/L`,
      note:
        'NOT a measured adequacy. Synthea has no Kt/V and no URR, so this is inverted from serum potassium through the ' +
        'engine\'s own coupling (K = 6.5 - 3·ktv). It exists so the engine\'s projected potassium matches the chart; it is ' +
        'not evidence that this patient is adequately dialysed. Plan §4.6 declares this gap rather than filling it.',
    });
  } else {
    dimensions.push({
      dim: 'ktv_adequacy',
      value: 0,
      source: 'no-source',
      note: 'No URR and no potassium observation.',
    });
  }

  // ---- vitals_instability: intra-dialytic is absent; resting HR is a covariate -
  let unstable = 0;
  if (typeof vitals.hr === 'number') {
    unstable = invert('hr', DIALYSIS_PROJECTION.hr, vitals.hr);
    dimensions.push({
      dim: 'vitals_instability',
      value: unstable,
      source: 'engine-covariate',
      observed: `hr=${vitals.hr} bpm`,
      note:
        'Covariate, not measured instability. Synthea records resting outpatient vital signs, not the intradialytic series ' +
        'the fluid/IDH pack reasons over (plan §4.6). Inverted so the projected heart rate matches the chart.',
    });
  } else if (typeof vitals.spo2 === 'number') {
    unstable = invert('spo2', DIALYSIS_PROJECTION.spo2, vitals.spo2);
    dimensions.push({
      dim: 'vitals_instability',
      value: unstable,
      source: 'engine-covariate',
      observed: `spo2=${vitals.spo2}%`,
      note: 'Covariate, not measured instability — see the heart-rate case.',
    });
  } else {
    dimensions.push({
      dim: 'vitals_instability',
      value: 0,
      source: 'no-source',
      note: 'No heart rate or oxygen saturation observation.',
    });
  }

  // ---- deterioration_risk: no projection, so no source ----------------------
  dimensions.push({
    dim: 'deterioration_risk',
    value: 0,
    source: 'no-source',
    note:
      'Left at 0. No Synthea concept projects to this dimension (plan §4.6); it is derived from the engine\'s own dynamics ' +
      'once the realm runs, and inventing an initial value would be indistinguishable from a measurement.',
  });

  const byDim = new Map(dimensions.map((d) => [d.dim, d.value]));
  const state: DialysisState = {
    vitals_instability: byDim.get('vitals_instability') ?? 0,
    deterioration_risk: byDim.get('deterioration_risk') ?? 0,
    ktv_adequacy: byDim.get('ktv_adequacy') ?? 0,
    phosphate: byDim.get('phosphate') ?? 0,
    anemia_severity: byDim.get('anemia_severity') ?? 0,
  };

  return {
    state,
    dimensions,
    noSource: dimensions.filter((d) => d.source === 'no-source').map((d) => d.dim),
    saturated,
  };
}

export interface EnginePrimeOutcome {
  readonly seeded: boolean;
  /**
   * `liquid` when a liquid realm's trajectory process accepted the state; `absent`
   * when the realm runs the legacy engine (nothing to seed — the legacy
   * `PatientTrajectoryProcess` has no transportable state vector).
   */
  readonly engine: 'liquid' | 'absent';
  readonly reason: string;
}

/**
 * Hand a primed state to a realm's liquid trajectory engine.
 *
 * Reaches the process through `realm.ambient` rather than being told which one to
 * use: the process is constructed inside `Realm` (`defaultAmbient`), so a seeder
 * that received it as a parameter would have to be wired by whoever creates the
 * realm, and the seeding would silently no-op for any realm created another way.
 *
 * A `legacy` realm reports `absent` rather than throwing: `trajectoryEngine` is a
 * per-realm setting, and seeding a legacy realm is a no-op by design, not a failure.
 */
export function primeEngine(realm: Realm, patientId: string, state: DialysisState): EnginePrimeOutcome {
  const process = realm.ambient.list().find((p) => p instanceof TrajectoryAmbientProcess);
  if (!process) {
    return {
      seeded: false,
      engine: 'absent',
      reason:
        realm.trajectoryEngine === 'liquid'
          ? 'realm is configured for the liquid engine but has no TrajectoryAmbientProcess registered'
          : 'realm runs the legacy trajectory engine, which has no transportable state vector to seed',
    };
  }
  process.seedState(patientId, state);
  return { seeded: true, engine: 'liquid', reason: 'initial condition forked into the liquid engine' };
}
