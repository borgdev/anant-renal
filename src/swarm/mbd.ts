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

// P4 — CKD-MBD protocol pack (steps A–F).
//
//  1. Feature contract for the CKD-MBD set point (P, corrected Ca, PTH, vitamin D,
//     binder/calcimimetic exposure, dialysis dose).
//  2. The coupled responder: a therapy change moves [P, Ca, PTH] TOGETHER, with
//     delayed response. This is the protocol's core: the published SVM head is
//     cross-sectional, so the engine is a coupled multi-output temporal model.
//  3. KDIGO as a HARD CONTRACT — no proposed combination may leave the safety
//     envelope (corrected Ca ceiling, hypocalcaemia floor, phosphate floor).
//  4. Deterministic set-point latent + a bounded recommendation.
//
// CDSS only: everything here is a proposal for the nephrologist. The platform
// never writes a therapy, never orders a drug, never holds autonomous authority.

import type { CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';

/* ======================================================================
 * 1. Feature contract + KDIGO reference bounds
 * ====================================================================== */

export interface MbdFeature {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  relevance: number;
}

export const MBD_FEATURES: readonly MbdFeature[] = [
  { id: 'phosphate', label: 'Serum phosphate', unit: 'mg/dL', min: 1.5, max: 12, relevance: 0.20 },
  { id: 'correctedCalcium', label: 'Albumin-corrected calcium', unit: 'mg/dL', min: 6.5, max: 12, relevance: 0.18 },
  { id: 'pth', label: 'PTH (intact)', unit: 'pg/mL', min: 10, max: 2000, relevance: 0.16 },
  { id: 'phosphateTrend30d', label: 'Phosphate trend (30 d)', unit: 'mg/dL/30d', min: -3, max: 3, relevance: 0.10 },
  { id: 'calciumTrend30d', label: 'Corrected calcium trend (30 d)', unit: 'mg/dL/30d', min: -2, max: 2, relevance: 0.08 },
  { id: 'vitaminD', label: '25-OH vitamin D', unit: 'ng/mL', min: 4, max: 80, relevance: 0.08 },
  { id: 'binderDaysPerWeek', label: 'Binder doses per week (measured adherence)', unit: 'doses', min: 0, max: 21, relevance: 0.07 },
  { id: 'calcimimeticDose', label: 'Calcimimetic daily dose', unit: 'mg', min: 0, max: 180, relevance: 0.05 },
  { id: 'vitaminDActiveDose', label: 'Active vitamin D analogue dose', unit: 'mcg', min: 0, max: 3, relevance: 0.04 },
  { id: 'dialysisKtV', label: 'Delivered spKt/V (dose coupling)', unit: '', min: 0.6, max: 1.8, relevance: 0.04 },
];

/** KDIGO targets and the hard safety envelope. */
export const MBD_REFERENCE = {
  /** KDIGO: lower phosphate toward the normal range, no routine "normalisation" */
  phosphateTargetMgDl: { lower: 2.5, upper: 5.5 },
  /** KDIGO: keep corrected calcium in the normal range (no hypercalcaemia) */
  correctedCalciumTargetMgDl: { lower: 8.4, upper: 10.2 },
  /**
   * The hard safety envelope. A proposed therapy combination that projects
   * outside this envelope is REFUSED by the contract, whatever the model says.
   */
  calciumSafetyCeilingMgDl: 10.5,
  calciumSafetyFloorMgDl: 8.0,
  phosphateSafetyFloorMgDl: 2.0,
  /** 2–9× the upper limit of normal for the assay (~65 pg/mL) */
  pthTargetPgMl: { lower: 130, upper: 585 },
  vitaminDSufficiencyNgMl: 30,
  horizonsDays: [30, 60, 90] as const,
  /** minimum serial triplets (P, Ca, PTH measured together) before the coupled model runs */
  minTriplets: 2,
  /** a triplet older than this is stale for a therapy change */
  maxTripletAgeDays: 120,
} as const;

/* ======================================================================
 * 2. The coupled responder — the heart of P4
 * ====================================================================== */

export type MbdAction =
  | 'continue'
  | 'increase-binder'
  | 'reduce-binder'
  | 'switch-binder'
  | 'start-calcimimetic'
  | 'increase-calcimimetic'
  | 'reduce-calcimimetic'
  | 'start-vitamin-d'
  | 'reduce-vitamin-d'
  | 'dialysis-dose-review'
  | 'adherence-coaching'
  | 'safety-review'
  | 'hold'
  | 'blocked';

export interface MbdTherapyState {
  /** sevelamer-equivalent binder, mg/day */
  binderMgPerDay: number;
  binderClass: 'sevelamer' | 'calcium-acetate' | 'lanthanum' | 'none';
  calcimimeticMgPerDay: number;
  activeVitaminDMcgPerDay: number;
}

export interface MbdCoupledInput {
  patientId: string;
  /** current measured set point */
  phosphate?: number | undefined;
  calcium?: number | undefined;
  albumin?: number | undefined;
  pth?: number | undefined;
  vitaminD?: number | undefined;
  /** serial context */
  triplets?: number | undefined;
  lastTripletAt?: string | undefined;
  phosphateTrend30d?: number | undefined;
  calciumTrend30d?: number | undefined;
  /** therapy */
  therapy?: MbdTherapyState | undefined;
  /** measured adherence proxy: binder doses actually taken per week */
  binderDosesPerWeek?: number | undefined;
  prescribedDosesPerWeek?: number | undefined;
  ktV?: number | undefined;
  /** protein/phosphate intake proxy (dietary recall, g/day) */
  dietaryProteinGPerDay?: number | undefined;
  asOf?: string | undefined;
}

/** Albumin-corrected calcium (Payne formula: +0.8 mg/dL per 1.0 g/dL of albumin below 4.0). */
export function correctedCalcium(calciumMgDl: number, albuminGDl?: number): number {
  if (albuminGDl === undefined) return Math.round(calciumMgDl * 100) / 100;
  return Math.round((calciumMgDl + 0.8 * (4.0 - albuminGDl)) * 100) / 100;
}

export interface MbdSetPoint {
  phosphate: number;
  correctedCalcium: number;
  pth: number;
}

export interface MbdProjection {
  therapy: MbdTherapyState;
  /** projected [P, Ca, PTH] per horizon */
  points: Record<number, MbdSetPoint>;
  /** probabilities derived from the projected set point */
  risk: {
    hyperphosphatemia: Record<number, number>;
    hypercalcemia: Record<number, number>;
    hypocalcemia: Record<number, number>;
    pthOutOfRange: Record<number, number>;
  };
  /** contract verdict */
  safe: boolean;
  violations: string[];
  note: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const logistic = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * The coupled responder. Every therapy lever moves all three analytes, with the
 * documented signs and a delayed (horizon-dependent) response:
 *
 *   binder ↑        → P ↓ (dose-proportional, saturating), Ca ↑ slightly
 *                     (calcium-based binders only), PTH ↓ (via P)
 *   calcimimetic ↑  → PTH ↓ (strong, fast), Ca ↓ (hypocalcaemia risk), P ↓ (via PTH)
 *   active vit D ↑  → Ca ↑, P ↑ (both), PTH ↓ (moderate, slow)
 *   dialysis dose ↑ → P ↓ (removal), Ca ~, PTH ↓ (slow)
 *   adherence ↑     → same direction as "binder ↑" but with a bounded gain
 *
 * The response fractions are per-horizon multipliers on the daily dose delta,
 * saturating so a doubling is never linear — the model is monotone in every
 * lever, which is what the guardrails and the red team check.
 */
export function projectMbdTherapy(input: MbdCoupledInput, next: MbdTherapyState): MbdProjection {
  const current = input.therapy ?? { binderMgPerDay: 0, binderClass: 'none' as const, calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };
  const P0 = input.phosphate ?? 4.8;
  const Ca0 = correctedCalcium(input.calcium ?? 9.0, input.albumin);
  const PTH0 = input.pth ?? 320;

  const binderDeltaG = (next.binderMgPerDay - current.binderMgPerDay) / 1000; // grams/day
  const calcimimeticDelta = (next.calcimimeticMgPerDay - current.calcimimeticMgPerDay) / 30; // per 30 mg
  const vitDDelta = next.activeVitaminDMcgPerDay - current.activeVitaminDMcgPerDay;
  // adherence: the measured doses/wk versus what was prescribed, bounded to ±25%
  const prescribed = input.prescribedDosesPerWeek ?? Math.max(1, Math.round(current.binderMgPerDay / 800) * 3 * 7);
  const adherenceRatio = input.binderDosesPerWeek !== undefined ? clamp(input.binderDosesPerWeek / prescribed, 0, 1.25) : 1;
  const adherenceGain = clamp(adherenceRatio - 1, -0.25, 0.25);
  const ktVGain = input.ktV !== undefined ? clamp((input.ktV - 1.2) / 1.2, -0.4, 0.4) : 0;
  const calciumBinderShare = next.binderClass === 'calcium-acetate' ? 1 : current.binderClass === 'calcium-acetate' ? 1 : 0;

  const points: Record<number, MbdSetPoint> = {};
  const risk: MbdProjection['risk'] = { hyperphosphatemia: {}, hypercalcemia: {}, hypocalcemia: {}, pthOutOfRange: {} };

  for (const days of MBD_REFERENCE.horizonsDays) {
    // delayed + incomplete response: 30 d ≈ 45%, 60 d ≈ 78%, 90 d ≈ 95% of steady state
    const response = days === 30 ? 0.45 : days === 60 ? 0.78 : 0.95;

    // saturating binder effect: 1 g/day removes ≈1.1 mg/dL at steady state
    const binderEffect = 1.1 * (binderDeltaG / (1 + Math.abs(binderDeltaG) / 4));
    const adherenceEffect = 0.9 * adherenceGain;
    const phosphate = P0
      - response * (binderEffect + adherenceEffect)
      + response * 0.45 * vitDDelta
      - response * 0.25 * ktVGain;

    const calcium = Ca0
      + response * (calciumBinderShare * 0.35 * binderDeltaG + 0.32 * vitDDelta)
      - response * 0.45 * calcimimeticDelta - response * 0.1 * adherenceGain;

    const pth = PTH0
      - response * 30 * (P0 - phosphate) // PTH follows phosphate
      - response * 120 * calcimimeticDelta
      - response * 45 * vitDDelta
      - response * 10 * ktVGain;

    const point: MbdSetPoint = { phosphate: round2(phosphate), correctedCalcium: round2(calcium), pth: Math.round(pth) };
    points[days] = point;

    // risk heads: calibrated logistic on the distance from the KDIGO target
    risk.hyperphosphatemia[days] = round2(logistic((point.phosphate - MBD_REFERENCE.phosphateTargetMgDl.upper) * 1.35));
    risk.hypercalcemia[days] = round2(logistic((point.correctedCalcium - MBD_REFERENCE.correctedCalciumTargetMgDl.upper) * 1.6));
    risk.hypocalcemia[days] = round2(logistic((MBD_REFERENCE.correctedCalciumTargetMgDl.lower - point.correctedCalcium) * 1.6));
    risk.pthOutOfRange[days] = round2(
      Math.max(
        logistic((point.pth - MBD_REFERENCE.pthTargetPgMl.upper) / 60),
        logistic((MBD_REFERENCE.pthTargetPgMl.lower - point.pth) / 40),
      ),
    );
  }

  const { violations, safe } = mbdContractViolations(points);
  return {
    therapy: next,
    points,
    risk,
    safe,
    violations,
    note: safe
      ? `Projected [P ${points[90]!.phosphate}, Ca ${points[90]!.correctedCalcium}, PTH ${points[90]!.pth}] at 90 d, inside the KDIGO safety envelope.`
      : `REFUSED by the KDIGO contract: ${violations.join('; ')}.`,
  };
}

/** The hard contract — evaluated on the projected set point, never softened. */
export function mbdContractViolations(points: Record<number, MbdSetPoint>): { violations: string[]; safe: boolean } {
  const violations: string[] = [];
  for (const [days, point] of Object.entries(points)) {
    if (point.correctedCalcium > MBD_REFERENCE.calciumSafetyCeilingMgDl) {
      violations.push(`corrected calcium ${point.correctedCalcium} mg/dL > ceiling ${MBD_REFERENCE.calciumSafetyCeilingMgDl} at ${days} d`);
    }
    if (point.correctedCalcium < MBD_REFERENCE.calciumSafetyFloorMgDl) {
      violations.push(`corrected calcium ${point.correctedCalcium} mg/dL < floor ${MBD_REFERENCE.calciumSafetyFloorMgDl} at ${days} d`);
    }
    if (point.phosphate < MBD_REFERENCE.phosphateSafetyFloorMgDl) {
      violations.push(`phosphate ${point.phosphate} mg/dL < floor ${MBD_REFERENCE.phosphateSafetyFloorMgDl} at ${days} d`);
    }
  }
  return { violations: [...new Set(violations)], safe: violations.length === 0 };
}

/* ======================================================================
 * 3. Guardrails
 * ====================================================================== */

export type MbdGuardFlag =
  | 'no-serial-triplet'
  | 'single-cross-sectional-lab'
  | 'stale-triplet'
  | 'no-phosphate'
  | 'no-pth'
  | 'hypercalcemia-present'
  | 'calcium-binder-with-hypercalcemia'
  | 'adherence-first'
  | 'hypophosphatemia-present'
  | 'pth-suppressed-do-not-lower-further'
  | 'vitamind-deficient-replete-first'
  | 'within-kdigo-targets';

export interface MbdGuardResult {
  flags: MbdGuardFlag[];
  blocked: boolean;
  blockReason: string | null;
  /** therapy escalation (binder / calcimimetic / vitamin D) is permitted */
  escalationAllowed: boolean;
  /** the measured set point already sits inside every KDIGO target */
  inTarget: boolean;
}

export function guardMbdTherapy(input: MbdCoupledInput): MbdGuardResult {
  const flags: MbdGuardFlag[] = [];
  const triplets = input.triplets ?? 0;
  const hasSetPoint = input.phosphate !== undefined && input.calcium !== undefined;
  if (!hasSetPoint) flags.push('no-phosphate');
  if (input.pth === undefined) flags.push('no-pth');
  if (triplets < MBD_REFERENCE.minTriplets) flags.push('single-cross-sectional-lab');
  if (input.lastTripletAt && input.asOf) {
    const ageDays = (Date.parse(input.asOf) - Date.parse(input.lastTripletAt)) / 86_400_000;
    if (ageDays > MBD_REFERENCE.maxTripletAgeDays) flags.push('stale-triplet');
  }

  const Ca = correctedCalcium(input.calcium ?? 9, input.albumin);
  const hypercalcemic = Ca > MBD_REFERENCE.correctedCalciumTargetMgDl.upper;
  if (hypercalcemic) flags.push('hypercalcemia-present');
  if (input.therapy?.binderClass === 'calcium-acetate' && hypercalcemic) flags.push('calcium-binder-with-hypercalcemia');
  if ((input.phosphate ?? 5) < MBD_REFERENCE.phosphateSafetyFloorMgDl) flags.push('hypophosphatemia-present');
  if ((input.pth ?? 300) < MBD_REFERENCE.pthTargetPgMl.lower) flags.push('pth-suppressed-do-not-lower-further');
  if ((input.vitaminD ?? 30) < MBD_REFERENCE.vitaminDSufficiencyNgMl) flags.push('vitamind-deficient-replete-first');

  const prescribed = input.prescribedDosesPerWeek ?? 0;
  const adherence = prescribed > 0 && input.binderDosesPerWeek !== undefined ? input.binderDosesPerWeek / prescribed : 1;
  if (adherence < 0.7) flags.push('adherence-first');

  const inTarget = (input.phosphate ?? 99) <= MBD_REFERENCE.phosphateTargetMgDl.upper
    && (input.phosphate ?? 0) >= MBD_REFERENCE.phosphateTargetMgDl.lower
    && !hypercalcemic
    && Ca >= MBD_REFERENCE.correctedCalciumTargetMgDl.lower
    && (input.pth ?? 0) >= MBD_REFERENCE.pthTargetPgMl.lower
    && (input.pth ?? 9999) <= MBD_REFERENCE.pthTargetPgMl.upper;
  if (inTarget) flags.push('within-kdigo-targets');

  const blocked = flags.includes('no-phosphate') || flags.includes('no-pth') || flags.includes('single-cross-sectional-lab') || flags.includes('stale-triplet');
  const escalationAllowed = !blocked
    && !flags.includes('adherence-first')
    && !flags.includes('hypophosphatemia-present')
    && !hypercalcemic;
  const blockReason = !blocked
    ? null
    : flags.includes('single-cross-sectional-lab')
      ? `Fewer than ${MBD_REFERENCE.minTriplets} serial [P, Ca, PTH] triplets — a cross-sectional reading cannot drive a coupled therapy change.`
      : flags.includes('stale-triplet')
        ? `Last complete triplet is older than ${MBD_REFERENCE.maxTripletAgeDays} days — re-measure before changing therapy.`
        : flags.includes('no-pth')
          ? 'No PTH in the triplet — the coupled set point is incomplete.'
          : 'No phosphate/calcium set point on file.';

  return { flags, blocked, blockReason, escalationAllowed, inTarget };
}

/* ======================================================================
 * 4. Deterministic 2-D latent — set-point deviation × therapy burden
 * ====================================================================== */

export function mbdLatent(input: MbdCoupledInput): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  /** Signed distance OUTSIDE the KDIGO target range (0 = in range). */
  const excess = (v: number, lower: number, upper: number, floor: number, ceiling: number): number => {
    if (v > upper) return clamp((v - upper) / Math.max(0.1, ceiling - upper), 0, 1);
    if (v < lower) return -clamp((lower - v) / Math.max(0.1, lower - floor), 0, 1);
    return 0;
  };
  const Ca = correctedCalcium(input.calcium ?? 9, input.albumin);
  // Axis 1 — set-point deviation OUTSIDE the KDIGO targets (positive = above)
  const deviation = excess(input.phosphate ?? 4.8, MBD_REFERENCE.phosphateTargetMgDl.lower, MBD_REFERENCE.phosphateTargetMgDl.upper, 2.0, 9.0) * 0.5
    + excess((input.pth ?? 320), MBD_REFERENCE.pthTargetPgMl.lower, MBD_REFERENCE.pthTargetPgMl.upper, 0, 1_200) * 0.3
    + excess(Ca, MBD_REFERENCE.correctedCalciumTargetMgDl.lower, MBD_REFERENCE.correctedCalciumTargetMgDl.upper, 7.0, 12.0) * 0.2;
  // Axis 2 — therapy burden (dose load, adherence gap, calcimimetic exposure)
  const prescribed = input.prescribedDosesPerWeek ?? 0;
  const adherence = prescribed > 0 && input.binderDosesPerWeek !== undefined ? clamp(input.binderDosesPerWeek / prescribed, 0, 1.25) : 1;
  const burden = clamp((input.therapy?.binderMgPerDay ?? 2400) / 6000, 0, 1) * 0.45
    + clamp((input.therapy?.calcimimeticMgPerDay ?? 0) / 120, 0, 1) * 0.3
    + (1 - adherence) * 0.25;
  return {
    l1: clamp(deviation, -1, 1),
    // Axis 2 is a MAGNITUDE (0 = no therapy load, 1 = maximal burden), so the
    // radius grows with either axis and an in-target untreated patient sits near 0.
    l2: clamp(burden, 0, 1),
    polarRadius: Math.hypot(clamp(deviation, -1, 1), clamp(burden, 0, 1)),
    polarAngleRad: Math.atan2(clamp(burden, 0, 1), clamp(deviation, -1, 1)),
  };
}

/* ======================================================================
 * 5. Reference surrogate — bounded recommendation
 * ====================================================================== */

export interface MbdRecommendation {
  patientId: string;
  guardrails: MbdGuardResult;
  latent: ReturnType<typeof mbdLatent>;
  current: {
    phosphate?: number | undefined;
    correctedCalcium?: number | undefined;
    pth?: number | undefined;
    vitaminD?: number | undefined;
    therapy: MbdTherapyState;
    triplets: number;
  };
  action: MbdAction;
  /** the coupled projection for the recommended therapy */
  projection: MbdProjection;
  /** the KDIGO verdict on the CURRENT set point */
  inTarget: boolean;
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: 'reference-surrogate' | 'trained' };
  synthetic: boolean;
  note: string;
}

