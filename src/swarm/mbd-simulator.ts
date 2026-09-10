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

// P4 step C — CKD-MBD therapy "what-if": candidate therapy levers projected
// through the coupled responder at 30/60/90 days, scored on the KDIGO targets
// with hypocalcaemia risk weighted explicitly. Any candidate whose projection
// leaves the safety envelope is refused, not merely penalised.

import {
  MBD_REFERENCE, mbdContractViolations, mbdRecommend, projectMbdTherapy, guardMbdTherapy,
  type MbdCoupledInput, type MbdTherapyState,
} from './mbd.js';

export const MBD_SIMULATOR_MODEL = { id: 'mbd.therapy-sim', version: '0.1.0', kind: 'coupled-mechanistic-counterfactual' as const };

export const MBD_TRADEOFF_WEIGHTS = {
  /** phosphate above the target at 90 days */
  phosphateOutOfRange: 1.2,
  /** PTH above/below the KDIGO range at 90 days */
  pthOutOfRange: 1.0,
  /** hypercalcaemia is the feared harm — weighted hardest */
  hypercalcemia: 1.5,
  /** hypocalcaemia from calcimimetics */
  hypocalcemia: 1.4,
  /** daily pill/dose burden */
  pillBurden: 0.2,
} as const;

export interface MbdCandidate {
  label: string;
  action: string;
  therapy: MbdTherapyState;
  /** projected set point per horizon */
  points: Record<number, { phosphate: number; correctedCalcium: number; pth: number }>;
  risk: {
    hyperphosphatemia: Record<number, number>;
    hypercalcemia: Record<number, number>;
    hypocalcemia: Record<number, number>;
    pthOutOfRange: Record<number, number>;
  };
  /** contract verdict — a false allowed flag would be a governance failure */
  allowed: boolean;
  violations: string[];
  pillBurden: number;
  score: number;
}

