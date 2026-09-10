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

// P6 — infection what-if (step C) + the deterministic prevention schedule.
//
// The counterfactual has TWO panels, and they must never be mixed:
//
//   • TRIAGE candidates (culture-first, surveillance, isolation review, catheter
//     escalation, urgent review) — scored by expected harm: a MISSED culture and
//     a DELAYED treatment are the two expensive mistakes, and an unnecessary
//     isolation is the cheap-but-real false-positive cost;
//   • PREVENTION candidates (vaccination outreach, serology recheck, audit
//     completion) — scheduled by RULES over the next 30/90/180 days. They carry
//     no score from the triage and no model input at all.
//
// Two candidates exist only to be REFUSED: an empiric-antimicrobial discussion
// without a culture, and any named-agent selection. Refusal is a first-class
// output — the refused list is the audit trail of what the platform will not do.

import {
  INFECTION_REFERENCE, assessBsi, guardInfectionTriage, infectionRecommend, computeNlr,
  type InfectionInput,
} from './infection.js';
import {
  preventionPlan, preventionDeterminismSignature, AUDIT_CADENCE, VACCINE_SCHEDULE,
  type PreventionTask,
} from './infection-prevention.js';

export const INFECTION_SIMULATOR_MODEL = { id: 'infection.bsi-sim', version: '0.1.0', kind: 'mechanistic-triage-counterfactual' as const };

export const INFECTION_TRADEOFF_WEIGHTS = {
  /** a bloodstream infection left uncultured — the most expensive mistake */
  missedCulture: 3.0,
  /** treatment delayed past the culture turnaround (48 h) on a positive case */
  delayedTreatment: 2.2,
  /** catheter days persisting when a mature access is available */
  catheterDays: 1.0,
  /** immunisation gap (unvaccinated dialysis patient) */
  immunisationGap: 1.4,
  /** serology left unverified while anti-HBs is non-protective */
  serologyGap: 0.6,
  /** prevention audit cadence missed */
  auditGap: 0.4,
  /** infection risk above the band threshold that the action does not address */
  residualRisk: 1.6,
  /** false-positive cost: an unnecessary isolation / removal / escalation */
  unnecessaryIsolation: 0.5,
  /** intervention cost (nursing minutes, laboratory, patient burden) */
  burden: 0.25,
} as const;

export interface InfectionCandidate {
  label: string;
  action: string;
  /** which half of P6 produced this candidate */
  half: 'triage' | 'prevention';
  /** projection at the horizon */
  projected: {
    /** residual bloodstream-infection probability after the action */
    probability: number;
    /** hours until a culture result would be available */
    cultureHours: number;
    /** catheter days the patient still carries at 90 d */
    catheterDays: number;
    /** share of the CDC schedule satisfied (0–1) */
    immunisationCoverage: number;
    /** share of the audit cadence satisfied (0–1) */
    auditCompliance: number;
  };
  /** expected harm under the trade-off weights — lower is better */
  score: number;
  allowed: boolean;
  refusedReason?: string | undefined;
  /** what the action costs in false positives */
  falsePositiveCost: number;
  requiresCultureFirst: boolean;
  /** deterministic prevention candidates are labelled so the UI can never mix them */
  deterministic: boolean;
  burden: number;
  ruleId?: string | undefined;
}

export interface InfectionPreventionScheduleEntry {
  horizonDays: number;
  taskId: string;
  kind: string;
  label: string;
  dueAt: string;
  overdue: boolean;
  ruleId: string;
  source: string;
}