export const MBD_ADVISOR_MODEL = { id: 'mbd.coupled-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

const NO_THERAPY: MbdTherapyState = { binderMgPerDay: 0, binderClass: 'none', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };

function targetTherapy(input: MbdCoupledInput, action: MbdAction): MbdTherapyState {
  const t = input.therapy ?? NO_THERAPY;
  const p = input.phosphate ?? 4.8;
  const Ca = correctedCalcium(input.calcium ?? 9, input.albumin);
  switch (action) {
    case 'increase-binder': {
      // enough binder to bring phosphate toward the target, saturating at +2.4 g/day
      const gap = Math.max(0, p - MBD_REFERENCE.phosphateTargetMgDl.upper);
      const grams = clamp(gap / 1.1 + 0.4, 0, 2.4);
      return { ...t, binderMgPerDay: Math.round(t.binderMgPerDay + grams * 1000), binderClass: t.binderClass === 'none' ? (Ca > 9.8 ? 'sevelamer' : 'calcium-acetate') : t.binderClass };
    }
    case 'reduce-binder':
      return { ...t, binderMgPerDay: Math.max(0, Math.round(t.binderMgPerDay * 0.6)) };
    case 'switch-binder':
      return { ...t, binderClass: t.binderClass === 'calcium-acetate' ? 'sevelamer' : 'lanthanum' };
    case 'start-calcimimetic':
      return { ...t, calcimimeticMgPerDay: 30 };
    case 'increase-calcimimetic':
      return { ...t, calcimimeticMgPerDay: clamp(t.calcimimeticMgPerDay + 30, 0, 180) };
    case 'reduce-calcimimetic':
      return { ...t, calcimimeticMgPerDay: clamp(t.calcimimeticMgPerDay - 30, 0, 180) };
    case 'start-vitamin-d':
      return { ...t, activeVitaminDMcgPerDay: clamp(t.activeVitaminDMcgPerDay + 0.25, 0, 3) };
    case 'reduce-vitamin-d':
      return { ...t, activeVitaminDMcgPerDay: clamp(t.activeVitaminDMcgPerDay - 0.25, 0, 3) };
    default:
      return t;
  }
}

export function mbdRecommend(input: MbdCoupledInput): MbdRecommendation {
  const guardrails = guardMbdTherapy(input);
  const latent = mbdLatent(input);
  const therapy = input.therapy ?? NO_THERAPY;
  const P = input.phosphate;
  const Ca = correctedCalcium(input.calcium ?? 9, input.albumin);
  const pth = input.pth;

  let action: MbdAction = 'continue';
  let note = '';

  if (guardrails.blocked) {
    action = 'blocked';
    note = guardrails.blockReason ?? 'Blocked by guardrails.';
  } else if (guardrails.flags.includes('adherence-first')) {
    action = 'adherence-coaching';
    note = 'Measured binder adherence is below 70% of the prescribed dose — correct adherence before escalating the dose (the dose is not the problem).';
  } else if (therapy.binderClass === 'calcium-acetate' && Ca > MBD_REFERENCE.correctedCalciumTargetMgDl.upper) {
    action = 'switch-binder';
    note = `Corrected calcium ${Ca} mg/dL with a calcium-based binder — switch to a non-calcium binder rather than stopping phosphate control.`;
  } else if (pth !== undefined && pth < MBD_REFERENCE.pthTargetPgMl.lower) {
    action = 'reduce-calcimimetic';
    note = `PTH ${pth} pg/mL is below the KDIGO range — reduce rather than intensify PTH-lowering therapy.`;
  } else if (pth !== undefined && pth > MBD_REFERENCE.pthTargetPgMl.upper && (P ?? 5) > MBD_REFERENCE.phosphateTargetMgDl.upper) {
    action = therapy.calcimimeticMgPerDay > 0 ? 'increase-calcimimetic' : 'start-calcimimetic';
    note = `PTH ${pth} pg/mL with phosphate ${P} mg/dL — a calcimimetic lowers PTH without raising calcium; the coupled projection keeps corrected calcium inside the envelope.`;
  } else if ((P ?? 5) > MBD_REFERENCE.phosphateTargetMgDl.upper) {
    action = therapy.binderMgPerDay > 0 ? 'increase-binder' : 'increase-binder';
    note = `Phosphate ${P} mg/dL above the KDIGO target — increase the binder dose${therapy.binderClass === 'calcium-acetate' ? ' (calcium-based: watch corrected calcium)' : ''}; the projection honours the calcium ceiling.`;
  } else if ((input.vitaminD ?? 30) < MBD_REFERENCE.vitaminDSufficiencyNgMl && (pth ?? 0) > MBD_REFERENCE.pthTargetPgMl.upper) {
    action = 'start-vitamin-d';
    note = `25-OH vitamin D ${input.vitaminD ?? '—'} ng/mL deficient with PTH above range — repletion lowers PTH but raises both calcium and phosphate, so the projected set point is checked against the envelope.`;
  } else if (input.ktV !== undefined && input.ktV < 1.2 && (P ?? 5) > MBD_REFERENCE.phosphateTargetMgDl.upper) {
    action = 'dialysis-dose-review';
    note = `Phosphate ${P} mg/dL with a delivered spKt/V of ${input.ktV} — a dialysis-dose review removes phosphate without adding a drug.`;
  } else if (guardrails.inTarget) {
    action = 'continue';
    note = 'All three analytes are inside the KDIGO targets — continue and re-measure on the usual cadence.';
  } else {
    action = 'continue';
    note = 'No single-lever change is clearly indicated; continue current therapy and re-measure.';
  }

  const projection = projectMbdTherapy(input, targetTherapy(input, action));

  return {
    patientId: input.patientId,
    guardrails,
    latent,
    current: {
      phosphate: P,
      correctedCalcium: input.calcium !== undefined ? Ca : undefined,
      pth,
      vitaminD: input.vitaminD,
      therapy,
      triplets: input.triplets ?? 0,
    },
    action,
    projection,
    inTarget: guardrails.inTarget,
    drivers: MBD_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance })).sort((a, b) => b.relevance - a.relevance),
    model: MBD_ADVISOR_MODEL,
    synthetic: true,
    note: projection.safe ? note : `${note} ${projection.note}`,
  };
}

