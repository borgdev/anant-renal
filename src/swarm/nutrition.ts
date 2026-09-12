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

// P5 — Nutrition / electrolytes (PEW + hyperkalaemia + acidosis) steps A–F.
//
//  1. Feature contract across nutrition and electrolytes.
//  2. PEW disentangled into FIVE pathways — poor intake, inflammation, dilution
//     (overhydration), catabolism and inadequate dialysis — because "falling
//     albumin" has five different treatments and the report is explicit that the
//     pathways must be separated, not averaged.
//  3. Potassium forecast to the next session + P(K > 6.0), with the acidosis
//     coupling (bicarbonate) and the interdialytic interval.
//  4. Emergency vs routine separation: an acute ECG pattern is an ADJUNCT, and
//     EVERY hyperkalaemia action requires a confirmatory lab.
//
// CDSS only: the platform never orders a drug, never summons transport, and
// never actions a potassium on an ECG pattern alone.

import { cellAllowlist, type CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';

/* ======================================================================
 * 1. Feature contract + reference bounds
 * ====================================================================== */

export interface NutritionFeature {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  relevance: number;
}

export const NUTRITION_FEATURES: readonly NutritionFeature[] = [
  { id: 'albumin', label: 'Serum albumin', unit: 'g/dL', min: 1.8, max: 5, relevance: 0.18 },
  { id: 'albuminTrend30d', label: 'Albumin trend (30 d)', unit: 'g/dL/30d', min: -1, max: 1, relevance: 0.10 },
  { id: 'crp', label: 'hs-CRP', unit: 'mg/L', min: 0, max: 60, relevance: 0.14 },
  { id: 'handgripKg', label: 'Handgrip strength', unit: 'kg', min: 5, max: 60, relevance: 0.10 },
  { id: 'nonHdlMgDl', label: 'Non-HDL cholesterol', unit: 'mg/dL', min: 40, max: 220, relevance: 0.08 },
  { id: 'creatinineMgDl', label: 'Predialysis creatinine', unit: 'mg/dL', min: 1, max: 16, relevance: 0.07 },
  { id: 'dryWeightDeltaKg', label: 'Post-dialysis weight change (30 d)', unit: 'kg', min: -6, max: 6, relevance: 0.07 },
  { id: 'potassium', label: 'Pre-dialysis potassium', unit: 'mmol/L', min: 2.5, max: 8, relevance: 0.15 },
  { id: 'bicarbonate', label: 'Serum bicarbonate', unit: 'mmol/L', min: 10, max: 32, relevance: 0.11 },
  { id: 'interdialyticHours', label: 'Interdialytic interval', unit: 'h', min: 24, max: 96, relevance: 0.08 },
  { id: 'ktV', label: 'Delivered spKt/V (dialysis adequacy pathway)', unit: '', min: 0.6, max: 1.8, relevance: 0.07 },
  { id: 'raasi', label: 'RAASi exposure', unit: '0/1', min: 0, max: 1, relevance: 0.05 },
];

export const NUTRITION_REFERENCE = {
  albuminFloorGDl: 3.5,
  albuminSevereGDl: 3.0,
  /** hs-CRP above this marks the inflammation pathway */
  crpInflammationMgL: 10,
  handgripLowKg: 24,
  nonHdlLowMgDl: 100,
  /** PEW requires ≥3 of the 5 markers */
  fewMarkersRequired: 3,
  /** potassium thresholds */
  potassiumHighMmolL: 6.0,
  potassiumLowMmolL: 3.5,
  /** acidosis: bicarbonate below this */
  bicarbonateLowMmolL: 22,
  /** a potassium older than this cannot justify an action without a new lab */
  potassiumLabMaxAgeHours: 12,
  /** P(K>6.0) at which the plan escalates */
  hyperkalemiaActionThreshold: 0.35,
  horizonsDays: [30, 60, 90] as const,
  /** minimum serial measurements before the pathway model runs */
  minSerialMeasurements: 2,
} as const;

/* ======================================================================
 * 2. PEW: five pathways, never averaged
 * ====================================================================== */

export type PewPathway = 'poor-intake' | 'inflammation' | 'dilution' | 'catabolism' | 'inadequate-dialysis';

export interface PewPathwayScore {
  pathway: PewPathway;
  label: string;
  /** 0–1 evidence for this pathway */
  score: number;
  /** the markers that fired, with the observed value */
  markers: Array<{ marker: string; value: number; unit: string; expected: string }>;
  /** what the pathway implies clinically */
  because: string;
}

export interface NutritionInput {
  patientId: string;
  /** serial + current nutrition markers */
  albumin?: number | undefined;
  albuminSeries?: readonly number[] | undefined;
  albuminTrend30d?: number | undefined;
  crp?: number | undefined;
  crpSeries?: readonly number[] | undefined;
  handgripKg?: number | undefined;
  nonHdlMgDl?: number | undefined;
  creatinineMgDl?: number | undefined;
  creatinineSeries?: readonly number[] | undefined;
  dryWeightDeltaKg?: number | undefined;
  /** appetite / intake / GI (from the dietitian review) */
  appetiteScore?: number | undefined; // 0 (anorexic) … 10 (normal)
  giSymptoms?: readonly string[] | undefined;
  hospitalisedLast30d?: boolean | undefined;
  /** electrolytes */
  potassium?: number | undefined;
  potassiumSeries?: readonly number[] | undefined;
  potassiumMeasuredAt?: string | undefined;
  bicarbonate?: number | undefined;
  bicarbonateSeries?: readonly number[] | undefined;
  interdialyticHours?: number | undefined;
  ktV?: number | undefined;
  raasi?: boolean | undefined;
  /** device adjunct (never a standalone trigger) */
  ecgFlags?: readonly string[] | undefined;
  asOf?: string | undefined;
}

/** The five-pathway decomposition. Every pathway is scored from its own markers. */
export function pewPathways(input: NutritionInput): PewPathwayScore[] {
  const series = input.albuminSeries ?? (input.albumin !== undefined ? [input.albumin] : []);
  const first = series[0];
  const last = series.at(-1);
  const falling = first !== undefined && last !== undefined && series.length >= 2 && last < first - 0.15;
  const crpHigh = (input.crp ?? 0) > NUTRITION_REFERENCE.crpInflammationMgL;
  const crpRising = (input.crpSeries?.length ?? 0) >= 2 && (input.crpSeries!.at(-1) ?? 0) > (input.crpSeries![0] ?? 0) * 1.2;
  const gripLow = input.handgripKg !== undefined && input.handgripKg < NUTRITION_REFERENCE.handgripLowKg;
  const nonHdlLow = input.nonHdlMgDl !== undefined && input.nonHdlMgDl < NUTRITION_REFERENCE.nonHdlLowMgDl;
  const creatinineHigh = (input.creatinineMgDl ?? 0) > 9.5;
  const dilute = (input.dryWeightDeltaKg ?? 0) > 0.8;

  const score = (v: number): number => Math.max(0, Math.min(1, Math.round(v * 100) / 100));

  const poorIntake: PewPathwayScore = {
    pathway: 'poor-intake',
    label: 'Poor intake',
    score: score(((input.appetiteScore !== undefined ? (10 - input.appetiteScore) / 10 : 0) * 0.55
      + (nonHdlLow ? 0.25 : 0)
      + (falling ? 0.2 : 0))),
    markers: [
      ...(input.appetiteScore !== undefined ? [{ marker: 'appetite', value: input.appetiteScore, unit: '/10', expected: '≥7' }] : []),
      ...(input.nonHdlMgDl !== undefined ? [{ marker: 'non-HDL cholesterol', value: input.nonHdlMgDl, unit: 'mg/dL', expected: `≥${NUTRITION_REFERENCE.nonHdlLowMgDl}` }] : []),
      ...(falling ? [{ marker: 'albumin trend', value: input.albuminTrend30d ?? 0, unit: 'g/dL/30d', expected: 'stable' }] : []),
    ],
    because: 'A falling albumin with low cholesterol and reduced intake is a nutrition-intake problem — the dietitian owns it, not the dose.',
  };

  const inflammation: PewPathwayScore = {
    pathway: 'inflammation',
    label: 'Inflammation',
    score: score(((crpHigh ? 0.7 : 0) + (crpRising ? 0.3 : 0))),
    markers: [
      ...(input.crp !== undefined ? [{ marker: 'hs-CRP', value: input.crp, unit: 'mg/L', expected: `<${NUTRITION_REFERENCE.crpInflammationMgL}` }] : []),
    ],
    because: 'Albumin is a negative acute-phase reactant: with a raised or rising CRP the albumin is reporting inflammation, and feeding will not fix it.',
  };

  const dilution: PewPathwayScore = {
    pathway: 'dilution',
    label: 'Dilution (overhydration)',
    score: score(dilute ? 0.6 + Math.min(0.4, (input.dryWeightDeltaKg! - 0.8) / 3) : 0),
    markers: [
      ...(input.dryWeightDeltaKg !== undefined ? [{ marker: 'post-dialysis weight Δ', value: input.dryWeightDeltaKg, unit: 'kg', expected: '≤0.8' }] : []),
    ],
    because: 'A rising post-dialysis weight means the measured albumin is diluted — reassess the target weight before treating the albumin.',
  };

  const catabolism: PewPathwayScore = {
    pathway: 'catabolism',
    label: 'Catabolism',
    score: score(((gripLow ? 0.5 : 0) + (input.hospitalisedLast30d ? 0.3 : 0) + ((input.giSymptoms?.length ?? 0) > 0 ? 0.2 : 0))),
    markers: [
      ...(input.handgripKg !== undefined ? [{ marker: 'handgrip', value: input.handgripKg, unit: 'kg', expected: `≥${NUTRITION_REFERENCE.handgripLowKg}` }] : []),
      ...(input.hospitalisedLast30d ? [{ marker: 'hospitalisation 30 d', value: 1, unit: 'event', expected: 'none' }] : []),
    ],
    because: 'Losing grip strength with a recent admission or GI symptoms points to muscle catabolism and loss of lean mass.',
  };

  const inadequateDialysis: PewPathwayScore = {
    pathway: 'inadequate-dialysis',
    label: 'Inadequate dialysis',
    score: score(((input.ktV !== undefined && input.ktV < 1.2 ? 0.6 : 0) + (creatinineHigh ? 0.4 : 0))),
    markers: [
      ...(input.ktV !== undefined ? [{ marker: 'spKt/V', value: input.ktV, unit: '', expected: '≥1.2' }] : []),
      ...(input.creatinineMgDl !== undefined ? [{ marker: 'predialysis creatinine', value: input.creatinineMgDl, unit: 'mg/dL', expected: '≥9.5 in PEW' }] : []),
    ],
    because: 'A low delivered dose plus a low predialysis creatinine is under-dialysis, not malnutrition — the prescription is the lever.',
  };

  return [poorIntake, inflammation, dilution, catabolism, inadequateDialysis].sort((a, b) => b.score - a.score);
}

export interface PewAssessment {
  /** the PEW composite marker count (of 5) */
  markersPresent: number;
  present: string[];
  /** true when ≥3 markers are present */
  pew: boolean;
  severity: 'none' | 'mild' | 'moderate' | 'severe';
  pathways: PewPathwayScore[];
  /** the leading pathway — the one the plan addresses first */
  dominant: PewPathway;
}

export function assessPew(input: NutritionInput): PewAssessment {
  const present: string[] = [];
  if ((input.albumin ?? 9) < NUTRITION_REFERENCE.albuminFloorGDl) present.push('low albumin');
  if ((input.albuminTrend30d ?? 0) < -0.15 || ((input.albuminSeries?.length ?? 0) >= 2 && (input.albuminSeries!.at(-1) ?? 9) < (input.albuminSeries![0] ?? 9) - 0.15)) present.push('falling albumin');
  if ((input.crp ?? 0) > NUTRITION_REFERENCE.crpInflammationMgL) present.push('raised CRP');
  if (input.handgripKg !== undefined && input.handgripKg < NUTRITION_REFERENCE.handgripLowKg) present.push('low handgrip');
  if (input.nonHdlMgDl !== undefined && input.nonHdlMgDl < NUTRITION_REFERENCE.nonHdlLowMgDl) present.push('low non-HDL cholesterol');
  const pathways = pewPathways(input);
  const pew = present.length >= NUTRITION_REFERENCE.fewMarkersRequired;
  const severity: PewAssessment['severity'] = !pew
    ? 'none'
    : (input.albumin ?? 9) < NUTRITION_REFERENCE.albuminSevereGDl ? 'severe' : present.length >= 4 ? 'moderate' : 'mild';
  return { markersPresent: present.length, present, pew, severity, pathways, dominant: pathways[0]!.pathway };
}

/* ======================================================================
 * 3. Potassium forecast + the lab-confirmation gate
 * ====================================================================== */

export interface PotassiumForecast {
  current?: number | undefined;
  /** projected pre-dialysis potassium at the next session */
  nextSession?: number | undefined;
  /** P(pre-dialysis K > 6.0) */
  probabilityAbove6?: number | undefined;
  intervalHours?: number | undefined;
  /** drivers, most important first */
  drivers: Array<{ id: string; label: string; value: number }>;
  note: string;
}

/**
 * Potassium forecast. The interdialytic interval is the dominant term (potassium
 * accumulates between sessions), with the acidosis coupling (a low bicarbonate
 * shifts potassium out of cells), the delivered dose and RAASi exposure.
 */
export function forecastPotassium(input: NutritionInput): PotassiumForecast {
  const K = input.potassium;
  if (K === undefined) {
    return { drivers: [], note: 'No pre-dialysis potassium on file — the forecast cannot run.' };
  }
  const interval = input.interdialyticHours ?? 48;
  const bicarb = input.bicarbonate ?? 22;
  const ktV = input.ktV ?? 1.3;
  const raasi = input.raasi === true ? 1 : 0;

  const intervalTerm = (interval - 48) / 24 * 0.55; // +0.55 mmol/L per extra 24 h
  const acidosisTerm = (22 - bicarb) * 0.06;
  const doseTerm = (1.2 - ktV) * 0.9;
  const raasiTerm = raasi * 0.22;
  const nextSession = Math.round((K + intervalTerm + acidosisTerm + doseTerm + raasiTerm) * 100) / 100;
  const probabilityAbove6 = Math.round((1 / (1 + Math.exp(-(nextSession - 6.0) * 2.4))) * 1000) / 1000;

  return {
    current: K,
    nextSession,
    probabilityAbove6,
    intervalHours: interval,
    drivers: [
      { id: 'interdialyticHours', label: 'Interdialytic interval', value: Math.round(intervalTerm * 100) / 100 },
      { id: 'bicarbonate', label: 'Acidosis (bicarbonate deficit)', value: Math.round(acidosisTerm * 100) / 100 },
      { id: 'ktV', label: 'Dialyser clearance deficit', value: Math.round(doseTerm * 100) / 100 },
      { id: 'raasi', label: 'RAASi exposure', value: raasiTerm },
    ].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    note: `Projected pre-dialysis potassium ${nextSession} mmol/L at the next session (${interval} h interval), P(K>6.0) ${probabilityAbove6}.`,
  };
}

/* ======================================================================
 * 4. Guardrails — emergency vs routine, and the lab gate
 * ====================================================================== */

export type NutritionGuardFlag =
  | 'no-serial-measurements'
  | 'no-albumin'
  | 'no-potassium'
  | 'potassium-lab-stale'
  | 'ecg-adjunct-only'
  | 'gi-red-flag'
  | 'pathway-not-determined'
  | 'dialysis-dose-first'
  | 'inflammation-first'
  | 'within-range';

export interface NutritionGuardInput extends NutritionInput {
  gastrointestinalBleeding?: boolean | undefined;
  severeAnorexia?: boolean | undefined;
}

export interface NutritionGuardResult {
  flags: NutritionGuardFlag[];
  blocked: boolean;
  blockReason: string | null;
  /** an urgent, ED-level action is justified (hyperkalaemia with a confirmed lab) */
  emergency: boolean;
  /** the action requires a fresh confirmatory lab before it is enacted */
  requiresLabConfirmation: boolean;
  /** the ECG contribution is an adjunct and can never stand alone */
  ecgAdjunctOnly: boolean;
}

export function guardNutritionPlan(input: NutritionGuardInput): NutritionGuardResult {
  const flags: NutritionGuardFlag[] = [];
  const serial = Math.max(
    input.albuminSeries?.length ?? 0,
    input.potassiumSeries?.length ?? 0,
    input.creatinineSeries?.length ?? 0,
    input.crpSeries?.length ?? 0,
  );
  if (serial < NUTRITION_REFERENCE.minSerialMeasurements) flags.push('no-serial-measurements');
  if (input.albumin === undefined) flags.push('no-albumin');
  if (input.potassium === undefined) flags.push('no-potassium');

  const labAgeHours = input.potassiumMeasuredAt && input.asOf
    ? (Date.parse(input.asOf) - Date.parse(input.potassiumMeasuredAt)) / 3_600_000
    : undefined;
  if (input.potassium !== undefined && (labAgeHours === undefined || labAgeHours > NUTRITION_REFERENCE.potassiumLabMaxAgeHours)) {
    flags.push('potassium-lab-stale');
  }
  if ((input.ecgFlags?.length ?? 0) > 0) flags.push('ecg-adjunct-only');

  if (input.gastrointestinalBleeding === true) flags.push('gi-red-flag');
  if (input.severeAnorexia === true) flags.push('severe-anorexia' as NutritionGuardFlag);

  const assessment = assessPew(input);
  if (!assessment.pew && ((input.albumin ?? 9) < NUTRITION_REFERENCE.albuminFloorGDl || (input.crp ?? 0) > NUTRITION_REFERENCE.crpInflammationMgL)) {
    flags.push('pathway-not-determined');
  }
  if (input.ktV !== undefined && input.ktV < 1.2) flags.push('dialysis-dose-first');
  if ((input.crp ?? 0) > NUTRITION_REFERENCE.crpInflammationMgL) flags.push('inflammation-first');

  const hyperkalemic = (input.potassium ?? 0) > NUTRITION_REFERENCE.potassiumHighMmolL;
  const forecast = forecastPotassium(input);
  const predictedHigh = (forecast.probabilityAbove6 ?? 0) >= NUTRITION_REFERENCE.hyperkalemiaActionThreshold;
  if (!hyperkalemic && !predictedHigh && (input.bicarbonate ?? 22) >= NUTRITION_REFERENCE.bicarbonateLowMmolL && !assessment.pew) flags.push('within-range');

  const blocked = flags.includes('no-serial-measurements');
  const emergency = hyperkalemic || predictedHigh;
  // A potassium action always needs a CURRENT lab; an ECG pattern never removes that.
  const requiresLabConfirmation = emergency;
  const ecgAdjunctOnly = (input.ecgFlags?.length ?? 0) > 0;

  const blockReason = !blocked
    ? null
    : `Fewer than ${NUTRITION_REFERENCE.minSerialMeasurements} serial measurements — the pathway decomposition and the potassium forecast both need a series.`;

  return { flags, blocked, blockReason, emergency, requiresLabConfirmation, ecgAdjunctOnly };
}

/* ======================================================================
 * 5. Deterministic 2-D latent — nutrition deficit × electrolyte risk
 * ====================================================================== */

export function nutritionLatent(input: NutritionInput): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  const assessment = assessPew(input);
  const forecast = forecastPotassium(input);
  // Axis 1 — nutrition deficit (0 = no PEW markers, 1 = all five)
  const deficit = Math.min(1, assessment.markersPresent / 5);
  // Axis 2 — electrolyte risk as a MAGNITUDE: hyperkalaemia, hypokalaemia, the
  // projected next-session potassium and acidosis, whichever is worst.
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const high = input.potassium !== undefined ? clamp01((input.potassium - NUTRITION_REFERENCE.potassiumHighMmolL) / 2) : 0;
  const low = input.potassium !== undefined ? clamp01((NUTRITION_REFERENCE.potassiumLowMmolL - input.potassium) / 1.5) : 0;
  const projected = forecast.nextSession !== undefined ? clamp01((forecast.nextSession - NUTRITION_REFERENCE.potassiumHighMmolL) / 2) : 0;
  const acidosis = clamp01((NUTRITION_REFERENCE.bicarbonateLowMmolL - (input.bicarbonate ?? NUTRITION_REFERENCE.bicarbonateLowMmolL)) / 6);
  const electrolyteRisk = Math.max(high, low, projected, acidosis);
  const l1 = clamp01(deficit);
  const l2 = clamp01(electrolyteRisk);
  return { l1, l2, polarRadius: Math.hypot(l1, l2), polarAngleRad: Math.atan2(l2, l1) };
}

