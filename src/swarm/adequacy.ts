/******************************************************************************
 * Dialysis adequacy domain — P1 protocol pack (step A: engine + guardrails +
 * observer cell).
 *
 * Model family is fixed by the verified evidence recorded in
 * docs/renal-protocols-implementation-strategy.md §0/§2.3: tree ensembles
 * (XGBoost r=0.873, RF AUROC 0.873) beat CNN/GRU/linear for adequacy, so the
 * head is **XGBoost/RF-class trees over a Daugirdas urea-kinetic prior** — never
 * a transformer. The mechanistic prior lives in src/protocols/priors.ts; the
 * dependency-free booster lives in src/protocols/gbdt.ts.
 *
 * Same six-step protocol pack as anemia (A engine → B governance → C what-if →
 * D twin/drift → E trained artifact → F validation/MDR + exec page):
 *
 *   • ADEQUACY_FEATURES  — feature catalog with bounds/units/relevance.
 *   • guardAdequacyPrescription — hard guardrails (machine + patient safety).
 *   • adequacyLatent     — deterministic 2-D latent (delivered dose × vulnerability).
 *   • adequacyRecommend  — reference surrogate over the Daugirdas prior.
 *   • ADEQUACY_CELLS     — bounded cells (CellManifest contract).
 *   • seedAdequacyEpisodes — durable episodes on the SHARED coordinator.
 *
 * SAFETY BOUNDARY: CDSS only. No autonomous machine-parameter change, ever.
 * Qb/time changes are Class C (nephrologist) after review; a shortened-session
 * pattern must be handled as an adherence intervention before any prescription
 * change; access recirculation routes to access review before flow escalation.
 ******************************************************************************/

import type { CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef, ScopeType } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';
import {
  adequacyPrior, daugirdasSpKtV, ktvToUrr, spKtVFromUrr, weeklyKtV,
  KTV_TARGET, KTV_TARGET_FREQUENT, URR_FLOOR_PCT,
} from '../protocols/priors.js';
import { fluidPrior, NADIR_SBP_FLOOR, IDWG_FLAG_KG } from '../protocols/priors.js';

/* ======================================================================
 * 1. Feature catalog
 * ====================================================================== */

export interface AdequacyFeature {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** relevance for the reference surrogate (machinery first, then patient factors) */
  relevance: number;
}

export const ADEQUACY_FEATURES: readonly AdequacyFeature[] = [
  { id: 'deliveredMinutes', label: 'Delivered treatment time', unit: 'min', min: 60, max: 300, relevance: 0.22 },
  { id: 'qbAvg', label: 'Delivered blood flow (Qb)', unit: 'mL/min', min: 150, max: 500, relevance: 0.18 },
  { id: 'prescribedMinutes', label: 'Prescribed treatment time', unit: 'min', min: 60, max: 300, relevance: 0.12 },
  { id: 'recirculationPct', label: 'Access recirculation', unit: '%', min: 0, max: 40, relevance: 0.11 },
  { id: 'accessType', label: 'Vascular access type (0 AVF, 1 AVG, 2 catheter)', unit: 'code', min: 0, max: 2, relevance: 0.09 },
  { id: 'sessionsPerWeek', label: 'Sessions per week', unit: '/wk', min: 1, max: 7, relevance: 0.08 },
  { id: 'qd', label: 'Dialysate flow (Qd)', unit: 'mL/min', min: 300, max: 800, relevance: 0.05 },
  { id: 'nadirSbp', label: 'Nadir intradialytic systolic BP', unit: 'mmHg', min: 60, max: 170, relevance: 0.05 },
  { id: 'idwgKg', label: 'Interdialytic weight gain', unit: 'kg', min: 0, max: 8, relevance: 0.04 },
  { id: 'ufVolumeL', label: 'Ultrafiltration volume', unit: 'L', min: 0, max: 6, relevance: 0.03 },
  { id: 'potassium', label: 'Predialysis potassium', unit: 'mmol/L', min: 2.5, max: 7.5, relevance: 0.03 },
];

/** KDOQI/K-DOQI alignment: target spKt/V band (thrice-weekly ≥ 1.2, frequent ≥ 1.4). */
export const KTV_BAND = { min: KTV_TARGET, max: KTV_TARGET_FREQUENT } as const;
/** Smallest titratable increments the prescription simulator may propose. */
export const ADEQUACY_TIME_STEP_MIN = 15;
export const ADEQUACY_QB_STEP_MLMIN = 25;
export const ADEQUACY_MAX_QB = 450;
/** Over-delivery ceiling — beyond this we stop adding clearance and review time. */
export const KTV_OVER_DELIVERY = 1.8;

