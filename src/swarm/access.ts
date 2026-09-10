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

// P3 — vascular access protocol pack (steps A–F).
//
//  1. Feature contract — the longitudinal pressure/flow/recirculation signals
//     (the LEGAL, no-audio path) plus one optional fused acoustic delta score.
//  2. Guardrails      — what must block a referral, and what must never happen.
//  3. Latent          — deterministic 2-D stenosis progression × vulnerability.
//  4. Reference surrogate — mechanistic stenosis/thrombosis probabilities and a
//     bounded recommendation (surveillance, cannulation change, referral).
//
// The published mel-spectrogram CNN results (ResNet50 AUROC 0.99 / EfficientNetB5
// 0.98) are BENCHMARKS, not results of this system. Our contract is the strategy
// document's: longitudinal-only AUROC ≥ 0.80 on synthetic data, audio path gated
// and clearly labelled synthetic, referral always human-approved.
//
// CDSS only: the platform never books a procedure, never removes a catheter and
// never alters an access. Referrals are proposals for a human decision.

import type { CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';

/* ======================================================================
 * 1. Feature contract (bounds + prior relevance)
 * ====================================================================== */

export interface AccessFeature {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** documented first-order relevance (Δ-from-baseline terms dominate) */
  relevance: number;
}

export const ACCESS_FEATURES: readonly AccessFeature[] = [
  { id: 'venousPressureDeltaPct', label: 'Venous pressure change vs patient baseline', unit: '%', min: -50, max: 150, relevance: 0.21 },
  { id: 'recirculationPct', label: 'Access recirculation', unit: '%', min: 0, max: 40, relevance: 0.17 },
  { id: 'accessFlowDeltaPct', label: 'Access flow (Qa) change vs baseline', unit: '%', min: -70, max: 40, relevance: 0.14 },
  { id: 'venousPressureMmHg', label: 'Venous pressure', unit: 'mmHg', min: 60, max: 320, relevance: 0.10 },
  { id: 'deliveredClearanceDeltaPct', label: 'Delivered clearance change vs baseline', unit: '%', min: -40, max: 20, relevance: 0.09 },
  { id: 'accessAgeDays', label: 'Access age', unit: 'days', min: 0, max: 2500, relevance: 0.07 },
  { id: 'cannulationDifficulty', label: 'Cannulation difficulty', unit: 'score', min: 0, max: 2, relevance: 0.06 },
  { id: 'accessType', label: 'Access type (AVF/AVG/catheter)', unit: 'code', min: 0, max: 2, relevance: 0.06 },
  { id: 'priorInterventions', label: 'Prior access interventions', unit: 'count', min: 0, max: 6, relevance: 0.05 },
  { id: 'daysSinceIntervention', label: 'Days since last intervention', unit: 'days', min: 0, max: 365, relevance: 0.03 },
  { id: 'acousticDeltaScore', label: 'Acoustic Δ from patient baseline (gated)', unit: 'score', min: 0, max: 1, relevance: 0.02 },
];

/** Reference bounds that drive the flags and the referral decision. */
export const ACCESS_REFERENCE = {
  /** venous pressure ≥25% above the patient's own baseline is a surveillance trigger */
  venousPressureRisePct: 25,
  /** access recirculation above this is abnormal for an AVF/AVG */
  recirculationFlagPct: 10,
  /** minimum acceptable access flow (Qa) for a usable fistula */
  accessFlowFloorMlMin: 600,
  /** access flow decline vs baseline that alone justifies imaging */
  accessFlowDeclinePct: 25,
  /** stenosis probability at which a duplex referral is advised */
  stenosisReferralThreshold: 0.5,
  /** thrombosis horizons, days */
  thrombosisHorizonsDays: [30, 90] as const,
  /** minimum observations (with measurements) before a referral can be advised */
  minObservationsForReferral: 3,
  /** post-intervention quiet window — no routine re-referral inside this many days */
  postInterventionQuietDays: 14,
} as const;

/* ======================================================================
 * 2. Guardrails
 * ====================================================================== */

export type AccessGuardFlag =
  | 'no-access-observations'
  | 'single-reading-no-trend'
  | 'no-flow-measurement'
  | 'post-intervention-quiet-window'
  | 'active-bleeding-escalate'
  | 'catheter-in-situ'
  | 'catheter-removal-candidate'
  | 'recirculation-technique-first'
  | 'within-normal-range'
  | 'acoustic-flag-disabled'
  | 'acoustic-unlabelled-ignored';

export interface AccessGuardInput {
  /** access state */
  accessType?: 'avf' | 'avg' | 'catheter' | undefined;
  accessAgeDays?: number | undefined;
  site?: string | undefined;
  /** longitudinal measurements */
  observations?: number | undefined;
  venousPressureMmHg?: number | undefined;
  venousPressureBaselineMmHg?: number | undefined;
  venousPressureDeltaPct?: number | undefined;
  recirculationPct?: number | undefined;
  accessFlowMlMin?: number | undefined;
  accessFlowBaselineMlMin?: number | undefined;
  deliveredClearancePct?: number | undefined;
  deliveredClearanceBaselinePct?: number | undefined;
  cannulationDifficulty?: 'easy' | 'moderate' | 'difficult' | undefined;
  /** history */
  priorInterventions?: number | undefined;
  daysSinceIntervention?: number | undefined;
  /** clinical context */
  activeBleeding?: boolean | undefined;
  catheterDays?: number | undefined;
  /** gated acoustic signal */
  acousticDeltaScore?: number | undefined;
  acousticProvenance?: string | undefined;
  acousticSynthetic?: boolean | undefined;
  acousticEnabled?: boolean | undefined;
  asOf?: string | undefined;
}

export interface AccessGuardResult {
  flags: AccessGuardFlag[];
  blocked: boolean;
  blockReason: string | null;
  /** a duplex ultrasound / fistulogram referral may be proposed */
  referralAllowed: boolean;
  /** escalate now, outside the usual referral path (bleeding, threatened access) */
  escalateNow: boolean;
  venousPressureDeltaPct?: number | undefined;
  accessFlowDeltaPct?: number | undefined;
}

const pctChange = (current: number | undefined, baseline: number | undefined): number | undefined =>
  current !== undefined && baseline !== undefined && baseline !== 0
    ? Math.round(((current - baseline) / Math.abs(baseline)) * 1000) / 10
    : undefined;

/**
 * Patient-relative baseline for the Δ terms: the median of the first `n`
 * measured values. Using the median of the first few observations (rather than a
 * single reading) keeps the baseline stable when the first measurement is noisy,
 * and it is the ONE rule both the live advisor windows and the twin use.
 */
export function accessBaseline(values: readonly number[], n = 3): number | undefined {
  const head = values.slice(0, Math.max(1, Math.min(n, values.length))).filter((v) => Number.isFinite(v));
  if (!head.length) return undefined;
  const sorted = [...head].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function guardAccessReferral(input: AccessGuardInput): AccessGuardResult {
  const flags: AccessGuardFlag[] = [];
  const catheter = input.accessType === 'catheter';
  const venousPressureDeltaPct = input.venousPressureDeltaPct ?? pctChange(input.venousPressureMmHg, input.venousPressureBaselineMmHg);
  const accessFlowDeltaPct = pctChange(input.accessFlowMlMin, input.accessFlowBaselineMlMin);
  const clearanceDeltaPct = pctChange(input.deliveredClearancePct, input.deliveredClearanceBaselinePct);

  const observations = input.observations ?? 0;
  const measured = observations > 0;
  if (!measured) flags.push('no-access-observations');
  else if (observations < ACCESS_REFERENCE.minObservationsForReferral) flags.push('single-reading-no-trend');
  if (measured && input.accessFlowMlMin === undefined && venousPressureDeltaPct === undefined) flags.push('no-flow-measurement');

  if (catheter) {
    flags.push('catheter-in-situ');
    if ((input.catheterDays ?? 0) >= 90) flags.push('catheter-removal-candidate');
  }
  if (input.daysSinceIntervention !== undefined && input.daysSinceIntervention < ACCESS_REFERENCE.postInterventionQuietDays) {
    flags.push('post-intervention-quiet-window');
  }
  if (input.activeBleeding === true) flags.push('active-bleeding-escalate');
  if (!catheter && (input.recirculationPct ?? 0) > ACCESS_REFERENCE.recirculationFlagPct) flags.push('recirculation-technique-first');

  const risingPressure = venousPressureDeltaPct !== undefined && venousPressureDeltaPct >= ACCESS_REFERENCE.venousPressureRisePct;
  const fallingFlow = accessFlowDeltaPct !== undefined && accessFlowDeltaPct <= -ACCESS_REFERENCE.accessFlowDeclinePct;
  const lowFlow = input.accessFlowMlMin !== undefined && input.accessFlowMlMin < ACCESS_REFERENCE.accessFlowFloorMlMin;
  const highRecirc = !catheter && (input.recirculationPct ?? 0) > ACCESS_REFERENCE.recirculationFlagPct;
  const fallingClearance = clearanceDeltaPct !== undefined && clearanceDeltaPct <= -10;
  if (!risingPressure && !fallingFlow && !lowFlow && !highRecirc && !fallingClearance) flags.push('within-normal-range');

  // The acoustic path: never used unless the deployment flag is on AND the
  // capture is labelled synthetic with provenance. Anything else is ignored.
  if (input.acousticDeltaScore !== undefined) {
    if (input.acousticEnabled !== true) flags.push('acoustic-flag-disabled');
    else if (!input.acousticProvenance || input.acousticSynthetic !== true) flags.push('acoustic-unlabelled-ignored');
  }

  const blocked = flags.includes('no-access-observations') || flags.includes('single-reading-no-trend') || flags.includes('no-flow-measurement');
  const escalateNow = flags.includes('active-bleeding-escalate');
  const referralAllowed = !blocked
    && !catheter
    && !flags.includes('post-intervention-quiet-window')
    && !flags.includes('within-normal-range')
    && (risingPressure || fallingFlow || lowFlow || fallingClearance);
  const blockReason = !blocked
    ? null
    : flags.includes('no-access-observations')
      ? 'No access surveillance observations — the access model cannot score an access it cannot see.'
      : flags.includes('single-reading-no-trend')
        ? `Fewer than ${ACCESS_REFERENCE.minObservationsForReferral} measured observations — a single reading is not a trend (surveillance first).`
        : 'No pressure or flow measurement in the series — a referral needs a measurable deterioration.';

  return {
    flags,
    blocked,
    blockReason,
    referralAllowed,
    escalateNow,
    ...(venousPressureDeltaPct !== undefined ? { venousPressureDeltaPct } : {}),
    ...(accessFlowDeltaPct !== undefined ? { accessFlowDeltaPct } : {}),
  };
}

/* ======================================================================
 * 3. Deterministic 2-D latent — stenosis progression × vulnerability
 * ====================================================================== */

export function accessLatent(input: AccessGuardInput): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  const f = (id: string): AccessFeature => ACCESS_FEATURES.find((x) => x.id === id)!;
  const norm = (v: number, feature: AccessFeature): number =>
    Math.max(-1, Math.min(1, ((v - feature.min) / (feature.max - feature.min)) * 2 - 1));
  const pressureRise = input.venousPressureDeltaPct
    ?? pctChange(input.venousPressureMmHg, input.venousPressureBaselineMmHg) ?? 0;
  const flowDelta = pctChange(input.accessFlowMlMin, input.accessFlowBaselineMlMin) ?? 0;
  // Axis 1 — stenosis progression (higher = more progressed).
  const progression = norm(pressureRise, f('venousPressureDeltaPct')) * 0.4
    + norm(input.recirculationPct ?? 0, f('recirculationPct')) * 0.35
    + norm(-flowDelta, { ...f('accessFlowDeltaPct'), min: -40, max: 70 }) * 0.25;
  // Axis 2 — vulnerability (age, prior interventions, catheter, cannulation injury).
  const difficultyCode = input.cannulationDifficulty === 'difficult' ? 2 : input.cannulationDifficulty === 'moderate' ? 1 : 0;
  const vulnerability = norm(input.accessAgeDays ?? 0, f('accessAgeDays')) * 0.3
    + norm(input.priorInterventions ?? 0, f('priorInterventions')) * 0.3
    + (input.accessType === 'catheter' ? 0.2 : input.accessType === 'avg' ? 0.05 : 0)
    + norm(difficultyCode, f('cannulationDifficulty')) * 0.2;
  const l1 = Math.max(-1, Math.min(1, progression));
  const l2 = Math.max(-1, Math.min(1, vulnerability * 2 - 1));
  return {
    l1,
    l2,
    polarRadius: Math.hypot(l1, l2),
    polarAngleRad: Math.atan2(l2, l1),
  };
}

/* ======================================================================
 * 4. Reference surrogate — stenosis / thrombosis probabilities + advice
 * ====================================================================== */

export type AccessAction =
  | 'refer-duplex-ultrasound'
  | 'access-team-review'
  | 'change-cannulation-technique'
  | 'increase-surveillance'
  | 'escalate-now'
  | 'catheter-removal-escalation'
  | 'no-action'
  | 'blocked';

export interface AccessRecommendation {
  patientId: string;
  guardrails: AccessGuardResult;
  latent: ReturnType<typeof accessLatent>;
  current: {
    accessType?: string | undefined;
    accessAgeDays?: number | undefined;
    observations: number;
    venousPressureMmHg?: number | undefined;
    venousPressureDeltaPct?: number | undefined;
    recirculationPct?: number | undefined;
    accessFlowMlMin?: number | undefined;
    accessFlowDeltaPct?: number | undefined;
    deliveredClearancePct?: number | undefined;
    cannulationDifficulty?: string | undefined;
    daysSinceIntervention?: number | undefined;
  };
  /** P(≥50% stenosis) from the mechanistic prior */
  stenosisProbability: number;
  /** P(thrombosis) at 30 / 90 days */
  thrombosisRiskByHorizon: Record<number, number>;
  action: AccessAction;
  recommended: {
    surveillanceIntervalDays?: number | undefined;
    /** stenosis probability the model projects for this access */
    projectedStenosisProbability?: number | undefined;
    projectedThrombosisRisk30d?: number | undefined;
  };
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: 'reference-surrogate' | 'trained' };
  synthetic: boolean;
  note: string;
}

