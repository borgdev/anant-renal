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

// P6 — Infection / vaccination (steps A–F).
//
// THE SPLIT IS THE DESIGN. Two halves that must never be interchanged:
//
//   1. TRIAGE (statistical, uncertain, useful): P(bloodstream infection) from
//      temperature, procalcitonin, NLR, WBC, access type/catheter days, recent
//      hospitalisation and symptoms — a tree model with driver attribution. It
//      ranks suspicion. It never decides treatment.
//
//   2. PREVENTION (deterministic, auditable, complete): vaccination due, series
//      completion, serology follow-up, hand-hygiene/access-care audit cadence,
//      catheter-day escalation with a mature AVF available. These are state
//      machines over CDC core interventions — NOT ML, never a model output, and
//      reproducible line-by-line from the inputs (see infection-prevention.ts).
//
// The report's guidance is explicit and is enforced in code here: "Never ML for
// infection-prevention compliance." So prevention lives in its own module, with
// no model import anywhere in its path, and the acceptance criteria test that
// the same inputs always produce the same tasks.
//
// CDSS only: the platform orders no antimicrobial, writes no prescription, and
// never actions on a single reading. An empiric-antibiotic *discussion* is only
// ever proposed AFTER a blood culture is ordered (culture-before-antibiotic is a
// rule, not a preference).