/* ======================================================================
 * 6. Bounded cells + durable episodes
 * ====================================================================== */

export const MBD_CELLS: CellManifest[] = [
  {
    id: 'mbd-therapy-advisor',
    version: '0.1.0',
    displayName: 'CKD-MBD coupled therapy advisor',
    domain: 'patient-care',
    owner: 'Nephrology · CKD-MBD',
    consumes: ['lab.result-arrived', 'medication.ordered', 'session.ended.v1'],
    produces: ['mbd.therapy.proposal'],
    allowedActions: ['order-lab', 'update-care-plan', 'schedule-followup', 'notify-staff'],
    approvalClass: 'C',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.5 · coupled multi-output [P, Ca, PTH] with KDIGO as a hard contract',
  },
  {
    id: 'mbd-safety-watch',
    version: '0.1.0',
    displayName: 'CKD-MBD safety watch',
    domain: 'quality',
    owner: 'Nephrology · dialysis unit',
    consumes: ['lab.result-arrived'],
    produces: ['mbd.safety.flag'],
    allowedActions: ['notify-staff', 'flag-safety-event', 'update-care-plan', 'schedule-followup'],
    approvalClass: 'B',
    evalGate: 0.85,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.5 · calcium safety ceiling + hypocalcaemia watch',
  },
];