export const ACCESS_ADVISOR_MODEL = { id: 'access.stenosis-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Mechanistic P(≥50% stenosis). Monotone in the venous-pressure rise, the
 * recirculation and the access-flow decline; the access age and prior
 * interventions add vulnerability. Every coefficient is documented.
 */
export function stenosisProbability(input: AccessGuardInput): number {
  const pressureRise = input.venousPressureDeltaPct
    ?? pctChange(input.venousPressureMmHg, input.venousPressureBaselineMmHg) ?? 0;
  const flowDelta = pctChange(input.accessFlowMlMin, input.accessFlowBaselineMlMin) ?? 0;
  const catheter = input.accessType === 'catheter';
  const z =
    -2.05
    + 0.055 * Math.max(0, pressureRise - 8)
    + 0.16 * Math.max(0, (input.recirculationPct ?? 0) - 4)
    + 0.05 * Math.max(0, -flowDelta - 10)
    + 0.0007 * Math.max(0, (input.accessAgeDays ?? 0) - 365)
    + 0.35 * (input.priorInterventions ?? 0)
    + 0.45 * (input.cannulationDifficulty === 'difficult' ? 1 : 0)
    + (catheter ? -1.4 : 0);
  return round3(1 / (1 + Math.exp(-z)));
}

/**
 * P(thrombosis) within `horizonDays`. The stenosis probability is the driver; a
 * caller that has already projected the stenosis (the surveillance simulator)
 * passes it explicitly instead of round-tripping through a synthetic window.
 */
export function thrombosisRisk(input: AccessGuardInput, horizonDays: number, stenosisOverride?: number): number {
  const stenosis = stenosisOverride ?? stenosisProbability(input);
  const catheter = input.accessType === 'catheter';
  const flow = input.accessFlowMlMin ?? 900;
  // a functioning access with good flow rarely thromboses; a low-flow stenotic
  // access does. The horizon scales the hazard (30 d ≪ 90 d).
  const hazard = Math.max(0.005, stenosis ** 2.1) * (catheter ? 0.35 : 1) * (flow < ACCESS_REFERENCE.accessFlowFloorMlMin ? 1.6 : 1);
  const horizonScale = Math.min(1.6, horizonDays / 60);
  return round3(Math.min(0.9, hazard * horizonScale));
}

export function accessRecommend(input: AccessGuardInput & { patientId: string }): AccessRecommendation {
  const guardrails = guardAccessReferral(input);
  const latent = accessLatent(input);
  const stenosis = stenosisProbability(input);
  const thrombosisRiskByHorizon: Record<number, number> = {};
  for (const days of ACCESS_REFERENCE.thrombosisHorizonsDays) thrombosisRiskByHorizon[days] = thrombosisRisk(input, days);

  let action: AccessAction = 'no-action';
  let surveillanceIntervalDays: number | undefined;
  let note: string;

  if (guardrails.escalateNow) {
    action = 'escalate-now';
    note = 'Active bleeding from the access — escalate to the access team now (this is a rule, not a model output).';
  } else if (guardrails.flags.includes('catheter-removal-candidate')) {
    action = 'catheter-removal-escalation';
    note = `Catheter in situ for ${input.catheterDays ?? '—'} days — catheter-removal escalation (deterministic CDC-style rule; no model output).`;
  } else if (guardrails.blocked) {
    action = 'blocked';
    note = guardrails.blockReason ?? 'Blocked by guardrails.';
  } else if (guardrails.flags.includes('post-intervention-quiet-window')) {
    action = 'increase-surveillance';
    surveillanceIntervalDays = 14;
    note = `Intervention ${Math.round(input.daysSinceIntervention ?? 0)} days ago — inside the 14-day post-intervention window. Intensify surveillance; do not re-refer on the pre-intervention trend.`;
  } else if (stenosis >= ACCESS_REFERENCE.stenosisReferralThreshold && guardrails.referralAllowed) {
    action = 'refer-duplex-ultrasound';
    surveillanceIntervalDays = 14;
    note = `P(≥50% stenosis) ${stenosis} with a rising venous pressure (${guardrails.venousPressureDeltaPct ?? '—'}%) and recirculation ${input.recirculationPct ?? '—'}% — propose a duplex ultrasound / fistulogram referral. Referral is a proposal: the access team decides (Class C).`;
  } else if (guardrails.flags.includes('recirculation-technique-first')) {
    action = 'change-cannulation-technique';
    surveillanceIntervalDays = 28;
    note = `Recirculation ${input.recirculationPct}% without a matching pressure rise — rule out cannulation technique (needle placement, rope-ladder) before imaging.`;
  } else if (stenosis >= 0.3 || guardrails.flags.includes('single-reading-no-trend')) {
    action = 'increase-surveillance';
    surveillanceIntervalDays = 28;
    note = `P(≥50% stenosis) ${stenosis} — intensify surveillance to a 4-weekly access review and re-measure pressure, flow and recirculation before any imaging referral.`;
  } else {
    action = 'no-action';
    surveillanceIntervalDays = 84;
    note = `P(≥50% stenosis) ${stenosis}; no deterioration pattern — continue routine quarterly access surveillance.`;
  }

  const projectedStenosisProbability = round3(Math.min(0.99, stenosis * (action === 'refer-duplex-ultrasound' ? 0.85 : 1 + 0.06 * ((surveillanceIntervalDays ?? 84) / 28))));

  return {
    patientId: input.patientId,
    guardrails,
    latent,
    current: {
      accessType: input.accessType,
      accessAgeDays: input.accessAgeDays,
      observations: input.observations ?? 0,
      venousPressureMmHg: input.venousPressureMmHg,
      venousPressureDeltaPct: guardrails.venousPressureDeltaPct,
      recirculationPct: input.recirculationPct,
      accessFlowMlMin: input.accessFlowMlMin,
      accessFlowDeltaPct: guardrails.accessFlowDeltaPct,
      deliveredClearancePct: input.deliveredClearancePct,
      cannulationDifficulty: input.cannulationDifficulty,
      daysSinceIntervention: input.daysSinceIntervention,
    },
    stenosisProbability: stenosis,
    thrombosisRiskByHorizon,
    action,
    recommended: {
      ...(surveillanceIntervalDays !== undefined ? { surveillanceIntervalDays } : {}),
      projectedStenosisProbability,
      ...(thrombosisRiskByHorizon[30] !== undefined ? { projectedThrombosisRisk30d: thrombosisRiskByHorizon[30] } : {}),
    },
    drivers: ACCESS_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance })).sort((a, b) => b.relevance - a.relevance),
    model: ACCESS_ADVISOR_MODEL,
    synthetic: true,
    note,
  };
}