import type { CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';
import { preventionPlan, preventionDeterminismSignature, type PreventionTask, type PreventionTaskKind } from './infection-prevention.js';
import type { ImmunisationRecord, InfectionInput } from './infection-types.js';

export type { ImmunisationRecord, InfectionInput };

/* ======================================================================
 * 1. Feature contract + reference bounds
 * ====================================================================== */

export interface InfectionFeature {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  relevance: number;
}

export const INFECTION_FEATURES: readonly InfectionFeature[] = [
  { id: 'temperatureC', label: 'Temperature (temporal / pre-dialysis)', unit: '°C', min: 35, max: 41, relevance: 0.18 },
  { id: 'procalcitoninNgMl', label: 'Procalcitonin', unit: 'ng/mL', min: 0, max: 12, relevance: 0.15 },
  { id: 'nlr', label: 'Neutrophil–lymphocyte ratio', unit: '', min: 0.5, max: 20, relevance: 0.14 },
  { id: 'wbc', label: 'White cell count', unit: '10^3/µL', min: 1, max: 25, relevance: 0.10 },
  { id: 'catheterDays', label: 'Central venous catheter days', unit: 'd', min: 0, max: 400, relevance: 0.10 },
  { id: 'nonAvfAccess', label: 'Non-AVF access (catheter / graft)', unit: '0/1', min: 0, max: 1, relevance: 0.08 },
  { id: 'recentHospitalisation30d', label: 'Hospitalisation in the last 30 days', unit: '0/1', min: 0, max: 1, relevance: 0.06 },
  { id: 'crp', label: 'hs-CRP', unit: 'mg/L', min: 0, max: 120, relevance: 0.06 },
  { id: 'albumin', label: 'Serum albumin', unit: 'g/dL', min: 1.8, max: 5, relevance: 0.04 },
  { id: 'accessInfectionSigns', label: 'Access-site infection signs (exit site / tunnel)', unit: '0/1', min: 0, max: 1, relevance: 0.05 },
  { id: 'symptomCount', label: 'Systemic symptoms (rigors, hypotension, confusion)', unit: '', min: 0, max: 5, relevance: 0.04 },
  { id: 'dialysisVintageYears', label: 'Dialysis vintage', unit: 'y', min: 0, max: 30, relevance: 0.03 },
];

export const INFECTION_REFERENCE = {
  /** CDC/NHSN: a dialysis patient with a temperature ≥ 38.0 °C needs evaluation */
  feverC: 38.0,
  /** ≥ 37.8 °C is the lower surveillance trigger (graded "watch" even if not febrile) */
  lowGradeFeverC: 37.8,
  /** procalcitonin thresholds: <0.5 argues against bacterial infection, >2.0 supports it */
  procalcitoninWatchNgMl: 0.5,
  procalcitoninHighNgMl: 2.0,
  /** NLR: >3 is abnormal, >6 is the sepsis-triage signal */
  nlrWatch: 3,
  nlrHigh: 6,
  wbcHigh: 11,
  wbcLow: 4,
  /** catheter-day escalation (CDC): >90 d with a mature AVF available is removable */
  catheterEscalationDays: 90,
  matureAccessDays: 90,
  /** risk bands for the triage score */
  riskBands: { low: 0.2, high: 0.5 },
  /** a culture takes this long to rule in; suspicion before that is 'pending' */
  cultureTurnaroundHours: 48,
  /** minimum serial temperature readings before any triage claim */
  minTemperatureReadings: 3,
  /** horizons for the prevention schedule (days) */
  horizonsDays: [30, 90, 180] as const,
} as const;

export const INFECTION_ANTIMICROBIAL_AUTHORITY = 'none' as const;

/* ======================================================================
 * 2. Triage — the statistical half
 * ====================================================================== */

export interface InfectionDriver {
  id: string;
  label: string;
  value: number;
  /** contribution to the triage score, in score units */
  contribution: number;
  /** the reference bound that made it matter */
  boundary?: string | undefined;
}

export interface BsiAssessment {
  /** reference-surrogate probability of a bloodstream infection */
  probability: number;
  /** low | watch | high — the triage band (policy, not the number) */
  band: 'low' | 'watch' | 'high';
  febrile: boolean;
  /** physiology taken from the INPUT window, never invented */
  measured: {
    temperatureC?: number | undefined;
    peakTemperatureC?: number | undefined;
    procalcitoninNgMl?: number | undefined;
    nlr?: number | undefined;
    wbc?: number | undefined;
    catheterDays?: number | undefined;
  };
  /** what the score is actually made of, largest contribution first */
  drivers: InfectionDriver[];
  /** which reference criteria fired, for the audit trail */
  criteria: Array<{ id: string; met: boolean; detail: string; source: string }>;
  temperatureReadings: number;
  /** the culture state this triage is allowed to claim */
  culture: { result?: number | undefined; at?: string | undefined; status: 'none' | 'pending' | 'negative' | 'positive'; turnAroundHours: number };
}

/** NLR from a differential when the ratio was not supplied directly. */
export function computeNlr(neutrophilPct?: number, lymphocytePct?: number): number | undefined {
  if (neutrophilPct === undefined || lymphocytePct === undefined || lymphocytePct <= 0) return undefined;
  return Math.round((neutrophilPct / lymphocytePct) * 100) / 100;
}

/**
 * The reference triage surrogate. Deliberately a transparent weighted-evidence
 * score so every contribution can be shown as a driver — the trained artifact
 * (step E) must beat it, and both are reported against each other.
 */
export function assessBsi(input: InfectionInput): BsiAssessment {
  const series = input.temperatureSeries ?? (input.temperatureC !== undefined ? [input.temperatureC] : []);
  const peak = series.length ? Math.max(...series) : undefined;
  const temp = input.temperatureC ?? peak;
  const nlr = input.nlr ?? computeNlr(input.neutrophilPct, input.lymphocytePct);
  const pct = input.procalcitoninNgMl;
  const wbc = input.wbc;
  const catheterDays = input.catheterDays;
  const R = INFECTION_REFERENCE;

  const drivers: InfectionDriver[] = [];
  const add = (id: string, label: string, value: number, contribution: number, boundary?: string): void => {
    if (contribution === 0) return;
    drivers.push({ id, label, value: Math.round(value * 100) / 100, contribution: Math.round(contribution * 1000) / 1000, ...(boundary ? { boundary } : {}) });
  };

  // Temperature — the strongest single NHSN signal, graded rather than binary.
  if (temp !== undefined) {
    const over = temp - R.lowGradeFeverC;
    add('temperatureC', 'Temperature', temp, over > 0 ? Math.min(0.34, over * 0.16) : -0.02, `≥ ${R.feverC} °C needs evaluation`);
  }
  if (pct !== undefined) {
    add('procalcitoninNgMl', 'Procalcitonin', pct, pct >= R.procalcitoninHighNgMl ? 0.24 : pct >= R.procalcitoninWatchNgMl ? 0.12 : -0.02, `> ${R.procalcitoninWatchNgMl} watch, > ${R.procalcitoninHighNgMl} high`);
  }
  if (nlr !== undefined) {
    add('nlr', 'Neutrophil–lymphocyte ratio', nlr, nlr >= R.nlrHigh ? 0.20 : nlr >= R.nlrWatch ? 0.10 : 0, `> ${R.nlrWatch} abnormal, > ${R.nlrHigh} triage signal`);
  }
  if (wbc !== undefined) {
    add('wbc', 'White cell count', wbc, wbc > R.wbcHigh ? 0.10 : wbc < R.wbcLow ? 0.06 : 0, `${R.wbcLow}–${R.wbcHigh} ×10³/µL`);
  }
  if (catheterDays !== undefined && catheterDays > 0) {
    add('catheterDays', 'Catheter days', catheterDays, Math.min(0.14, catheterDays / 400), `> ${R.catheterEscalationDays} d needs escalation`);
  }
  if (input.accessType && input.accessType !== 'avf') {
    add('nonAvfAccess', 'Non-AVF access', 1, input.accessType === 'catheter' ? 0.10 : 0.05, 'catheter > graft > AVF risk');
  }
  if (input.accessInfectionSigns === true) add('accessInfectionSigns', 'Access-site infection signs', 1, 0.14);
  if (input.hospitalisedLast30d === true) add('recentHospitalisation30d', 'Hospitalisation (30 d)', 1, 0.06);
  if (input.crp !== undefined && input.crp > 10) add('crp', 'hs-CRP', input.crp, Math.min(0.08, (input.crp - 10) / 200), '> 10 mg/L');
  if (input.albumin !== undefined && input.albumin < 3.5) add('albumin', 'Albumin', input.albumin, 0.05, '< 3.5 g/dL');
  const symptomCount = input.symptoms?.length ?? 0;
  if (symptomCount > 0) add('symptomCount', 'Systemic symptoms', symptomCount, Math.min(0.16, symptomCount * 0.06));
  if (input.dialysisVintageYears !== undefined && input.dialysisVintageYears > 5) add('dialysisVintageYears', 'Dialysis vintage', input.dialysisVintageYears, 0.02, '> 5 y');

  const raw = 0.04 + drivers.reduce((sum, d) => sum + d.contribution, 0);
  // logistic squashing keeps the score a probability and bounded
  const probability = Math.round((1 / (1 + Math.exp(-(raw * 5 - 1.6)))) * 1000) / 1000;
  const band: BsiAssessment['band'] = probability >= R.riskBands.high ? 'high' : probability >= R.riskBands.low ? 'watch' : 'low';
  const febrile = (temp ?? 0) >= R.feverC;

  const criteria: BsiAssessment['criteria'] = [
    { id: 'fever', met: febrile, detail: `peak ${peak ?? '—'} °C`, source: 'NHSN/CDC dialysis BSI surveillance' },
    { id: 'fever-low-grade', met: (temp ?? 0) >= R.lowGradeFeverC, detail: `${temp ?? '—'} °C`, source: 'CDC core intervention: temperature at every session' },
    { id: 'procalcitonin', met: (pct ?? 0) >= R.procalcitoninWatchNgMl, detail: `${pct ?? '—'} ng/mL`, source: 'PCT interpretation thresholds' },
    { id: 'nlr', met: (nlr ?? 0) >= R.nlrHigh, detail: `${nlr ?? '—'}`, source: 'NLR ≥ 6 sepsis-triage signal' },
    { id: 'leukocytosis', met: (wbc ?? 0) > R.wbcHigh || (wbc !== undefined && wbc < R.wbcLow), detail: `${wbc ?? '—'} ×10³/µL`, source: 'WBC reference range' },
    { id: 'catheter-days', met: (catheterDays ?? 0) > R.catheterEscalationDays, detail: `${catheterDays ?? 0} d`, source: 'CDC catheter-day escalation' },
    { id: 'access-signs', met: input.accessInfectionSigns === true, detail: input.accessInfectionSigns === true ? 'present' : 'none', source: 'CDC access-care core intervention' },
  ];

  const cultureStatus: BsiAssessment['culture']['status'] = input.cultureResult === undefined
    ? 'none'
    : input.cultureResult > 0 ? 'positive' : 'negative';

  return {
    probability,
    band,
    febrile,
    measured: {
      temperatureC: temp,
      peakTemperatureC: peak,
      procalcitoninNgMl: pct,
      nlr,
      wbc,
      catheterDays,
    },
    drivers: drivers.sort((a, b) => b.contribution - a.contribution),
    criteria,
    temperatureReadings: series.length,
    culture: {
      ...(input.cultureResult !== undefined ? { result: input.cultureResult } : {}),
      ...(input.cultureAt !== undefined ? { cultureAt: input.cultureAt } : {}),
      status: cultureStatus,
      turnAroundHours: R.cultureTurnaroundHours,
    },
  };
}

/* ======================================================================
 * 3. Latent — immune/vascular substrate × acute severity
 * ====================================================================== */

export function infectionLatent(input: InfectionInput): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const catheter = input.accessType === 'catheter';
  const catheterDays = input.catheterDays ?? 0;
  // Axis 1 — vascular/immune substrate: how exposed this patient is
  const substrate = clamp01(
    0.45 * (catheter ? 1 : input.accessType === 'avg' ? 0.5 : 0)
    + 0.25 * clamp01(catheterDays / INFECTION_REFERENCE.catheterEscalationDays)
    + 0.15 * (input.hospitalisedLast30d ? 1 : 0)
    + 0.15 * clamp01((input.dialysisVintageYears ?? 0) / 15),
  );
  // Axis 2 — acute severity: what is happening right now
  const assessment = assessBsi(input);
  const severity = clamp01(
    0.5 * assessment.probability
    + 0.25 * (input.accessInfectionSigns ? 1 : 0)
    + 0.25 * clamp01((input.symptoms?.length ?? 0) / 3),
  );
  const l1 = clamp01(substrate);
  const l2 = clamp01(severity);
  return { l1, l2, polarRadius: Math.hypot(l1, l2), polarAngleRad: Math.atan2(l2, l1) };
}