/* ======================================================================
 * 2. Guardrails — machine + patient safety, adherence and access coupling
 * ====================================================================== */

export type AdequacyGuardFlag =
  | 'no-session-telemetry'              // nothing delivered on the ledger → block
  | 'no-ktv-measurement'                // no URR / pre-post urea → block (can't claim adequacy)
  | 'shortened-sessions-adherence-first' // adherence intervention precedes prescription change
  | 'qb-escalation-cardiac-risk'        // frailty/cardiac/hypotension history → never raise Qb
  | 'access-recirculation-review-first' // recirculation ≥10% → access review before flow escalation
  | 'hypotension-coupling-no-uf-increase' // fluid protocol owns any UF increase
  | 'ktv-above-over-delivery-ceiling';   // over-delivery → reduce time, don't add clearance

export interface AdequacyGuardInput {
  deliveredMinutes?: number | undefined;
  prescribedMinutes?: number | undefined;
  urrPct?: number | undefined;
  deliveredSpKtV?: number | undefined;
  recirculationPct?: number | undefined;
  nadirSbp?: number | undefined;
  age?: number | undefined;
  cardiacHistory?: boolean | undefined;
  sessionCount?: number | undefined;
  adherencePct?: number | undefined;
}

export interface AdequacyGuardResult {
  flags: AdequacyGuardFlag[];
  blocked: boolean;
  blockReason: string | null;
  /** whether escalating Qb is permitted at all */
  qbEscalationAllowed: boolean;
  /** whether escalating treatment time is permitted at all */
  timeEscalationAllowed: boolean;
}

export function guardAdequacyPrescription(input: AdequacyGuardInput): AdequacyGuardResult {
  const flags: AdequacyGuardFlag[] = [];
  const spKtV = input.deliveredSpKtV
    ?? (input.urrPct !== undefined ? spKtVFromUrr({ urrPct: input.urrPct, durationHours: (input.deliveredMinutes ?? 240) / 60, ufVolumeL: 2.5, postWeightKg: 70 }) : undefined);
  const adherence = input.adherencePct
    ?? (input.prescribedMinutes && input.deliveredMinutes ? Math.round((input.deliveredMinutes / input.prescribedMinutes) * 100) : undefined);

  if (!input.sessionCount) flags.push('no-session-telemetry');
  if (spKtV === undefined) flags.push('no-ktv-measurement');
  if (adherence !== undefined && adherence < 90) flags.push('shortened-sessions-adherence-first');
  if ((input.recirculationPct ?? 0) >= 10) flags.push('access-recirculation-review-first');
  if ((input.nadirSbp ?? 999) < NADIR_SBP_FLOOR || input.cardiacHistory === true || (input.age ?? 0) >= 80) flags.push('qb-escalation-cardiac-risk');
  if ((input.nadirSbp ?? 999) < NADIR_SBP_FLOOR) flags.push('hypotension-coupling-no-uf-increase');
  if (spKtV !== undefined && spKtV > KTV_OVER_DELIVERY) flags.push('ktv-above-over-delivery-ceiling');

  const blocked = flags.includes('no-session-telemetry') || flags.includes('no-ktv-measurement') || flags.includes('shortened-sessions-adherence-first');
  const blockReason = !blocked
    ? null
    : flags.includes('no-session-telemetry')
      ? 'No delivered session on the ledger — cannot assess adequacy.'
      : flags.includes('no-ktv-measurement')
        ? 'No URR or pre/post urea measured — order a clearance measurement before changing the prescription.'
        : 'Delivered time below 90% of prescribed — fix adherence before changing the prescription.';

  return {
    flags,
    blocked,
    blockReason,
    qbEscalationAllowed: !flags.includes('qb-escalation-cardiac-risk') && !flags.includes('access-recirculation-review-first'),
    timeEscalationAllowed: !flags.includes('shortened-sessions-adherence-first') && !flags.includes('ktv-above-over-delivery-ceiling'),
  };
}

/* ======================================================================
 * 3. Deterministic 2-D latent — delivered dose × patient vulnerability
 * ====================================================================== */