/* ======================================================================
 * 6. Reference surrogate — bounded recommendation
 * ====================================================================== */

export type NutritionAction =
  | 'dietitian-referral'
  | 'oral-nutrition-supplement'
  | 'dialysis-dose-review'
  | 'inflammation-review'
  | 'target-weight-reassessment'
  | 'k-binder-plan'
  | 'diet-potassium-education'
  | 'raasi-review'
  | 'alkali-review'
  | 'urgent-lab-confirmation'
  | 'ed-triage'
  | 'continue'
  | 'blocked';

export interface NutritionRecommendation {
  patientId: string;
  guardrails: NutritionGuardResult;
  latent: ReturnType<typeof nutritionLatent>;
  pew: PewAssessment;
  potassium: PotassiumForecast;
  current: { albumin?: number | undefined; crp?: number | undefined; handgripKg?: number | undefined; potassium?: number | undefined; bicarbonate?: number | undefined; ktV?: number | undefined };
  action: NutritionAction;
  /** secondary actions, ordered — the plan is rarely a single lever */
  plan: NutritionAction[];
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: 'reference-surrogate' | 'trained' };
  synthetic: boolean;
  /** the safety contract on any potassium action */
  safety: { requiresLabConfirmation: boolean; ecgAdjunctOnly: boolean; emergency: boolean };
  note: string;
}