/* ======================================================================
 * 4. Guardrails — the contract
 * ====================================================================== */

export type InfectionGuardFlag =
  | 'no-temperature'
  | 'no-serial-readings'
  | 'no-culture-when-febrile'
  | 'empiric-antibiotic-without-culture'
  | 'culture-ordered-autonomously'
  | 'single-reading-only'
  | 'catheter-with-fever'
  | 'no-inflammatory-markers'
  | 'recent-negative-culture'
  | 'afebrile-low-risk'
  | 'positive-culture';

export interface InfectionGuardResult {
  flags: InfectionGuardFlag[];
  blocked: boolean;
  blockReason: string | null;
  /** the triage may propose a culture order (Class C) — never a drug */
  cultureAllowed: boolean;
  /** an empiric-antimicrobial DISCUSSION is justified only after a culture exists */
  antibioticDiscussionAllowed: boolean;
  /** an urgent escalation (septic physiology) is justified */
  escalateNow: boolean;
  requiresCultureFirst: boolean;
}

export function guardInfectionTriage(input: InfectionInput): InfectionGuardResult {
  const flags: InfectionGuardFlag[] = [];
  const assessment = assessBsi(input);
  const series = input.temperatureSeries ?? (input.temperatureC !== undefined ? [input.temperatureC] : []);
  if (assessment.measured.temperatureC === undefined) flags.push('no-temperature');
  if (series.length < INFECTION_REFERENCE.minTemperatureReadings) flags.push('no-serial-readings');
  if (series.length === 1) flags.push('single-reading-only');
  if (input.procalcitoninNgMl === undefined && input.wbc === undefined && assessment.measured.nlr === undefined) flags.push('no-inflammatory-markers');
  if (assessment.febrile && assessment.culture.status === 'none') flags.push('no-culture-when-febrile');
  if (assessment.febrile && input.accessType === 'catheter') flags.push('catheter-with-fever');
  if (assessment.culture.status === 'negative') flags.push('recent-negative-culture');
  if (assessment.culture.status === 'positive') flags.push('positive-culture');
  if (!assessment.febrile && assessment.band === 'low') flags.push('afebrile-low-risk');

  const blocked = flags.includes('no-temperature') || flags.includes('no-serial-readings');
  const requiresCultureFirst = assessment.febrile && assessment.culture.status === 'none';
  // Culture-before-antibiotic is a RULE: no culture on file ⇒ no antimicrobial
  // discussion, whatever the score says.
  const antibioticDiscussionAllowed = !blocked && assessment.culture.status !== 'none' && (assessment.band === 'high' || assessment.febrile);
  if (!antibioticDiscussionAllowed && (assessment.band === 'high' || assessment.febrile) && assessment.culture.status === 'none') {
    flags.push('empiric-antibiotic-without-culture');
  }
  const escalateNow = !blocked && (assessment.febrile && (assessment.band === 'high' || (assessment.measured.nlr ?? 0) >= INFECTION_REFERENCE.nlrHigh));

  const blockReason = !blocked
    ? null
    : flags.includes('no-temperature')
      ? 'No temperature is on file — the triage has nothing to screen with.'
      : `Only ${series.length} temperature reading(s) — ${INFECTION_REFERENCE.minTemperatureReadings} are needed (a single reading is never a trend).`;

  return {
    flags,
    blocked,
    blockReason,
    cultureAllowed: !blocked && assessment.culture.status === 'none' && (assessment.febrile || assessment.band !== 'low'),
    antibioticDiscussionAllowed,
    escalateNow,
    requiresCultureFirst,
  };
}