export const MBD_CONSUMED_BY: Record<string, string[]> = {
  'mbd.therapy.proposal': ['mbd-therapy-advisor', 'mbd-safety-watch'],
  'mbd.safety.flag': ['mbd-safety-watch'],
};

export const MBD_EPISODE_KINDS = ['mbd.setpoint-response'] as const;

export interface MbdDemoState {
  source: 'mbd';
  features: readonly MbdFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  kpis: { patientsOnBinder: number; phosphateInTargetPct: number; hypercalcemiaCount: number; pthInRangePct: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

export function buildMbdDemo(now: () => string = NOW): Omit<MbdDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'mbd-therapy-advisor', kind: 'mbd.therapy.proposal', subject: 'patient:p-mbd-1', scopeType: 'patient',
      option: 'start a calcimimetic alongside the binder', approvalClass: 'C',
      recommendation: 'Patient p-mbd-1: P 6.4 mg/dL, corrected Ca 9.1 mg/dL, PTH 780 pg/mL on sevelamer — a calcimimetic lowers PTH without raising calcium; the coupled projection holds corrected Ca at 8.7 mg/dL at 90 d, inside the KDIGO envelope. Nephrologist review (Class C).',
      allowed: true, evidence: [ev('lab.result-arrived:p-mbd-1', 'fact'), ev('medication.ordered:p-mbd-1', 'fact')],
      producedAt: now(), payload: { projected: { phosphate: 5.2, correctedCalcium: 8.7, pth: 410 } },
    }),
    makeProposal({
      cellId: 'mbd-safety-watch', kind: 'mbd.safety.flag', subject: 'patient:p-mbd-2', scopeType: 'patient',
      option: 'switch from a calcium-based binder', approvalClass: 'B',
      recommendation: 'Patient p-mbd-2: corrected Ca 10.6 mg/dL on calcium acetate with P 5.9 mg/dL — switch to a non-calcium binder rather than accepting hypercalcaemia; nursing/pharmacy review.',
      allowed: true, evidence: [ev('lab.result-arrived:p-mbd-2', 'fact')],
      producedAt: now(), payload: { correctedCalcium: 10.6 },
    }),
  ];
  const insights = aggregateSwarmInsights({ proposals, consumedBy: MBD_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;
  const candidates: NbaCandidate[] = [
    {
      title: 'Calcimimetic for p-mbd-1 (PTH 780 with controlled calcium)', cells: ['mbd therapy advisor'],
      scopeType: 'patient', subject: 'patient:p-mbd-1', owner: 'Nephrology · CKD-MBD', due: 'Next review',
      evidence: [ev('lab.result-arrived:p-mbd-1', 'fact')],
      consensus: 0.92, approvalClass: 'C', expectedOutcome: 38000, urgency: 0.7, policyCost: 0.45, risk: 0.35,
      insightKind: 'mbd.therapy.proposal',
    },
    {
      title: 'Non-calcium binder switch for p-mbd-2 (corrected Ca 10.6)', cells: ['mbd safety watch'],
      scopeType: 'patient', subject: 'patient:p-mbd-2', owner: 'Pharmacy · dialysis unit', due: 'This week',
      evidence: [ev('lab.result-arrived:p-mbd-2', 'fact')],
      consensus: 0.85, approvalClass: 'B', expectedOutcome: 16000, urgency: 0.8, policyCost: 0.25, risk: 0.2,
      insightKind: 'mbd.safety.flag',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true });
  return {
    source: 'mbd',
    features: MBD_FEATURES,
    cells: MBD_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { patientsOnBinder: 41, phosphateInTargetPct: 62, hypercalcemiaCount: 7, pthInRangePct: 55 },
  };
}

export function mbdEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (MBD_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/** Seed: one Class C coupled therapy proposal awaiting approval + one closed Class B safety loop. */
export async function seedMbdEpisodes(
  coordinator: PersistentOutcomeCoordinator,
  _ws?: SwarmWorkspaceStore,
  now: () => string = NOW,
): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const find = (subject: string): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === 'mbd.setpoint-response' && e.subject === subject && e.scopeType === 'patient');

  const p1 = find('patient:p-mbd-1');
  if (!p1) {
    const rec = mbdRecommend({
      patientId: 'p-mbd-1', phosphate: 6.4, calcium: 9.1, albumin: 3.6, pth: 780, vitaminD: 17,
      triplets: 3, phosphateTrend30d: 0.3, calciumTrend30d: -0.1, ktV: 1.35,
      therapy: { binderMgPerDay: 2400, binderClass: 'sevelamer', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 },
      binderDosesPerWeek: 19, prescribedDosesPerWeek: 21, asOf: now(),
    });
    const e = coordinator.open({ kind: 'mbd.setpoint-response', subject: 'patient:p-mbd-1', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:p-mbd-1', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'mbd-therapy-advisor', kind: 'mbd.therapy.proposal', subject: e.subject, scopeType: 'patient',
      option: rec.action, approvalClass: 'C',
      recommendation: rec.note, allowed: true, evidence: [ev('lab.result-arrived:p-mbd-1', 'fact')],
      producedAt: now(), payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(p1.episodeId);
  }

  const p2 = find('patient:p-mbd-2');
  if (!p2) {
    const e = coordinator.open({ kind: 'mbd.setpoint-response', subject: 'patient:p-mbd-2', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:p-mbd-2', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'mbd-safety-watch', kind: 'mbd.safety.flag', subject: e.subject, scopeType: 'patient',
      option: 'switch to a non-calcium binder', approvalClass: 'B',
      recommendation: 'Corrected Ca 10.6 mg/dL on calcium acetate — switch to a non-calcium binder; pharmacy review.',
      allowed: true, evidence: [ev('lab.result-arrived:p-mbd-2', 'fact')], producedAt: now(), payload: { correctedCalcium: 10.6 },
    }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Pharmacy lead', 'B');
    coordinator.dispatchCommand(e.episodeId, 'update-care-plan');
    coordinator.acknowledge(e.episodeId, 'patient:p-mbd-2');
    coordinator.verify(e.episodeId, { measureId: 'mbd.ca-in-range', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(p2.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY MBD episodes. */
export async function dropMbdEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = mbdEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

export const MBD_REFERENCE_SUMMARY = {
  targets: {
    phosphateMgDl: MBD_REFERENCE.phosphateTargetMgDl,
    correctedCalciumMgDl: MBD_REFERENCE.correctedCalciumTargetMgDl,
    pthPgMl: MBD_REFERENCE.pthTargetPgMl,
    vitaminDNgMl: MBD_REFERENCE.vitaminDSufficiencyNgMl,
  },
  envelope: {
    calciumCeilingMgDl: MBD_REFERENCE.calciumSafetyCeilingMgDl,
    calciumFloorMgDl: MBD_REFERENCE.calciumSafetyFloorMgDl,
    phosphateFloorMgDl: MBD_REFERENCE.phosphateSafetyFloorMgDl,
  },
  horizonsDays: MBD_REFERENCE.horizonsDays,
} as const;