export const NUTRITION_ADVISOR_MODEL = { id: 'nutrition.pew-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

export function nutritionRecommend(input: NutritionGuardInput): NutritionRecommendation {
  const guardrails = guardNutritionPlan(input);
  const latent = nutritionLatent(input);
  const pew = assessPew(input);
  const potassium = forecastPotassium(input);

  const plan: NutritionAction[] = [];
  let action: NutritionAction = 'continue';
  let note = '';

  if (guardrails.blocked) {
    action = 'blocked';
    note = guardrails.blockReason ?? 'Blocked by guardrails.';
  } else {
    // --- emergency first: hyperkalaemia is the only time-critical pathway ---
    if (guardrails.emergency) {
      const confirmed = input.potassium !== undefined && !guardrails.flags.includes('potassium-lab-stale');
      if ((input.potassium ?? 0) >= 6.5 && confirmed) {
        action = 'ed-triage';
        note = `Potassium ${input.potassium} mmol/L with a current lab — emergency pathway: ECG now and ED/urgent dialysis triage. This is a rule, not a model output.`;
      } else if (confirmed) {
        action = 'urgent-lab-confirmation';
        note = `Projected potassium ${potassium.nextSession} mmol/L (P(K>6.0) ${potassium.probabilityAbove6}) — confirm with a fresh potassium BEFORE any potassium-lowering action; the ECG pattern alone never triggers one.`;
      } else {
        action = 'urgent-lab-confirmation';
        note = `Potassium risk is elevated but the last value is stale (no lab within ${NUTRITION_REFERENCE.potassiumLabMaxAgeHours} h) — get a confirmatory potassium; an ECG pattern is an adjunct and cannot stand alone.`;
      }
      plan.push(action, 'k-binder-plan', 'diet-potassium-education');
    }

    // --- then the pathway-specific nutrition plan ---
    if (action === 'continue') {
      if (pew.pew) {
        switch (pew.dominant) {
          case 'inadequate-dialysis':
            action = 'dialysis-dose-review';
            note = `PEW with a delivered spKt/V of ${input.ktV ?? '—'} and creatinine ${input.creatinineMgDl ?? '—'} mg/dL — the dominant pathway is under-dialysis; reviewing the prescription comes before nutrition support.`;
            break;
          case 'inflammation':
            action = 'inflammation-review';
            note = `PEW with hs-CRP ${input.crp} mg/L — the dominant pathway is inflammation; albumin is a negative acute-phase reactant here, so look for the source (access, infection, volume) rather than feeding it.`;
            break;
          case 'dilution':
            action = 'target-weight-reassessment';
            note = `PEW with a ${input.dryWeightDeltaKg} kg post-dialysis weight rise — reassess the target weight; the albumin is likely diluted rather than low.`;
            break;
          case 'catabolism':
            action = 'oral-nutrition-supplement';
            note = `PEW with low handgrip (${input.handgripKg ?? '—'} kg) — loss of lean mass; dietitian-led oral nutrition support plus resistance review.`;
            break;
          default:
            action = 'dietitian-referral';
            note = `PEW with reduced intake (appetite ${input.appetiteScore ?? '—'}/10, non-HDL ${input.nonHdlMgDl ?? '—'} mg/dL) — dietitian referral is the first lever.`;
        }
        plan.push('dietitian-referral');
      } else if ((input.bicarbonate ?? 22) < NUTRITION_REFERENCE.bicarbonateLowMmolL) {
        action = 'alkali-review';
        note = `Bicarbonate ${input.bicarbonate} mmol/L — metabolic acidosis; review alkali therapy (and it is also driving the potassium upward).`;
      } else if (input.raasi === true && (input.potassium ?? 4) > 5.3) {
        action = 'raasi-review';
        note = `Potassium ${input.potassium} mmol/L on a RAASi — review the RAASi dose before adding a potassium binder.`;
      } else {
        action = 'continue';
        note = pew.markersPresent > 0
          ? `Nutrition markers present (${pew.present.join(', ')}) but below the PEW threshold — continue current care and re-measure.`
          : 'Nutrition and electrolytes are within range — continue routine monitoring.';
      }
    } else {
      plan.push('diet-potassium-education');
    }
  }

  return {
    patientId: input.patientId,
    guardrails,
    latent,
    pew,
    potassium,
    current: {
      albumin: input.albumin,
      crp: input.crp,
      handgripKg: input.handgripKg,
      potassium: input.potassium,
      bicarbonate: input.bicarbonate,
      ktV: input.ktV,
    },
    action,
    plan: [...new Set(plan)],
    drivers: NUTRITION_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance })).sort((a, b) => b.relevance - a.relevance),
    model: NUTRITION_ADVISOR_MODEL,
    synthetic: true,
    safety: {
      requiresLabConfirmation: guardrails.requiresLabConfirmation,
      ecgAdjunctOnly: guardrails.ecgAdjunctOnly,
      emergency: guardrails.emergency,
    },
    note,
  };
}