/* ======================================================================
 * 5. Reference surrogate — bounded recommendation
 * ====================================================================== */

export type InfectionAction =
  | 'continue'
  | 'temperature-surveillance'
  | 'blood-culture-order'
  | 'culture-then-antibiotic-discussion'
  | 'empiric-antibiotic-discussion'
  | 'isolation-review'
  | 'catheter-removal-escalation'
  | 'vaccination-outreach'
  | 'serology-followup'
  | 'access-care-review'
  | 'audit-task'
  | 'urgent-clinical-review'
  | 'blocked';

/**
 * The deterministic half needs no model, but it still has a clinical PRIORITY: a
 * patient-level obligation (protection from infection, device removal) outranks a
 * unit-level audit. The headline action is chosen from this order when the triage
 * itself is quiet.
 */
export const INFECTION_PREVENTION_PRIORITY: readonly PreventionTaskKind[] = [
  'vaccination-due',
  'immunisation-series-incomplete',
  'serology-followup',
  'catheter-escalation',
  'access-care-review',
  'audit-due',
];

const PREVENTION_ACTION: Record<PreventionTaskKind, InfectionAction> = {
  'vaccination-due': 'vaccination-outreach',
  'immunisation-series-incomplete': 'vaccination-outreach',
  'serology-followup': 'serology-followup',
  'catheter-escalation': 'catheter-removal-escalation',
  'access-care-review': 'access-care-review',
  'audit-due': 'audit-task',
};