const norm = (v: number, f: AdequacyFeature): number =>
  Math.max(-1, Math.min(1, ((v - f.min) / (f.max - f.min)) * 2 - 1));

export function adequacyLatent(input: AdequacyGuardInput & { idwgKg?: number | undefined; accessType?: 'avf' | 'avg' | 'catheter' | undefined }): {
  l1: number; l2: number; polarRadius: number; polarAngleRad: number;
} {
  const f = (id: string): AdequacyFeature => ADEQUACY_FEATURES.find((x) => x.id === id)!;
  // Axis 1 — delivered dose / clearance pressure (higher = more clearance delivered).
  const delivered = (input.deliveredMinutes !== undefined ? norm(input.deliveredMinutes, f('deliveredMinutes')) * 0.5 : 0)
    + (input.deliveredSpKtV !== undefined || input.urrPct !== undefined
      ? Math.max(-1, Math.min(1, (((input.deliveredSpKtV ?? (input.urrPct !== undefined ? spKtVFromUrr({ urrPct: input.urrPct, durationHours: 4, ufVolumeL: 2.5, postWeightKg: 70 }) ?? 1 : 1)) - 1.2) / 0.6) * 2 - 1)) * 0.5
      : 0);
  // Axis 2 — vulnerability (higher = more fragile: hypotension / access / adherence).
  const accessCode = input.accessType === 'catheter' ? 1 : input.accessType === 'avg' ? 0.5 : 0;
  const vulnerability = (input.nadirSbp !== undefined ? 1 - Math.max(0, Math.min(1, (input.nadirSbp - 80) / 50)) : 0) * 0.4
    + Math.max(0, Math.min(1, (input.recirculationPct ?? 0) / 20)) * 0.25
    + accessCode * 0.2
    + (input.adherencePct !== undefined ? Math.max(0, Math.min(1, (95 - input.adherencePct) / 25)) : 0) * 0.15;
  const l1 = Math.max(-1, Math.min(1, delivered));
  const l2 = Math.max(-1, Math.min(1, vulnerability * 2 - 1));
  return { l1, l2, polarRadius: Math.hypot(l1, l2), polarAngleRad: Math.atan2(l2, l1) };
}

/* ======================================================================
 * 4. Reference surrogate recommendation (deterministic; artifact = step E)
 * ====================================================================== */

export interface AdequacyPatientWindow {
  patientId: string;
  facilityId?: string | undefined;
  sessionCount?: number | undefined;
  sessionsPerWeek?: number | undefined;
  prescribedMinutes?: number | undefined;
  deliveredMinutes?: number | undefined;
  qbPrescribed?: number | undefined;
  qbAvg?: number | undefined;
  qd?: number | undefined;
  ufVolumeL?: number | undefined;
  postWeightKg?: number | undefined;
  recirculationPct?: number | undefined;
  accessType?: 'avf' | 'avg' | 'catheter' | undefined;
  nadirSbp?: number | undefined;
  idwgKg?: number | undefined;
  potassium?: number | undefined;
  urrPct?: number | undefined;
  /** measured URR series in the window (coverage density + drift inputs) */
  urrTrendPct?: readonly number[] | undefined;
  deliveredSpKtV?: number | undefined;
  adherencePct?: number | undefined;
  age?: number | undefined;
  cardiacHistory?: boolean | undefined;
  asOf: string;
}

export type AdequacyAction = 'extend-time' | 'raise-qb' | 'reduce-time' | 'review-access' | 'adherence-first' | 'hold' | 'blocked';

export interface AdequacyRecommendation {
  patientId: string;
  inTargetBand: boolean;
  guardrails: AdequacyGuardResult;
  latent: ReturnType<typeof adequacyLatent>;
  current: {
    prescribedMinutes?: number | undefined;
    deliveredMinutes?: number | undefined;
    qbAvg?: number | undefined;
    spKtV?: number | undefined;
    urrPct?: number | undefined;
    weeklyKtV?: number | undefined;
  };
  action: AdequacyAction;
  recommended: {
    minutes?: number | undefined;
    qb?: number | undefined;
    /** prior-implied spKt/V after the change (Daugirdas scaling) */
    expectedSpKtV?: number | undefined;
    expectedUrrPct?: number | undefined;
    /** predicted intradialytic hypotension risk proxy (couples to P2) */
    expectedIdhRisk?: number | undefined;
    deltaMinutes: number;
    deltaQb: number;
  };
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: 'reference-surrogate' | 'trained' };
  synthetic: boolean;
  note: string;
}