/* ======================================================================
 * 7. Bounded cells + durable episodes
 * ====================================================================== */

export const NUTRITION_CELLS: CellManifest[] = [
  {
    id: 'nutrition-pew-advisor',
    version: '0.1.0',
    displayName: 'PEW nutrition advisor',
    domain: 'patient-care',
    owner: 'Dietetics · renal',
    consumes: ['lab.result-arrived', 'assessment.response.v1', 'session.ended.v1'],
    produces: ['nutrition.pew.proposal'],
    allowedActions: ['order-lab', 'update-care-plan', 'schedule-followup', 'notify-staff'],
    approvalClass: 'C',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.6 · five-pathway PEW decomposition (XGBoost + SHAP)',
  },
  {
    id: 'electrolyte-safety-watch',
    version: '0.1.0',
    displayName: 'Electrolyte safety watch',
    domain: 'quality',
    owner: 'Nursing · dialysis unit',
    consumes: ['lab.result-arrived', 'safety.flagged'],
    produces: ['electrolyte.k.flag'],
    allowedActions: ['notify-staff', 'flag-safety-event', 'order-lab', 'update-care-plan'],
    approvalClass: 'B',
    evalGate: 0.85,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.6 · potassium forecast + mandatory lab confirmation',
  },
];

export const NUTRITION_CONSUMED_BY: Record<string, string[]> = {
  'nutrition.pew.proposal': ['nutrition-pew-advisor', 'electrolyte-safety-watch'],
  'electrolyte.k.flag': ['electrolyte-safety-watch'],
};