export interface InfectionRecommendation {
  patientId: string;
  guardrails: InfectionGuardResult;
  latent: ReturnType<typeof infectionLatent>;
  assessment: BsiAssessment;
  /** the DETERMINISTIC prevention half — computed without any model input */
  prevention: PreventionTask[];
  current: {
    temperatureC?: number | undefined;
    peakTemperatureC?: number | undefined;
    procalcitoninNgMl?: number | undefined;
    nlr?: number | undefined;
    accessType?: string | undefined;
    catheterDays?: number | undefined;
    cultureStatus: string;
  };
  action: InfectionAction;
  plan: InfectionAction[];
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: 'reference-surrogate' | 'trained' };
  synthetic: boolean;
  /** what the platform is allowed to do — none of it is antimicrobial */
  authority: { antimicrobial: 'none'; cultureOrder: 'proposal-class-c'; isolation: 'proposal-class-c'; authority: 'none' };
  note: string;
}

export const INFECTION_ADVISOR_MODEL = { id: 'infection.bsi-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

export function infectionRecommend(input: InfectionInput, now: () => string = () => new Date().toISOString()): InfectionRecommendation {
  const guardrails = guardInfectionTriage(input);
  const latent = infectionLatent(input);
  const assessment = assessBsi(input);
  // The prevention plan is computed from records + rules only. No model output
  // reaches it — that separation is the point of P6 and is asserted in tests.
  const prevention = preventionPlan(input, now);

  const plan: InfectionAction[] = [];
  let action: InfectionAction = 'continue';
  let note = '';

  // ---- The deterministic half ALWAYS runs. It is not a fallback: a quiet
  // triage must not hide an overdue vaccination, a stale serology or 200
  // catheter days, because none of those depend on a model's opinion.
  const preventionActions = [...prevention]
    .sort((a, b) => INFECTION_PREVENTION_PRIORITY.indexOf(a.kind) - INFECTION_PREVENTION_PRIORITY.indexOf(b.kind))
    .map((t) => PREVENTION_ACTION[t.kind]);

  if (guardrails.blocked) {
    action = 'blocked';
    note = guardrails.blockReason ?? 'Blocked by guardrails.';
  } else if (assessment.febrile || assessment.band === 'high') {
    if (assessment.culture.status === 'none') {
      action = guardrails.escalateNow ? 'urgent-clinical-review' : 'blood-culture-order';
      plan.push('blood-culture-order');
      note = `Temperature ${assessment.measured.peakTemperatureC ?? '—'} °C with a triage score of ${assessment.probability} (${assessment.band}) — order blood cultures from two sites and escalate to the clinical team for review. An empiric-antimicrobial discussion is NOT proposed until a culture exists: culture-before-antibiotic is a rule here, not a preference.`;
    } else if (assessment.culture.status === 'positive') {
      action = 'culture-then-antibiotic-discussion';
      plan.push('culture-then-antibiotic-discussion', 'isolation-review');
      note = `Blood culture positive with a triage score of ${assessment.probability} — the culture is on file, so an empiric-antimicrobial DISCUSSION (Class C, infectious-diseases/renal team) and an isolation review are proposed. The platform orders no antimicrobial: the drug, the dose and the duration are prescriber decisions.`;
    } else {
      action = 'isolation-review';
      plan.push('isolation-review');
      note = `Temperature ${assessment.measured.peakTemperatureC ?? '—'} °C with a recent negative culture (${assessment.culture.at ?? 'on file'}) — review the source outside the bloodstream (access site, lung, urine, line) and re-culture if the fever persists beyond ${INFECTION_REFERENCE.cultureTurnaroundHours} h.`;
    }
    if (input.accessType === 'catheter') {
      plan.push('catheter-removal-escalation');
      note += ` Catheter access with ${input.catheterDays ?? 0} catheter-day(s) — the catheter is a candidate source and removal escalation is proposed (access team decision).`;
    }
  } else if (assessment.band === 'watch' && prevention.length === 0) {
    // A watch-band triage with nothing deterministic outstanding is surveillance;
    // with prevention due, the deterministic obligation takes the headline below.
    action = 'temperature-surveillance';
    plan.push('temperature-surveillance');
    note = `Triage score ${assessment.probability} (watch) on ${assessment.temperatureReadings} reading(s) — intensify temperature surveillance and repeat the inflammatory markers; no culture is indicated yet.`;
  }

  if (action !== 'blocked') {
    if (action === 'continue' || action === 'temperature-surveillance') {
      const headline = preventionActions[0];
      if (headline !== undefined) {
        action = headline;
        const lead = prevention.find((t) => PREVENTION_ACTION[t.kind] === headline)!;
        note = [
          action === 'temperature-surveillance' ? note : '',
          `${prevention.length} deterministic prevention obligation(s) are outstanding, led by "${lead.label}": ${lead.because}`,
          `Every prevention task is generated from the records by the CDC rule set — no model output is involved, and the same records always produce the same tasks (plan signature ${preventionDeterminismSignature(prevention)}).`,
        ].filter(Boolean).join(' ');
      }
    }
    // Always carry the deterministic work in the plan, whatever the triage says.
    for (const a of preventionActions) if (!plan.includes(a)) plan.push(a);
    if (prevention.length > 0) {
      const overdue = prevention.filter((t) => t.overdue).length;
      if (!note.includes('deterministic prevention obligation')) {
        note += ` Besides the triage conclusion, ${prevention.length} deterministic prevention task(s) are outstanding (${overdue} overdue) — the prevention schedule is computed from the records by rules and never from a model.`;
      }
    } else if (action === 'continue') {
      note = 'Temperature, inflammatory markers and access state are within the surveillance range, and no immunisation, serology, audit or catheter-day obligation is outstanding — continue routine screening.';
    }
  }

  return {
    patientId: input.patientId,
    guardrails,
    latent,
    assessment,
    prevention,
    current: {
      temperatureC: assessment.measured.temperatureC,
      peakTemperatureC: assessment.measured.peakTemperatureC,
      procalcitoninNgMl: assessment.measured.procalcitoninNgMl,
      nlr: assessment.measured.nlr,
      accessType: input.accessType,
      catheterDays: input.catheterDays,
      cultureStatus: assessment.culture.status,
    },
    action,
    plan: [...new Set(plan)],
    drivers: INFECTION_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance })).sort((a, b) => b.relevance - a.relevance),
    model: INFECTION_ADVISOR_MODEL,
    synthetic: true,
    authority: { antimicrobial: 'none', cultureOrder: 'proposal-class-c', isolation: 'proposal-class-c', authority: 'none' },
    note,
  };
}