export const ADEQUACY_ADVISOR_MODEL = { id: 'adequacy.ktv-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

/**
 * Clearance scaling for a prescription change. Urea clearance saturates in Qb
 * (documented engineering prior: K ≈ K0 · (Qb / (Qb + 60)) normalized at the
 * current Qb), and is proportional to treatment time. Returned as a multiplier
 * on the current delivered spKt/V.
 */
export function clearanceMultiplier(input: { minutesNow: number; minutesNext: number; qbNow?: number; qbNext?: number }): number {
  const timeFactor = input.minutesNow > 0 ? input.minutesNext / input.minutesNow : 1;
  const qbNow = input.qbNow ?? 0;
  const qbNext = input.qbNext ?? qbNow;
  const saturate = (qb: number): number => (qb > 0 ? qb / (qb + 60) : 0);
  const qbFactor = qbNow > 0 && qbNext > 0 ? saturate(qbNext) / saturate(qbNow) : 1;
  return Math.round(timeFactor * qbFactor * 1e4) / 1e4;
}

/** Intradialytic hypotension risk proxy (0–1) — the coupling signal to fluid (P2). */
export function idhRiskProxy(input: { nadirSbp?: number | undefined; idwgKg?: number | undefined; postWeightKg?: number | undefined; ufRateMlH?: number | undefined; plannedMinutes?: number | undefined; ufVolumeL?: number | undefined }): number {
  const fluid = fluidPrior({
    ...(input.idwgKg !== undefined ? { avgIdwgKg: input.idwgKg } : {}),
    ...(input.nadirSbp !== undefined ? { minNadirSbp: input.nadirSbp } : {}),
    ...(input.postWeightKg !== undefined ? { dryWeightKg: input.postWeightKg } : {}),
  });
  const ufRate = input.ufRateMlH
    ?? (input.ufVolumeL !== undefined && input.plannedMinutes ? (input.ufVolumeL * 1000) / input.plannedMinutes : undefined);
  const rateTerm = ufRate !== undefined ? Math.max(0, Math.min(1, (ufRate - 8) / 12)) : 0;
  const bpTerm = input.nadirSbp !== undefined ? Math.max(0, Math.min(1, (105 - input.nadirSbp) / 25)) : 0;
  const idwgTerm = input.idwgKg !== undefined ? Math.max(0, Math.min(1, input.idwgKg / 5)) : 0;
  const risk = 0.45 * bpTerm + 0.35 * rateTerm + 0.2 * idwgTerm + (fluid.intradialyticHypotension ? 0.1 : 0);
  return Math.round(Math.min(1, risk) * 1000) / 1000;
}

export function adequacyRecommend(input: AdequacyPatientWindow): AdequacyRecommendation {
  const guardrails = guardAdequacyPrescription(input);
  const latent = adequacyLatent(input);
  const sessionsPerWeek = input.sessionsPerWeek ?? 3;

  const prior = adequacyPrior({
    ...(input.urrPct !== undefined ? { urrPct: input.urrPct } : {}),
    ...(input.prescribedMinutes !== undefined && input.deliveredMinutes !== undefined
      ? { prescribedMinutes: input.prescribedMinutes, deliveredMinutes: input.deliveredMinutes }
      : {}),
    sessionsPerWeek,
  });
  const spKtV = input.deliveredSpKtV ?? prior.spKtV;
  const urrPct = input.urrPct ?? (spKtV !== undefined ? ktvToUrr(spKtV) : undefined);
  const inTargetBand = spKtV !== undefined && spKtV >= KTV_BAND.min && spKtV <= KTV_BAND.max;

  const minutesNow = input.deliveredMinutes ?? input.prescribedMinutes ?? 210;
  const qbNow = input.qbAvg ?? input.qbPrescribed ?? 0;
  let action: AdequacyAction = 'hold';
  let minutes: number | undefined;
  let qb: number | undefined;
  let note = '';

  if (guardrails.blocked) {
    action = guardrails.flags.includes('shortened-sessions-adherence-first') ? 'adherence-first' : 'blocked';
    note = guardrails.blockReason ?? 'Blocked by guardrails.';
  } else if (spKtV === undefined) {
    action = 'blocked';
    note = 'No clearance measurement — order URR before any prescription change.';
  } else if (spKtV > KTV_OVER_DELIVERY) {
    action = 'reduce-time';
    minutes = Math.max(120, minutesNow - ADEQUACY_TIME_STEP_MIN * 2);
    note = `spKt/V ${spKtV} is above the over-delivery ceiling — reduce treatment time rather than adding clearance.`;
  } else if (spKtV >= KTV_BAND.min && spKtV <= KTV_BAND.max) {
    action = 'hold';
    note = `spKt/V ${spKtV} in the ${KTV_BAND.min}–${KTV_BAND.max} band — hold the prescription; reassess monthly with the URR series.`;
  } else if ((spKtV < KTV_BAND.min) && ((input.recirculationPct ?? 0) >= 10)) {
    action = 'review-access';
    note = `spKt/V ${spKtV} below target with ${input.recirculationPct}% recirculation — access review before escalating flow or time.`;
  } else if (spKtV < KTV_BAND.min) {
    // Below band: prefer extending time; escalate Qb only when it is safe to do so.
    const deficit = KTV_BAND.min - spKtV;
    const timeStep = deficit > 0.25 ? ADEQUACY_TIME_STEP_MIN * 2 : ADEQUACY_TIME_STEP_MIN;
    if (guardrails.timeEscalationAllowed) {
      minutes = minutesNow + timeStep;
      action = 'extend-time';
      if (guardrails.qbEscalationAllowed && qbNow > 0 && qbNow + ADEQUACY_QB_STEP_MLMIN <= ADEQUACY_MAX_QB && deficit > 0.35) {
        qb = qbNow + ADEQUACY_QB_STEP_MLMIN;
      }
      note = `spKt/V ${spKtV} below ${KTV_BAND.min} — extend treatment to ${minutes} min${qb ? ` and Qb to ${qb} mL/min` : ''} (advisory; Class C).`;
    } else {
      action = 'hold';
      note = 'Below target but escalation is not permitted by the guardrails — resolve the blocking condition first.';
    }
  }

  const multiplier = clearanceMultiplier({
    minutesNow,
    minutesNext: minutes ?? minutesNow,
    qbNow,
    qbNext: qb ?? qbNow,
  });
  const expectedSpKtV = spKtV !== undefined && action !== 'blocked'
    ? Math.round(Math.min(3, spKtV * multiplier) * 100) / 100
    : undefined;
  const expectedUrrPct = expectedSpKtV !== undefined ? Math.round(ktvToUrr(expectedSpKtV) * 10) / 10 : undefined;
  const plannedUf = input.ufVolumeL;
  const expectedIdhRisk = idhRiskProxy({
    ...(input.nadirSbp !== undefined ? { nadirSbp: input.nadirSbp } : {}),
    ...(input.idwgKg !== undefined ? { idwgKg: input.idwgKg } : {}),
    ...(input.postWeightKg !== undefined ? { postWeightKg: input.postWeightKg } : {}),
    ...(plannedUf !== undefined ? { ufVolumeL: plannedUf } : {}),
    plannedMinutes: minutes ?? minutesNow,
  });

  const drivers = ADEQUACY_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance }))
    .sort((a, b) => b.relevance - a.relevance);

  return {
    patientId: input.patientId,
    inTargetBand,
    guardrails,
    latent,
    current: {
      prescribedMinutes: input.prescribedMinutes,
      deliveredMinutes: input.deliveredMinutes,
      qbAvg: input.qbAvg,
      spKtV,
      urrPct,
      weeklyKtV: spKtV !== undefined ? weeklyKtV(spKtV, sessionsPerWeek) : undefined,
    },
    action,
    recommended: {
      minutes,
      qb,
      expectedSpKtV,
      expectedUrrPct,
      expectedIdhRisk: (action === 'blocked') ? undefined : expectedIdhRisk,
      deltaMinutes: minutes !== undefined ? minutes - minutesNow : 0,
      deltaQb: qb !== undefined ? qb - qbNow : 0,
    },
    drivers,
    model: ADEQUACY_ADVISOR_MODEL,
    synthetic: true,
    note,
  };
}