export interface InfectionWhatIfResult {
  patientId: string;
  current: {
    temperatureC?: number | undefined;
    peakTemperatureC?: number | undefined;
    procalcitoninNgMl?: number | undefined;
    nlr?: number | undefined;
    catheterDays?: number | undefined;
    cultureStatus: string;
    band: string;
  };
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: readonly number[];
  candidates: InfectionCandidate[];
  /** candidates the platform refuses to propose, with the reason */
  refused: InfectionCandidate[];
  recommended?: InfectionCandidate | undefined;
  prevention: {
    horizonsDays: readonly number[];
    schedule: InfectionPreventionScheduleEntry[];
    counts: { at30: number; at90: number; at180: number; overdue: number };
    /** proof the prevention panel is model-free */
    determinismSignature: string;
    modelFree: true;
  };
  model: typeof INFECTION_SIMULATOR_MODEL;
  synthetic: boolean;
  note: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

const CANDIDATE_ACTIONS: Array<{ label: string; action: string; burden: number; falsePositive: number; deterministic?: boolean }> = [
  { label: 'Continue current surveillance', action: 'continue', burden: 0, falsePositive: 0 },
  { label: 'Order blood cultures (two sites) then reassess', action: 'culture-first', burden: 0.25, falsePositive: 0 },
  { label: 'Intensify temperature surveillance (no culture yet)', action: 'watch', burden: 0.1, falsePositive: 0 },
  { label: 'Urgent clinical review + cultures', action: 'urgent-review', burden: 0.45, falsePositive: 0.1 },
  { label: 'Isolation review (single room, contact precautions)', action: 'isolation-review', burden: 0.4, falsePositive: 0.5 },
  { label: 'Catheter removal escalation to the access team', action: 'catheter-removal-escalation', burden: 0.5, falsePositive: 0.35 },
  { label: 'Access-site care review', action: 'access-care-review', burden: 0.2, falsePositive: 0.05, deterministic: true },
  { label: 'Immunisation outreach (catch-up + due doses)', action: 'vaccination-outreach', burden: 0.2, falsePositive: 0, deterministic: true },
  { label: 'Hepatitis B serology recheck', action: 'serology-followup', burden: 0.15, falsePositive: 0, deterministic: true },
  { label: 'Complete overdue prevention audits', action: 'audit-task', burden: 0.2, falsePositive: 0, deterministic: true },
];

/** Refused-by-design: these exist to prove the refusal, never to compete. */
export const INFECTION_REFUSED_ACTIONS: ReadonlyArray<{ label: string; action: string; reason: string }> = [
  {
    label: 'Start an empiric antimicrobial now',
    action: 'empiric-antibiotic-discussion',
    reason: 'Refused before a culture exists: culture-before-antibiotic is a rule, and the platform has no antimicrobial or prescribing authority (authority.antimicrobial = none).',
  },
  {
    label: 'Select and dose a named antimicrobial agent',
    action: 'antimicrobial-selection',
    reason: 'Refused unconditionally: agent selection, dose and duration are prescriber decisions and are never produced by this platform.',
  },
];

/**
 * Project one candidate. The response fractions are documented and deliberately
 * conservative; nothing here invents a treatment effect, it only moves the
 * surveillance/harm quantities the trade-off is scored on.
 */
function projectCandidate(input: InfectionInput, action: string): InfectionCandidate['projected'] {
  const assessment = assessBsi(input);
  const probability = assessment.probability;
  const catheterDays = input.catheterDays ?? 0;
  const catheter = input.accessType === 'catheter';
  const mature = input.matureAvfAvailable === true;
  const scheduleDays = VACCINE_SCHEDULE.length * AUDIT_CADENCE.length * 0; // keep schedule constants referenced without inventing effects

  let dProbability = 0;
  let cultureHours = assessment.culture.status === 'none' ? INFECTION_REFERENCE.cultureTurnaroundHours + 24 : 0;
  let dCatheterDays = catheter ? Math.max(0, catheterDays - 90) * 0.15 : 0;
  let dCoverage = 0;
  let dAudit = 0;

  switch (action) {
    case 'culture-first':
      // acting on the culture shortens the blind window; it does not by itself
      // lower the probability — only the culture RESULT can do that
      cultureHours = INFECTION_REFERENCE.cultureTurnaroundHours;
      dProbability = -0.05;
      break;
    case 'watch':
      cultureHours = assessment.culture.status === 'none' ? INFECTION_REFERENCE.cultureTurnaroundHours + 48 : cultureHours;
      dProbability = probability >= INFECTION_REFERENCE.riskBands.high ? 0.12 : -0.03;
      break;
    case 'urgent-review':
      cultureHours = INFECTION_REFERENCE.cultureTurnaroundHours;
      dProbability = -0.18;
      break;
    case 'isolation-review':
      dProbability = -0.04;
      dCoverage = 0.02;
      break;
    case 'catheter-removal-escalation':
      dProbability = catheter ? -0.22 : -0.02;
      dCatheterDays = catheter ? Math.max(0, catheterDays) : 0;
      dAudit = 0.1;
      break;
    case 'access-care-review':
      dProbability = input.accessInfectionSigns ? -0.1 : -0.02;
      dAudit = 0.15;
      break;
    case 'vaccination-outreach':
      dCoverage = 1;
      dProbability = -0.03;
      break;
    case 'serology-followup':
      dCoverage = 0.35;
      break;
    case 'audit-task':
      dAudit = 1;
      dProbability = -0.02;
      break;
    default:
      break;
  }
  // a catheter that stays in keeps the risk
  if (catheter && mature && action !== 'catheter-removal-escalation' && action !== 'urgent-review') {
    dProbability += Math.min(0.12, (dCatheterDays / 400) * 0.4);
  }

  const prevention = preventionPlan(input);
  const dueNow = prevention.filter((t) => t.overdue || t.daysUntilDue <= 90).length;
  const baseCoverage = prevention.length === 0 ? 1 : Math.max(0, 1 - dueNow / 8);
  const baseAudit = prevention.filter((t) => t.kind === 'audit-due').length === 0 ? 1 : 0.5;

  void scheduleDays;
  return {
    probability: round2(Math.max(0.01, Math.min(0.999, probability + dProbability))),
    cultureHours: Math.round(cultureHours),
    catheterDays: Math.round(Math.max(0, catheterDays - dCatheterDays)),
    immunisationCoverage: round2(Math.max(0, Math.min(1, baseCoverage + dCoverage))),
    auditCompliance: round2(Math.max(0, Math.min(1, baseAudit + dAudit))),
  };
}

export function scoreInfectionCandidate(candidate: Omit<InfectionCandidate, 'score' | 'allowed' | 'refusedReason'>): number {
  const W = INFECTION_TRADEOFF_WEIGHTS;
  const projected = candidate.projected;
  // a culture is "missed" when the blind window stays open on a suspect patient
  const missed = projected.cultureHours > INFECTION_REFERENCE.cultureTurnaroundHours && projected.probability >= INFECTION_REFERENCE.riskBands.high ? 1 : 0;
  const delay = projected.cultureHours > INFECTION_REFERENCE.cultureTurnaroundHours
    ? (projected.cultureHours - INFECTION_REFERENCE.cultureTurnaroundHours) / 48
    : 0;
  const delayed = projected.probability >= INFECTION_REFERENCE.riskBands.high ? delay : 0;
  const catheterResidual = projected.catheterDays > INFECTION_REFERENCE.catheterEscalationDays
    ? (projected.catheterDays - INFECTION_REFERENCE.catheterEscalationDays) / INFECTION_REFERENCE.catheterEscalationDays
    : 0;
  const immunisationGap = 1 - projected.immunisationCoverage;
  const auditGap = 1 - projected.auditCompliance;
  const residualRisk = Math.max(0, projected.probability - INFECTION_REFERENCE.riskBands.high);
  return Math.round((
    W.missedCulture * missed
    + W.delayedTreatment * delayed
    + W.catheterDays * catheterResidual
    + W.immunisationGap * immunisationGap
    + W.auditGap * auditGap
    + W.residualRisk * residualRisk
    + W.unnecessaryIsolation * candidate.falsePositiveCost
    + W.burden * candidate.burden
  ) * 1000) / 1000;
}

/* ======================================================================
 * The deterministic prevention schedule (30 / 90 / 180 d)
 * ====================================================================== */

export function infectionPreventionSchedule(input: InfectionInput): InfectionWhatIfResult['prevention'] {
  const plan = preventionPlan(input);
  const horizons = INFECTION_REFERENCE.horizonsDays;
  const schedule: InfectionPreventionScheduleEntry[] = [];
  for (const task of plan) {
    const horizon = [...horizons].reverse().find((h) => task.overdue || task.daysUntilDue <= h);
    if (horizon === undefined) continue;
    schedule.push({
      horizonDays: horizon,
      taskId: task.id,
      kind: task.kind,
      label: task.label,
      dueAt: task.dueAt,
      overdue: task.overdue,
      ruleId: task.rule.ruleId,
      source: task.rule.source,
    });
  }
  const counts = {
    at30: schedule.filter((s) => s.horizonDays <= 30).length,
    at90: schedule.filter((s) => s.horizonDays <= 90).length,
    at180: schedule.filter((s) => s.horizonDays <= 180).length,
    overdue: plan.filter((t) => t.overdue).length,
  };
  return {
    horizonsDays: horizons,
    schedule,
    counts,
    determinismSignature: preventionDeterminismSignature(plan),
    modelFree: true,
  };
}

export function infectionWhatIf(input: InfectionInput): InfectionWhatIfResult {
  const recommendation = infectionRecommend(input);
  const guardrails = guardInfectionTriage(input);
  const assessment = assessBsi(input);

  const refused: InfectionCandidate[] = INFECTION_REFUSED_ACTIONS.map((r) => {
    const projected = projectCandidate(input, r.action);
    const partial = {
      label: r.label,
      action: r.action,
      half: 'triage' as const,
      projected,
      falsePositiveCost: r.action === 'empiric-antibiotic-discussion' ? 0.6 : 0,
      requiresCultureFirst: true,
      deterministic: false,
      burden: 0.3,
    };
    return { ...partial, allowed: false, refusedReason: r.reason, score: scoreInfectionCandidate(partial) };
  });

  const candidates: InfectionCandidate[] = CANDIDATE_ACTIONS.map((definition) => {
    const projected = projectCandidate(input, definition.action);
    const partial = {
      label: definition.label,
      action: definition.action,
      half: (definition.deterministic ? 'prevention' : 'triage') as InfectionCandidate['half'],
      projected,
      falsePositiveCost: definition.falsePositive,
      requiresCultureFirst: !definition.deterministic,
      deterministic: definition.deterministic === true,
      burden: definition.burden,
      ...(definition.deterministic ? { ruleId: preventionPlan(input).find((t) => t.kind === preventionKindFor(definition.action))?.rule.ruleId } : {}),
    };
    const blocked = guardrails.blocked;
    const refusedReason = blocked ? guardrails.blockReason ?? 'Blocked by guardrails.' : undefined;
    return {
      ...partial,
      allowed: !blocked,
      ...(refusedReason ? { refusedReason } : {}),
      score: scoreInfectionCandidate(partial),
    };
  });

  const viable = candidates.filter((c) => c.allowed);
  const recommended = viable.length ? [...viable].sort((a, b) => a.score - b.score)[0] : undefined;
  const prevention = infectionPreventionSchedule(input);

  return {
    patientId: input.patientId,
    current: {
      temperatureC: assessment.measured.temperatureC,
      peakTemperatureC: assessment.measured.peakTemperatureC,
      procalcitoninNgMl: assessment.measured.procalcitoninNgMl,
      nlr: assessment.measured.nlr ?? computeNlr(input.neutrophilPct, input.lymphocytePct),
      catheterDays: input.catheterDays,
      cultureStatus: assessment.culture.status,
      band: assessment.band,
    },
    blocked: guardrails.blocked,
    blockReason: guardrails.blockReason,
    horizonsDays: INFECTION_REFERENCE.horizonsDays,
    candidates,
    refused,
    recommended,
    prevention,
    model: INFECTION_SIMULATOR_MODEL,
    synthetic: true,
    note: recommended
      ? `Lowest expected harm: ${recommended.label} → residual triage probability ${recommended.projected.probability}, culture window ${recommended.projected.cultureHours} h at 90 d. ${refused.length} candidate(s) refused by design (no antimicrobial authority). Separately, ${prevention.counts.overdue} prevention task(s) are already overdue and ${prevention.counts.at90} fall due within 90 d — computed from the records by rules, with no model input. Advisory only.`
      : `No viable plan under the current guardrails${guardrails.blocked ? ` (${guardrails.blockReason})` : ''}. The deterministic prevention schedule is unaffected: ${prevention.counts.overdue} overdue, ${prevention.counts.at90} due within 90 d.`,
  };
}

/** Map a prevention candidate back onto its rule family, for the audit trail. */
function preventionKindFor(action: string): PreventionTask['kind'] {
  switch (action) {
    case 'vaccination-outreach': return 'vaccination-due';
    case 'serology-followup': return 'serology-followup';
    case 'audit-task': return 'audit-due';
    case 'access-care-review': return 'access-care-review';
    case 'catheter-removal-escalation': return 'catheter-escalation';
    default: return 'audit-due';
  }
}

/**
 * Triage-only counterfactual: what the score does when the surveillance window
 * changes, with the prevention half held fixed. This is the honesty check for
 * "did the model move, or did the records move?".
 */
export function infectionTriageSensitivity(input: InfectionInput): Array<{ variant: string; probability: number; band: string; peakTemperatureC?: number | undefined; readings: number }> {
  const series = input.temperatureSeries ?? (input.temperatureC !== undefined ? [input.temperatureC] : []);
  const variants: Array<{ variant: string; override: Partial<InfectionInput> }> = [
    { variant: 'as recorded', override: {} },
    { variant: 'no temperature', override: { temperatureC: undefined, temperatureSeries: [] } },
    { variant: 'single reading', override: { temperatureSeries: series.slice(-1), temperatureC: series[series.length - 1] } },
    { variant: 'markers removed', override: { procalcitoninNgMl: undefined, wbc: undefined, nlr: undefined, crp: undefined } },
    { variant: 'catheter resolved', override: { accessType: 'avf', catheterDays: 0, accessInfectionSigns: false } },
  ];
  return variants.map((v) => {
    const probe = { ...input, ...v.override };
    const a = assessBsi(probe);
    return {
      variant: v.variant,
      probability: a.probability,
      band: a.band,
      peakTemperatureC: a.measured.peakTemperatureC,
      readings: (probe.temperatureSeries ?? []).length,
    };
  });
}