/* ======================================================================
 * 6. Bounded cells + durable episodes
 * ====================================================================== */

export const INFECTION_CELLS: CellManifest[] = [
  {
    id: 'bsi-triage',
    version: '0.1.0',
    displayName: 'Bloodstream-infection triage',
    domain: 'patient-care',
    owner: 'Nephrology · dialysis unit',
    consumes: ['vital.observed', 'lab.result-arrived', 'safety.flagged'],
    produces: ['infection.bsi.proposal'],
    allowedActions: ['order-lab', 'notify-staff', 'update-care-plan', 'flag-safety-event'],
    approvalClass: 'C',
    evalGate: 0.85,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.7 · BSI triage (XGBoost + SHAP), culture-before-antibiotic',
  },
  {
    id: 'infection-prevention',
    version: '0.1.0',
    displayName: 'Infection prevention & immunisation',
    domain: 'quality',
    owner: 'Infection prevention · dialysis unit',
    consumes: ['immunization.recorded', 'lab.result-arrived', 'assessment.response.v1', 'access.observed.v1'],
    produces: ['infection.prevention.task'],
    allowedActions: ['order-lab', 'record-assessment', 'notify-staff', 'update-care-plan', 'schedule-followup'],
    approvalClass: 'B',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.7 · CDC core interventions as deterministic state machines — never ML',
  },
];

export const INFECTION_CONSUMED_BY: Record<string, string[]> = {
  'infection.bsi.proposal': ['bsi-triage', 'infection-prevention'],
  'infection.prevention.task': ['infection-prevention'],
};

export const INFECTION_EPISODE_KINDS = ['infection.bsi-triage', 'infection.prevention-task'] as const;