/* ======================================================================
 * 5. Bounded cells (CellManifest contract)
 * ====================================================================== */

export const ADEQUACY_CELLS: CellManifest[] = [
  {
    id: 'adequacy-prescription',
    version: '0.1.0',
    displayName: 'Dialysis adequacy prescription',
    domain: 'quality',
    owner: 'Nephrology · Renal dialysis',
    consumes: ['lab.result-arrived', 'session.ended.v1', 'session.started.v1'],
    produces: ['adequacy.ktv.proposal'],
    allowedActions: ['order-lab', 'update-care-plan', 'schedule-followup', 'notify-staff'],
    approvalClass: 'C',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.3 · Daugirdas prior + tree head',
  },
  {
    id: 'access-clearance-review',
    version: '0.1.0',
    displayName: 'Access clearance review',
    domain: 'patient-care',
    owner: 'Nephrology · Vascular access',
    consumes: ['access.observed.v1', 'session.ended.v1'],
    produces: ['adequacy.access-review.proposal'],
    allowedActions: ['order-lab', 'schedule-followup', 'notify-staff', 'update-care-plan'],
    approvalClass: 'B',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'Implementation strategy §2.4 · recirculation → access review before flow escalation',
  },
];

export const ADEQUACY_CONSUMED_BY: Record<string, string[]> = {
  'adequacy.ktv.proposal': ['adequacy-prescription', 'access-clearance-review'],
  'adequacy.access-review.proposal': ['access-clearance-review'],
};