export const NUTRITION_EPISODE_KINDS = ['nutrition.pew-response'] as const;

export interface NutritionDemoState {
  source: 'nutrition';
  features: readonly NutritionFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  kpis: { pewRatePct: number; hyperkalemiaRatePct: number; acidosisRatePct: number; dietitianReferrals: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

export function buildNutritionDemo(now: () => string = NOW): Omit<NutritionDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'nutrition-pew-advisor', kind: 'nutrition.pew.proposal', subject: 'patient:p-pew-1', scopeType: 'patient',
      option: 'dietitian referral for poor intake', approvalClass: 'C',
      recommendation: 'Patient p-pew-1: albumin 3.2 g/dL falling, appetite 3/10, non-HDL 88 mg/dL, CRP 4 mg/L, handgrip 22 kg — the dominant pathway is POOR INTAKE (not inflammation: CRP is 4), so the lever is dietitian-led nutrition support, not a dose change. Class C review.',
      allowed: true, evidence: [ev('lab.result-arrived:p-pew-1', 'fact'), ev('assessment.response.v1:p-pew-1', 'fact')],
      producedAt: now(), payload: { dominant: 'poor-intake', markers: 4 },
    }),
    makeProposal({
      cellId: 'electrolyte-safety-watch', kind: 'electrolyte.k.flag', subject: 'patient:p-pew-2', scopeType: 'patient',
      option: 'confirm the potassium before acting', approvalClass: 'B',
      recommendation: 'Patient p-pew-2: potassium 5.7 mmol/L at an 72 h interval projects to 6.3 mmol/L (P(K>6.0) 0.68). Device flagged a peaked-T pattern, but an ECG pattern is an adjunct: obtain a confirmatory potassium first, then act. Nursing review.',
      allowed: true, evidence: [ev('lab.result-arrived:p-pew-2', 'fact'), ev('safety.flagged:p-pew-2', 'fact')],
      producedAt: now(), payload: { projected: 6.3, ecgAdjunctOnly: true },
    }),
  ];
  const insights = aggregateSwarmInsights({ proposals, consumedBy: NUTRITION_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;
  const candidates: NbaCandidate[] = [
    {
      title: 'Dietitian referral for p-pew-1 (poor-intake pathway, albumin 3.2)', cells: ['nutrition-pew-advisor'],
      scopeType: 'patient', subject: 'patient:p-pew-1', owner: 'Dietetics · renal', due: 'This week',
      evidence: [ev('lab.result-arrived:p-pew-1', 'fact')],
      action: { kind: 'update-care-plan', target: 'patient:p-pew-1' },
      valueUnit: 'dollars',
      consensus: 0.9, approvalClass: 'C', expectedOutcome: 22000, urgency: 0.6, policyCost: 0.3, risk: 0.25,
      insightKind: 'nutrition.pew.proposal',
    },
    {
      title: 'Confirm potassium for p-pew-2 (projected 6.3 mmol/L, ECG adjunct)', cells: ['electrolyte-safety-watch'],
      scopeType: 'patient', subject: 'patient:p-pew-2', owner: 'Nursing · dialysis unit', due: 'Now',
      evidence: [ev('lab.result-arrived:p-pew-2', 'fact')],
      action: { kind: 'order-lab', target: 'patient:p-pew-2' },
      valueUnit: 'dollars',
      consensus: 0.88, approvalClass: 'B', expectedOutcome: 31000, urgency: 0.9, policyCost: 0.15, risk: 0.3,
      insightKind: 'electrolyte.k.flag',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true, allowlist: cellAllowlist(NUTRITION_CELLS) });
  return {
    source: 'nutrition',
    features: NUTRITION_FEATURES,
    cells: NUTRITION_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { pewRatePct: 34, hyperkalemiaRatePct: 12, acidosisRatePct: 26, dietitianReferrals: 18 },
  };
}

export function nutritionEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (NUTRITION_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/** Seed: one Class C PEW proposal awaiting approval + one closed Class B electrolyte loop. */
export async function seedNutritionEpisodes(
  coordinator: PersistentOutcomeCoordinator,
  _ws?: SwarmWorkspaceStore,
  now: () => string = NOW,
): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const find = (subject: string): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === 'nutrition.pew-response' && e.subject === subject && e.scopeType === 'patient');

  const p1 = find('patient:p-pew-1');
  if (!p1) {
    const rec = nutritionRecommend({
      patientId: 'p-pew-1', albumin: 3.2, albuminSeries: [3.6, 3.4, 3.2], albuminTrend30d: -0.4,
      crp: 4, crpSeries: [3, 4], handgripKg: 22, nonHdlMgDl: 88, creatinineMgDl: 10.4,
      appetiteScore: 3, giSymptoms: [], dryWeightDeltaKg: 0.2, potassium: 4.6, bicarbonate: 23,
      interdialyticHours: 48, ktV: 1.35, raasi: false, asOf: now(),
    });
    const e = coordinator.open({ kind: 'nutrition.pew-response', subject: 'patient:p-pew-1', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:p-pew-1', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'nutrition-pew-advisor', kind: 'nutrition.pew.proposal', subject: e.subject, scopeType: 'patient',
      option: rec.action, approvalClass: 'C',
      recommendation: rec.note, allowed: true, evidence: [ev('lab.result-arrived:p-pew-1', 'fact')],
      producedAt: now(), payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(p1.episodeId);
  }

  const p2 = find('patient:p-pew-2');
  if (!p2) {
    const e = coordinator.open({ kind: 'nutrition.pew-response', subject: 'patient:p-pew-2', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:p-pew-2', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'electrolyte-safety-watch', kind: 'electrolyte.k.flag', subject: e.subject, scopeType: 'patient',
      option: 'confirm the potassium before acting', approvalClass: 'B',
      recommendation: 'Potassium 5.7 mmol/L at a 72 h interval projects to 6.3 mmol/L; a device ECG pattern is an adjunct — obtain a confirmatory potassium first.',
      allowed: true, evidence: [ev('lab.result-arrived:p-pew-2', 'fact')], producedAt: now(), payload: { projected: 6.3 },
    }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Nurse lead', 'B');
    coordinator.dispatchCommand(e.episodeId, 'order-lab');
    coordinator.acknowledge(e.episodeId, 'patient:p-pew-2');
    coordinator.verify(e.episodeId, { measureId: 'electrolyte.k-confirmed', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(p2.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY nutrition episodes. */
export async function dropNutritionEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = nutritionEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

export const NUTRITION_REFERENCE_SUMMARY = {
  targets: {
    albuminFloorGDl: NUTRITION_REFERENCE.albuminFloorGDl,
    crpInflammationMgL: NUTRITION_REFERENCE.crpInflammationMgL,
    handgripLowKg: NUTRITION_REFERENCE.handgripLowKg,
    nonHdlLowMgDl: NUTRITION_REFERENCE.nonHdlLowMgDl,
    bicarbonateLowMmolL: NUTRITION_REFERENCE.bicarbonateLowMmolL,
  },
  potassium: {
    highMmolL: NUTRITION_REFERENCE.potassiumHighMmolL,
    actionThreshold: NUTRITION_REFERENCE.hyperkalemiaActionThreshold,
    labMaxAgeHours: NUTRITION_REFERENCE.potassiumLabMaxAgeHours,
  },
  horizonsDays: NUTRITION_REFERENCE.horizonsDays,
} as const;