export interface InfectionDemoState {
  source: 'infection';
  features: readonly InfectionFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  kpis: {
    /** febrile episodes detected in the illustrative window */
    febrileEpisodes: number;
    culturesProposed: number;
    preventionTasksDue: number;
    vaccinationsDue: number;
    auditsOverdue: number;
    catheterEscalations: number;
  };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

/** A febrile catheter patient: the highest-value triage case. */
export const INFECTION_DEMO_WINDOW: InfectionInput = {
  patientId: 'p-bsi-1',
  temperatureC: 38.6,
  temperatureSeries: [36.9, 37.4, 38.6],
  procalcitoninNgMl: 2.8,
  neutrophilPct: 84,
  lymphocytePct: 9,
  wbc: 14.2,
  crp: 96,
  albumin: 3.1,
  accessType: 'catheter',
  catheterDays: 142,
  accessAgeDays: 142,
  matureAvfAvailable: true,
  accessInfectionSigns: true,
  symptoms: ['rigors', 'hypotension'],
  hospitalisedLast30d: true,
  dialysisVintageYears: 7,
  immunisations: [{ vaccine: 'influenza', seriesDose: 1, seriesTotal: 1, at: '2025-10-02T09:00:00Z' }],
  hepatitisBSurfaceAntibodyIuL: 6,
  serologyAt: '2025-11-01T09:00:00Z',
  lastHandHygieneAuditAt: '2026-05-20T09:00:00Z',
  lastAccessCareAuditAt: '2026-06-02T09:00:00Z',
  asOf: '2026-09-10T09:00:00Z',
};

export function buildInfectionDemo(now: () => string = NOW): Omit<InfectionDemoState, 'episodes'> {
  const triage = infectionRecommend(INFECTION_DEMO_WINDOW, now);
  const prevention = triage.prevention;
  const vaccination = prevention.filter((t) => t.kind === 'vaccination-due');
  const audits = prevention.filter((t) => t.kind === 'audit-due');

  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'bsi-triage', kind: 'infection.bsi.proposal', subject: 'patient:p-bsi-1', scopeType: 'patient',
      option: 'blood cultures + urgent clinical review', approvalClass: 'C',
      recommendation: `Patient p-bsi-1: temperature 38.6 °C (peak of 3 readings), procalcitonin ${triage.assessment.measured.procalcitoninNgMl} ng/mL, NLR ${triage.assessment.measured.nlr}, on a catheter for 142 days with exit-site signs. Triage score ${triage.assessment.probability} (${triage.assessment.band}); the catheter is the leading source hypothesis. Order cultures from two sites and escalate for review — no antimicrobial is proposed before a culture exists. Class C human decision.`,
      allowed: true, evidence: [ev('vital.observed:p-bsi-1', 'event'), ev('lab.result-arrived:p-bsi-1', 'event')],
      producedAt: now(), payload: { triage: triage.assessment.probability, band: triage.assessment.band, catheterDays: 142 },
    }),
    makeProposal({
      cellId: 'infection-prevention', kind: 'infection.prevention.task', subject: 'patient:p-bsi-1', scopeType: 'patient',
      option: 'immunisation catch-up + overdue audits', approvalClass: 'B',
      recommendation: `${vaccination.length} immunisation(s) due and ${audits.length} prevention audit(s) overdue for p-bsi-1. Every task is generated by the deterministic CDC rule set from the immunisation and audit records — no model output is involved, and the same records always produce the same tasks.`,
      allowed: true, evidence: [ev('immunization.recorded:p-bsi-1', 'fact'), ev('assessment.response.v1:p-bsi-1', 'fact')],
      producedAt: now(), payload: { due: prevention.length },
    }),
    makeProposal({
      cellId: 'infection-prevention', kind: 'infection.prevention.task', subject: 'patient:p-bsi-2', scopeType: 'patient',
      option: 'catheter removal escalation', approvalClass: 'B',
      recommendation: 'Patient p-bsi-2 has 187 catheter days with a mature AVF patent for 96 days — the CDC catheter-day rule proposes removal escalation to the access team (deterministic, no model).',
      allowed: true, evidence: [ev('access.observed.v1:p-bsi-2', 'fact')],
      producedAt: now(), payload: { catheterDays: 187, matureAvfDays: 96 },
    }),
  ];

  const insights = aggregateSwarmInsights({ proposals, consumedBy: INFECTION_CONSUMED_BY });
  const nbaCandidates: NbaCandidate[] = [
    {
      title: 'Order blood cultures (two sites)', cells: ['bsi-triage'], scopeType: 'patient', subject: 'patient:p-bsi-1',
      owner: 'nurse', due: 'today', evidence: [ev('vital.observed:p-bsi-1', 'event'), ev('lab.result-arrived:p-bsi-1', 'event')],
      consensus: insights[0]?.consensus ?? 0.75, approvalClass: 'C', expectedOutcome: 42, urgency: 0.95, policyCost: 0.2, risk: 0.05,
      insightKind: 'infection.bsi.proposal',
    },
    {
      title: 'Escalate catheter removal to the access team', cells: ['infection-prevention'], scopeType: 'patient', subject: 'patient:p-bsi-2',
      owner: 'access-team', due: 'this week', evidence: [ev('access.observed.v1:p-bsi-2', 'fact')],
      consensus: 0.8, approvalClass: 'B', expectedOutcome: 31, urgency: 0.7, policyCost: 0.3, risk: 0.1,
      insightKind: 'infection.prevention.task',
    },
    {
      title: 'Immunisation catch-up outreach', cells: ['infection-prevention'], scopeType: 'patient', subject: 'patient:p-bsi-1',
      owner: 'infection-prevention', due: 'this month', evidence: [ev('immunization.recorded:p-bsi-1', 'fact')],
      consensus: 0.9, approvalClass: 'B', expectedOutcome: 18, urgency: 0.35, policyCost: 0.1, risk: 0.02,
      insightKind: 'infection.prevention.task',
    },
    {
      title: 'Complete overdue hand-hygiene / access-care audits', cells: ['infection-prevention'], scopeType: 'facility', subject: 'facility:unit-A',
      owner: 'infection-prevention', due: 'this month', evidence: [ev('assessment.response.v1:unit-A', 'fact')],
      consensus: 0.85, approvalClass: 'B', expectedOutcome: 12, urgency: 0.3, policyCost: 0.1, risk: 0.01,
      insightKind: 'infection.prevention.task',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(nbaCandidates, insights), { limit: 4, beliefAware: true });

  return {
    source: 'infection',
    features: INFECTION_FEATURES,
    cells: INFECTION_CELLS,
    proposals,
    insights: insights,
    nbas,
    conflictCount: insights.filter((i) => i.retained).length,
    kpis: {
      febrileEpisodes: 1,
      culturesProposed: 1,
      preventionTasksDue: prevention.length,
      vaccinationsDue: vaccination.length,
      auditsOverdue: audits.length,
      catheterEscalations: prevention.filter((t) => t.kind === 'catheter-escalation').length,
    },
  };
}