export const ADEQUACY_EPISODE_KINDS = ['adequacy.ktv-response'] as const;

/* ======================================================================
 * 6. Reference boundary (proposals → insights → ranked NBAs)
 * ====================================================================== */

export interface AdequacyDemoState {
  source: 'adequacy';
  features: readonly AdequacyFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  kpis: { spKtVInBandPct: number; shortSessionPct: number; recirculationFlaggedPct: number; valueAtRiskUsd: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

export function buildAdequacyDemo(now: () => string = NOW): Omit<AdequacyDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'adequacy-prescription', kind: 'adequacy.ktv.proposal', subject: 'patient:p-ktv-1', scopeType: 'patient',
      option: 'extend treatment time to reach the Kt/V band', approvalClass: 'C',
      recommendation: 'Patient p-ktv-1 delivers spKt/V 1.02 (URR 58%) at 200 min / Qb 320 with no recirculation — extend treatment to 230 min (expected spKt/V ~1.17) and re-measure URR next session; MD review required.',
      allowed: true, evidence: [ev('lab.result-arrived:URR', 'fact'), ev('session.ended.v1:p-ktv-1', 'event')],
      producedAt: now(), payload: { minutes: 230, expectedSpKtV: 1.17, deltaMinutes: 30 },
    }),
    makeProposal({
      cellId: 'access-clearance-review', kind: 'adequacy.access-review.proposal', subject: 'patient:p-ktv-2', scopeType: 'patient',
      option: 'access review before flow escalation', approvalClass: 'B',
      recommendation: 'Patient p-ktv-2 shows 16% recirculation with delivered spKt/V 1.08 — recirculation is stealing clearance; review access (fistulogram) before raising Qb.',
      allowed: true, evidence: [ev('access.observed.v1:p-ktv-2', 'event'), ev('lab.result-arrived:URR', 'fact')],
      producedAt: now(), payload: { recirculationPct: 16, kind: 'review-access' },
    }),
  ];

  const insights = aggregateSwarmInsights({ proposals, consumedBy: ADEQUACY_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;

  const candidates: NbaCandidate[] = [
    {
      title: 'Extend treatment time for p-ktv-1 (spKt/V below target)', cells: ['adequacy prescription'],
      scopeType: 'patient', subject: 'patient:p-ktv-1', owner: 'Nephrology · Renal dialysis', due: 'This week',
      evidence: [ev('lab.result-arrived:URR', 'fact'), ev('session.ended.v1:p-ktv-1', 'event')],
      consensus: 0.92, approvalClass: 'C', expectedOutcome: 26000, urgency: 0.55, policyCost: 0.4, risk: 0.25,
      insightKind: 'adequacy.ktv.proposal',
    },
    {
      title: 'Access review before Qb escalation for p-ktv-2 (16% recirculation)', cells: ['access clearance review'],
      scopeType: 'patient', subject: 'patient:p-ktv-2', owner: 'Nephrology · Vascular access', due: 'This month',
      evidence: [ev('access.observed.v1:p-ktv-2', 'event')],
      consensus: 0.78, approvalClass: 'B', expectedOutcome: 19000, urgency: 0.4, policyCost: 0.5, risk: 0.3,
      insightKind: 'adequacy.access-review.proposal',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true });

  return {
    source: 'adequacy',
    features: ADEQUACY_FEATURES,
    cells: ADEQUACY_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { spKtVInBandPct: 76, shortSessionPct: 9, recirculationFlaggedPct: 12, valueAtRiskUsd: 180000 },
  };
}

/* ======================================================================
 * 7. Durable episodes on the SHARED coordinator (idempotent)
 * ====================================================================== */

export function adequacyEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (ADEQUACY_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/**
 * Seed durable adequacy episodes (idempotent by kind+subject+scopeType):
 *   1. adequacy.ktv-response · patient:p-ktv-1 — AwaitingApproval (Class C) →
 *      My Work, with the prescription proposal in the payload.
 *   2. adequacy.ktv-response · patient:p-ktv-2 — full closed loop (approve →
 *      update-care-plan command → acknowledge → verify against the Kt/V measure).
 */
export async function seedAdequacyEpisodes(
  coordinator: PersistentOutcomeCoordinator,
  _ws?: SwarmWorkspaceStore,
  now: () => string = NOW,
): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const find = (subject: string): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === 'adequacy.ktv-response' && e.subject === subject && e.scopeType === 'patient');

  const p1 = find('patient:p-ktv-1');
  if (!p1) {
    const rec = adequacyRecommend({
      patientId: 'p-ktv-1', sessionCount: 3, sessionsPerWeek: 3, prescribedMinutes: 210, deliveredMinutes: 200,
      qbPrescribed: 320, qbAvg: 318, ufVolumeL: 2.4, postWeightKg: 72, recirculationPct: 4.2, accessType: 'avf',
      nadirSbp: 108, idwgKg: 2.3, potassium: 5.1, urrPct: 58, asOf: now(),
    });
    const e = coordinator.open({ kind: 'adequacy.ktv-response', subject: 'patient:p-ktv-1', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:URR', 'fact'), ev('session.ended.v1:p-ktv-1', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'adequacy-prescription', kind: 'adequacy.ktv.proposal', subject: e.subject, scopeType: 'patient',
      option: 'extend treatment time to reach the Kt/V band', approvalClass: 'C',
      recommendation: `${rec.note} Expected spKt/V ${rec.recommended.expectedSpKtV ?? 'n/a'} (current ${rec.current.spKtV ?? 'n/a'}).`,
      allowed: true, evidence: [ev('lab.result-arrived:URR', 'fact')], producedAt: now(),
      payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(p1.episodeId);
  }

  const p2 = find('patient:p-ktv-2');
  if (!p2) {
    const e = coordinator.open({ kind: 'adequacy.ktv-response', subject: 'patient:p-ktv-2', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('access.observed.v1:p-ktv-2', 'event'), ev('lab.result-arrived:URR', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'access-clearance-review', kind: 'adequacy.access-review.proposal', subject: e.subject, scopeType: 'patient',
      option: 'access review before flow escalation', approvalClass: 'B',
      recommendation: 'Recirculation 16% with delivered spKt/V 1.08: refer for access imaging, then re-assess Qb. Class B clinical review.',
      allowed: true, evidence: [ev('access.observed.v1:p-ktv-2', 'event')], producedAt: now(), payload: { recirculationPct: 16 },
    }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Dr. Okafor (nephrology)', 'B');
    coordinator.dispatchCommand(e.episodeId, 'update-care-plan');
    coordinator.acknowledge(e.episodeId, 'patient:p-ktv-2');
    coordinator.verify(e.episodeId, { measureId: 'esrd-qip.ktv', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(p2.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY adequacy episodes. */
export async function dropAdequacyEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = adequacyEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

/** Prior/reference constants re-exported for the routes and the exec panel. */
export const ADEQUACY_REFERENCE = {
  ktvTarget: KTV_TARGET,
  ktvFrequent: KTV_TARGET_FREQUENT,
  urrFloorPct: URR_FLOOR_PCT,
  idwgFlagKg: IDWG_FLAG_KG,
  nadirSbpFloor: NADIR_SBP_FLOOR,
  timeStepMinutes: ADEQUACY_TIME_STEP_MIN,
  qbStepMlMin: ADEQUACY_QB_STEP_MLMIN,
  maxQb: ADEQUACY_MAX_QB,
} as const;

export { daugirdasSpKtV, ktvToUrr, spKtVFromUrr, weeklyKtV };
