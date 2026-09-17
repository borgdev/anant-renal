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

// Shared projection of the learned 0..1 dialysis state onto the clinical fields the rest of
// the harness understands (labs, vitals, risk, trajectory label). Used by both the realm
// trajectory process and the What-If forecast service so they can't drift apart.

import type { DialysisDim, DialysisLabs, DialysisState } from './types.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface ProjectedState {
  labs: DialysisLabs;
  hr: number;
  spo2: number;
  risk: number;
  trajectory: string;
}

/**
 * The declared state → observation projection.
 *
 * Exported as DATA rather than left inline because S3 needs the INVERSE. Seeding a
 * realm from a generated population means turning a measured haemoglobin into the
 * engine's initial condition, and that inversion has to use THESE numbers. A second
 * copy of `13.0 - 5.0 * anemia` living in `src/population/` is the classic drift
 * bug: the two agree until one is tuned, and the failure surfaces as the engine
 * quietly disagreeing with the chart it was seeded from. `prime.ts` derives its
 * inverse from this table for that reason.
 *
 * This is a naming of the constants the engine already had — not a new renal claim
 * placed inside `src/liquid/`. See the constraint at the top of
 * `src/population/source.ts`: the population→engine mapping belongs on the
 * population side, and this table is what lets it be written without restating a
 * single number.
 */
export interface DimensionProjection {
  /** The engine dimension this observation reads. */
  readonly dim: DialysisDim;
  /** Value attained when the dimension is 0. */
  readonly atZero: number;
  /** Value attained when the dimension is 1. May be BELOW `atZero` — see `HGB`. */
  readonly atOne: number;
  /** Applied on output, so the inverse knows the quantisation it must land on. */
  readonly round: (v: number) => number;
  readonly unit: string;
}

export const DIALYSIS_PROJECTION = Object.freeze({
  K: { dim: 'ktv_adequacy', atZero: 6.5, atOne: 3.5, round: round1, unit: 'mmol/L' },
  HGB: { dim: 'anemia_severity', atZero: 13.0, atOne: 8.0, round: round1, unit: 'g/dL' },
  URR: { dim: 'ktv_adequacy', atZero: 55, atOne: 85, round: Math.round, unit: '%' },
  PHOS: { dim: 'phosphate', atZero: 3.5, atOne: 7.5, round: round1, unit: 'mg/dL' },
  hr: { dim: 'vitals_instability', atZero: 70, atOne: 100, round: Math.round, unit: 'bpm' },
  spo2: { dim: 'vitals_instability', atZero: 98, atOne: 90, round: Math.round, unit: '%' },
} satisfies Record<string, DimensionProjection>);

/** The observation value for a dimension position. Exact affine interpolation. */
export function lerpProjection(p: DimensionProjection, x: number): number {
  return p.round(p.atZero + (p.atOne - p.atZero) * x);
}

export function projectDialysisState(state: DialysisState): ProjectedState {
  const labs: DialysisLabs = {
    K: lerpProjection(DIALYSIS_PROJECTION.K, state.ktv_adequacy),
    HGB: lerpProjection(DIALYSIS_PROJECTION.HGB, state.anemia_severity),
    URR: lerpProjection(DIALYSIS_PROJECTION.URR, state.ktv_adequacy),
    PHOS: lerpProjection(DIALYSIS_PROJECTION.PHOS, state.phosphate),
  };
  return {
    labs,
    hr: lerpProjection(DIALYSIS_PROJECTION.hr, state.vitals_instability),
    spo2: Math.round(clamp(lerpProjection(DIALYSIS_PROJECTION.spo2, state.vitals_instability), 80, 100)),
    risk: round3(state.deterioration_risk),
    trajectory: trajectoryLabel(state),
  };
}

export function trajectoryLabel(s: DialysisState): string {
  if (s.deterioration_risk > 0.6) return 'decompensating';
  if (s.ktv_adequacy < 0.4) return 'underdialyzed';
  if (s.phosphate > 0.65) return 'hyperphosphatemia';
  if (s.anemia_severity > 0.6) return 'anemic-worsening';
  if (s.deterioration_risk < 0.2) return 'stable';
  return 'recovering';
}