export interface MbdWhatIfResult {
  patientId: string;
  current: { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined };
  inTarget: boolean;
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: readonly number[];
  candidates: MbdCandidate[];
  recommended?: MbdCandidate | undefined;
  model: typeof MBD_SIMULATOR_MODEL;
  synthetic: boolean;
  note: string;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Dose-step levers considered for every patient. */
export function mbdCandidateTherapies(input: MbdCoupledInput): Array<{ label: string; action: string; therapy: MbdTherapyState }> {
  const t = input.therapy ?? { binderMgPerDay: 0, binderClass: 'none' as const, calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };
  const out: Array<{ label: string; action: string; therapy: MbdTherapyState }> = [
    { label: 'Continue current therapy', action: 'continue', therapy: t },
  ];
  for (const step of [1200, 2400, 3600]) {
    out.push({ label: `Binder +${step / 1000} g/day`, action: 'increase-binder', therapy: { ...t, binderMgPerDay: t.binderMgPerDay + step, binderClass: t.binderClass === 'none' ? 'sevelamer' : t.binderClass } });
  }
  if (t.binderMgPerDay > 0) out.push({ label: 'Binder −40%', action: 'reduce-binder', therapy: { ...t, binderMgPerDay: Math.round(t.binderMgPerDay * 0.6) } });
  out.push({ label: 'Switch to a non-calcium binder', action: 'switch-binder', therapy: { ...t, binderClass: t.binderClass === 'calcium-acetate' ? 'sevelamer' : 'lanthanum' } });
  for (const step of [30, 60]) {
    out.push({ label: `Calcimimetic ${t.calcimimeticMgPerDay > 0 ? '+' : ''}${step} mg/day`, action: t.calcimimeticMgPerDay > 0 ? 'increase-calcimimetic' : 'start-calcimimetic', therapy: { ...t, calcimimeticMgPerDay: t.calcimimeticMgPerDay + step } });
  }
  out.push({ label: 'Active vitamin D +0.25 mcg/day', action: 'start-vitamin-d', therapy: { ...t, activeVitaminDMcgPerDay: t.activeVitaminDMcgPerDay + 0.25 } });
  out.push({ label: 'Active vitamin D +0.5 mcg/day', action: 'start-vitamin-d', therapy: { ...t, activeVitaminDMcgPerDay: t.activeVitaminDMcgPerDay + 0.5 } });
  if (t.calcimimeticMgPerDay > 0) out.push({ label: 'Calcimimetic −30 mg/day', action: 'reduce-calcimimetic', therapy: { ...t, calcimimeticMgPerDay: Math.max(0, t.calcimimeticMgPerDay - 30) } });
  if (t.activeVitaminDMcgPerDay > 0) out.push({ label: 'Active vitamin D −0.25 mcg/day', action: 'reduce-vitamin-d', therapy: { ...t, activeVitaminDMcgPerDay: Math.max(0, t.activeVitaminDMcgPerDay - 0.25) } });
  return out;
}

export function scoreMbdCandidate(candidate: Omit<MbdCandidate, 'score' | 'allowed' | 'violations'>): number {
  const p = candidate.points[90];
  if (!p) return Number.POSITIVE_INFINITY;
  const phosphateOut = Math.max(0, p.phosphate - MBD_REFERENCE.phosphateTargetMgDl.upper) + Math.max(0, MBD_REFERENCE.phosphateTargetMgDl.lower - p.phosphate);
  const pthOut = Math.max(0, (p.pth - MBD_REFERENCE.pthTargetPgMl.upper) / 100) + Math.max(0, (MBD_REFERENCE.pthTargetPgMl.lower - p.pth) / 100);
  const hyperCa = candidate.risk.hypercalcemia[90] ?? 0;
  const hypoCa = candidate.risk.hypocalcemia[90] ?? 0;
  return round3(
    MBD_TRADEOFF_WEIGHTS.phosphateOutOfRange * phosphateOut
    + MBD_TRADEOFF_WEIGHTS.pthOutOfRange * pthOut
    + MBD_TRADEOFF_WEIGHTS.hypercalcemia * hyperCa
    + MBD_TRADEOFF_WEIGHTS.hypocalcemia * hypoCa
    + MBD_TRADEOFF_WEIGHTS.pillBurden * candidate.pillBurden,
  );
}

export function mbdWhatIf(input: MbdCoupledInput): MbdWhatIfResult {
  const base = mbdRecommend(input);
  const guardrails = guardMbdTherapy(input);

  const candidates: MbdCandidate[] = mbdCandidateTherapies(input).map((candidate) => {
    const projection = projectMbdTherapy(input, candidate.therapy);
    const pillBurden = round3((candidate.therapy.binderMgPerDay / 800 + candidate.therapy.calcimimeticMgPerDay / 30 + candidate.therapy.activeVitaminDMcgPerDay / 0.25) / 10);
    const partial = {
      label: candidate.label,
      action: candidate.action,
      therapy: candidate.therapy,
      points: projection.points,
      risk: projection.risk,
      pillBurden,
    };
    const allowed = projection.safe && !guardrails.blocked;
    return {
      ...partial,
      allowed,
      violations: projection.violations,
      score: projection.safe ? scoreMbdCandidate(partial) : round3(10 + projection.violations.length),
    };
  });

  const viable = candidates.filter((c) => c.allowed);
  const recommended = viable.length ? [...viable].sort((a, b) => a.score - b.score)[0] : undefined;
  const { safe: currentSafe } = mbdContractViolations(base.projection.points);

  return {
    patientId: input.patientId,
    current: { phosphate: input.phosphate, correctedCalcium: base.current.correctedCalcium, pth: input.pth },
    inTarget: guardrails.inTarget,
    blocked: guardrails.blocked,
    blockReason: guardrails.blockReason,
    horizonsDays: MBD_REFERENCE.horizonsDays,
    candidates,
    recommended,
    model: MBD_SIMULATOR_MODEL,
    synthetic: true,
    note: recommended
      ? `Lowest-harm viable option: ${recommended.label} → projected [P ${recommended.points[90]!.phosphate}, Ca ${recommended.points[90]!.correctedCalcium}, PTH ${recommended.points[90]!.pth}] at 90 d (hypercalcaemia risk ${recommended.risk.hypercalcemia[90]}, hypocalcaemia risk ${recommended.risk.hypocalcemia[90]}). Advisory only — the nephrologist prescribes (Class C).`
      : `No candidate therapy satisfies the KDIGO envelope for this patient${guardrails.blocked ? ` (${guardrails.blockReason})` : ''} — the current set point is ${currentSafe ? 'the safest available option' : 'outside the envelope and needs clinical review'}.`,
  };
}

/**
 * The coupling map: how much each lever moves each analyte at 90 days. Used by
 * the exec page and the model card to make the coupling explicit rather than
 * hidden inside the responder.
 */
export function mbdCouplingMap(input: MbdCoupledInput): Array<{ lever: string; phosphate: number; correctedCalcium: number; pth: number }> {
  const t = input.therapy ?? { binderMgPerDay: 0, binderClass: 'none' as const, calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };
  const baseline = projectMbdTherapy(input, t).points[90]!;
  const delta = (next: MbdTherapyState) => {
    const p = projectMbdTherapy(input, next).points[90]!;
    return {
      phosphate: round3(p.phosphate - baseline.phosphate),
      correctedCalcium: round3(p.correctedCalcium - baseline.correctedCalcium),
      pth: Math.round(p.pth - baseline.pth),
    };
  };
  return [
    { lever: 'Binder +2.4 g/day', ...delta({ ...t, binderMgPerDay: t.binderMgPerDay + 2400, binderClass: t.binderClass === 'none' ? 'sevelamer' : t.binderClass }) },
    { lever: 'Calcimimetic +30 mg/day', ...delta({ ...t, calcimimeticMgPerDay: t.calcimimeticMgPerDay + 30 }) },
    { lever: 'Active vitamin D +0.25 mcg/day', ...delta({ ...t, activeVitaminDMcgPerDay: t.activeVitaminDMcgPerDay + 0.25 }) },
    { lever: 'Calcium-based binder +2.4 g/day', ...delta({ ...t, binderMgPerDay: t.binderMgPerDay + 2400, binderClass: 'calcium-acetate' }) },
  ];
}