export function infectionEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (INFECTION_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/**
 * Seed one triage episode (Class C, awaiting approval) and one fully closed
 * prevention loop (Class B) — the same durable coordinator as every other pack.
 */
export async function seedInfectionEpisodes(
  coordinator: PersistentOutcomeCoordinator,
  _ws?: SwarmWorkspaceStore,
  now: () => string = NOW,
): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  // identity check INCLUDING terminal episodes so a resolved episode is not
  // re-churned on every re-seed (getOrOpen excludes terminal states)
  const find = (kind: string, subject: string): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === kind && e.subject === subject && e.scopeType === 'patient');

  const triageSubject = 'patient:p-bsi-1';
  const priorTriage = find('infection.bsi-triage', triageSubject);
  if (!priorTriage) {
    const rec = infectionRecommend(INFECTION_DEMO_WINDOW, now);
    const e = coordinator.open({ kind: 'infection.bsi-triage', subject: triageSubject, scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('vital.observed:p-bsi-1', 'event'), ev('lab.result-arrived:p-bsi-1', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'bsi-triage', kind: 'infection.bsi.proposal', subject: e.subject, scopeType: 'patient',
      option: rec.action, approvalClass: 'C',
      recommendation: rec.note, allowed: true,
      evidence: [ev('vital.observed:p-bsi-1', 'event'), ev('lab.result-arrived:p-bsi-1', 'event')],
      producedAt: now(), payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(priorTriage.episodeId);
  }

  const preventionSubject = 'patient:p-bsi-3';
  const priorPrevention = find('infection.prevention-task', preventionSubject);
  if (!priorPrevention) {
    const e = coordinator.open({ kind: 'infection.prevention-task', subject: preventionSubject, scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('immunization.recorded:p-bsi-3', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'infection-prevention', kind: 'infection.prevention.task', subject: e.subject, scopeType: 'patient',
      option: 'influenza immunisation outreach', approvalClass: 'B',
      recommendation: 'Influenza immunisation is due under the deterministic prevention schedule — outreach task; the record is written only after the vaccination is given.',
      allowed: true, evidence: [ev('immunization.recorded:p-bsi-3', 'fact')], producedAt: now(), payload: { task: 'vaccination-due' },
    }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Infection prevention lead', 'B');
    coordinator.dispatchCommand(e.episodeId, 'schedule-followup');
    coordinator.acknowledge(e.episodeId, 'patient:p-bsi-3');
    coordinator.verify(e.episodeId, { measureId: 'cdc.influenza-vaccination', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(priorPrevention.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY infection episodes. */
export async function dropInfectionEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = infectionEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

export const INFECTION_REFERENCE_SUMMARY = {
  triage: {
    feverC: INFECTION_REFERENCE.feverC,
    lowGradeFeverC: INFECTION_REFERENCE.lowGradeFeverC,
    procalcitonin: { watch: INFECTION_REFERENCE.procalcitoninWatchNgMl, high: INFECTION_REFERENCE.procalcitoninHighNgMl },
    nlr: { watch: INFECTION_REFERENCE.nlrWatch, high: INFECTION_REFERENCE.nlrHigh },
    riskBands: INFECTION_REFERENCE.riskBands,
    cultureTurnaroundHours: INFECTION_REFERENCE.cultureTurnaroundHours,
  },
  prevention: {
    catheterEscalationDays: INFECTION_REFERENCE.catheterEscalationDays,
    matureAccessDays: INFECTION_REFERENCE.matureAccessDays,
  },
  authority: INFECTION_ANTIMICROBIAL_AUTHORITY,
} as const;

export { preventionPlan, type PreventionTask };