/* ======================================================================
 * 5. Bounded cells + durable episodes
 * ====================================================================== */

export const ACCESS_CELLS: CellManifest[] = [
  {
    id: 'access-surveillance-observer',
    version: '0.1.0',
    displayName: 'Access surveillance observer',
    domain: 'quality',
    owner: 'Nursing · vascular access',
    consumes: ['access.observed.v1', 'access.acoustic.v1'],
    produces: ['access.surveillance.flag'],
    allowedActions: ['notify-staff', 'update-care-plan', 'record-assessment', 'schedule-followup'],
    approvalClass: 'B',
    evalGate: 0.85,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.4 (a) · longitudinal pressure/flow observer, no audio',
  },
  {
    id: 'access-referral',
    version: '0.1.0',
    displayName: 'Access referral proposal',
    domain: 'patient-care',
    owner: 'Nephrology · vascular access team',
    consumes: ['access.surveillance.flag', 'session.ended.v1'],
    produces: ['access.referral.proposal'],
    allowedActions: ['schedule-followup', 'notify-staff', 'order-lab', 'update-care-plan'],
    approvalClass: 'C',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.4 (c) · referral workflow, always human-approved',
  },
];

export const ACCESS_CONSUMED_BY: Record<string, string[]> = {
  'access.surveillance.flag': ['access-surveillance-observer', 'access-referral'],
  'access.referral.proposal': ['access-referral'],
};

export const ACCESS_EPISODE_KINDS = ['access.stenosis-referral'] as const;

/* ======================================================================
 * 6. Reference boundary
 * ====================================================================== */

export interface AccessDemoState {
  source: 'access';
  features: readonly AccessFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  kpis: { accessesTracked: number; surveillanceCompletenessPct: number; stenosisReferrals: number; thrombosesLast90d: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

export function buildAccessDemo(now: () => string = NOW): Omit<AccessDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'access-referral', kind: 'access.referral.proposal', subject: 'patient:p-access-1', scopeType: 'patient',
      option: 'duplex ultrasound referral for a progressive venous stenosis', approvalClass: 'C',
      recommendation: 'Patient p-access-1: venous pressure +38% over 5 surveillance observations (142 → 196 mmHg) with recirculation 14.2% and Qa 640 mL/min — propose a duplex ultrasound / fistulogram referral; the access team decides.',
      allowed: true, evidence: [ev('access.observed.v1:p-access-1', 'event'), ev('session.ended.v1:p-access-1', 'fact')],
      producedAt: now(), payload: { stenosisProbability: 0.71, thrombosisRisk30d: 0.16 },
    }),
    makeProposal({
      cellId: 'access-surveillance-observer', kind: 'access.surveillance.flag', subject: 'patient:p-access-2', scopeType: 'patient',
      option: 'cannulation technique review', approvalClass: 'B',
      recommendation: 'Patient p-access-2: recirculation 16.8% with a flat venous-pressure trend — rule out cannulation technique (needle placement, rope-ladder) before imaging; nursing review.',
      allowed: true, evidence: [ev('access.observed.v1:p-access-2', 'event')],
      producedAt: now(), payload: { recirculationPct: 16.8, pressureTrendPct: 4 },
    }),
  ];
  const insights = aggregateSwarmInsights({ proposals, consumedBy: ACCESS_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;
  const candidates: NbaCandidate[] = [
    {
      title: 'Duplex ultrasound referral for p-access-1 (progressing venous stenosis)', cells: ['access referral'],
      scopeType: 'patient', subject: 'patient:p-access-1', owner: 'Nephrology · vascular access team', due: 'Within 2 weeks',
      evidence: [ev('access.observed.v1:p-access-1', 'event')],
      consensus: 0.9, approvalClass: 'C', expectedOutcome: 42000, urgency: 0.75, policyCost: 0.4, risk: 0.3,
      insightKind: 'access.referral.proposal',
    },
    {
      title: 'Cannulation technique review for p-access-2 (recirculation without pressure rise)', cells: ['access surveillance observer'],
      scopeType: 'patient', subject: 'patient:p-access-2', owner: 'Nursing · vascular access', due: 'Next session',
      evidence: [ev('access.observed.v1:p-access-2', 'event')],
      consensus: 0.82, approvalClass: 'B', expectedOutcome: 14000, urgency: 0.6, policyCost: 0.2, risk: 0.2,
      insightKind: 'access.surveillance.flag',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true });
  return {
    source: 'access',
    features: ACCESS_FEATURES,
    cells: ACCESS_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { accessesTracked: 58, surveillanceCompletenessPct: 91, stenosisReferrals: 6, thrombosesLast90d: 1 },
  };
}

export function accessEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (ACCESS_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/**
 * Seed durable access episodes: one Class C duplex referral awaiting approval and
 * one full closed loop (Class B cannulation change → verified primary patency).
 */
export async function seedAccessEpisodes(
  coordinator: PersistentOutcomeCoordinator,
  _ws?: SwarmWorkspaceStore,
  now: () => string = NOW,
): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const find = (subject: string): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === 'access.stenosis-referral' && e.subject === subject && e.scopeType === 'patient');

  const p1 = find('patient:p-access-1');
  if (!p1) {
    const rec = accessRecommend({
      patientId: 'p-access-1', accessType: 'avf', accessAgeDays: 420, site: 'left-forearm',
      observations: 5, venousPressureMmHg: 196, venousPressureBaselineMmHg: 142,
      recirculationPct: 14.2, accessFlowMlMin: 640, accessFlowBaselineMlMin: 980,
      deliveredClearancePct: 78, deliveredClearanceBaselinePct: 96,
      cannulationDifficulty: 'difficult', priorInterventions: 1, daysSinceIntervention: 210,
      asOf: now(),
    });
    const e = coordinator.open({ kind: 'access.stenosis-referral', subject: 'patient:p-access-1', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('access.observed.v1:p-access-1', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'access-referral', kind: 'access.referral.proposal', subject: e.subject, scopeType: 'patient',
      option: 'duplex ultrasound referral', approvalClass: 'C',
      recommendation: rec.note, allowed: true, evidence: [ev('access.observed.v1:p-access-1', 'event')],
      producedAt: now(), payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(p1.episodeId);
  }

  const p2 = find('patient:p-access-2');
  if (!p2) {
    const e = coordinator.open({ kind: 'access.stenosis-referral', subject: 'patient:p-access-2', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('access.observed.v1:p-access-2', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'access-surveillance-observer', kind: 'access.surveillance.flag', subject: e.subject, scopeType: 'patient',
      option: 'cannulation technique review', approvalClass: 'B',
      recommendation: 'Recirculation 16.8% with a flat pressure trend — cannulation technique review (needle placement, rope-ladder) before imaging.',
      allowed: true, evidence: [ev('access.observed.v1:p-access-2', 'event')], producedAt: now(), payload: { recirculationPct: 16.8 },
    }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Access nurse lead', 'B');
    coordinator.dispatchCommand(e.episodeId, 'update-care-plan');
    coordinator.acknowledge(e.episodeId, 'patient:p-access-2');
    coordinator.verify(e.episodeId, { measureId: 'access.primary-patency', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(p2.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY access episodes. */
export async function dropAccessEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = accessEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}
