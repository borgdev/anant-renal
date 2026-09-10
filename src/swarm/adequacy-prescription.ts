/******************************************************************************
 * Dialysis adequacy — prescription simulator (P1 protocol pack, step C).
 *
 * Counterfactual "what if we prescribe more time / more blood flow" over the
 * Daugirdas urea-kinetic prior, coupled to the fluid protocol: raising clearance
 * is only useful if it does not buy intradialytic hypotension. Every candidate
 * therefore reports BOTH expected spKt/V/URR AND expected IDH risk, and the
 * recommendation never uses a machine parameter (advisory only, Class C).
 *
 * Why not a learned simulator yet: the evidence table (§0) fixes trees over
 * priors for adequacy; the mechanistic scaling here is the prior the learned
 * head (step E) corrects — same split as the anemia MPC.
 ******************************************************************************/

import {
  ADEQUACY_QB_STEP_MLMIN,
  ADEQUACY_TIME_STEP_MIN,
  ADEQUACY_MAX_QB,
  KTV_BAND,
  KTV_OVER_DELIVERY,
  adequacyRecommend,
  clearanceMultiplier,
  idhRiskProxy,
  type AdequacyPatientWindow,
  type AdequacyRecommendation,
} from './adequacy.js';
import { ktvToUrr, spKtVFromUrr, weeklyKtV } from '../protocols/priors.js';

export const ADEQUACY_SIMULATOR_MODEL = { id: 'adequacy.ktv-sim', version: '0.1.0', kind: 'mechanistic-counterfactual' as const };

/** Candidate prescription deltas: de-escalation options first, then increases. */
export const ADEQUACY_CANDIDATE_DELTAS: ReadonlyArray<{ minutes: number; qb: number }> = [
  { minutes: -ADEQUACY_TIME_STEP_MIN * 6, qb: 0 },
  { minutes: -ADEQUACY_TIME_STEP_MIN * 4, qb: 0 },
  { minutes: -ADEQUACY_TIME_STEP_MIN * 2, qb: 0 },
  { minutes: -ADEQUACY_TIME_STEP_MIN, qb: 0 },
  { minutes: 0, qb: 0 },
  { minutes: ADEQUACY_TIME_STEP_MIN, qb: 0 },
  { minutes: ADEQUACY_TIME_STEP_MIN * 2, qb: 0 },
  { minutes: ADEQUACY_TIME_STEP_MIN * 3, qb: 0 },
  { minutes: 0, qb: ADEQUACY_QB_STEP_MLMIN },
  { minutes: 0, qb: ADEQUACY_QB_STEP_MLMIN * 2 },
  { minutes: ADEQUACY_TIME_STEP_MIN, qb: ADEQUACY_QB_STEP_MLMIN },
  { minutes: ADEQUACY_TIME_STEP_MIN * 2, qb: ADEQUACY_QB_STEP_MLMIN },
];

/** Weights for the trade-off score (documented, not tuned silently). */
export const ADEQUACY_TRADEOFF_WEIGHTS = {
  outOfBand: 1.0,
  hypotension: 0.8,
  overDelivery: 0.5,
  timeBurden: 0.25,
} as const;

export interface AdequacyCandidate {
  label: string;
  minutesDelta: number;
  qbDelta: number;
  prescriptionMinutes: number;
  prescriptionQb?: number | undefined;
  /** guardrail-consistent with the window (blocked candidates are never picked) */
  allowed: boolean;
  blockedReason?: string | undefined;
  expectedSpKtV?: number | undefined;
  expectedUrrPct?: number | undefined;
  weeklyKtV?: number | undefined;
  meetsBand: boolean;
  overDelivery: boolean;
  expectedIdhRisk?: number | undefined;
  /** composite trade-off score (lower is better) */
  score: number;
}

export interface AdequacyWhatIfResult {
  patientId: string;
  current: {
    minutes?: number | undefined;
    qb?: number | undefined;
    spKtV?: number | undefined;
    urrPct?: number | undefined;
    idhRisk?: number | undefined;
  };
  /** guardrails at the window level (a blocked window yields no viable candidate) */
  blocked: boolean;
  blockReason: string | null;
  candidates: AdequacyCandidate[];
  recommended?: AdequacyCandidate | undefined;
  model: typeof ADEQUACY_SIMULATOR_MODEL;
  synthetic: boolean;
  note: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Simulate every candidate prescription for one patient window.
 * Returns candidates even when the guardrails block the window (marked
 * `allowed: false`) so the clinician sees WHY nothing can be proposed.
 */
export function adequacyWhatIf(window: AdequacyPatientWindow): AdequacyWhatIfResult {
  const base = adequacyRecommend(window);
  const sessionsPerWeek = window.sessionsPerWeek ?? 3;
  const minutesNow = window.deliveredMinutes ?? window.prescribedMinutes ?? 210;
  const qbNow = window.qbAvg ?? window.qbPrescribed;
  const spKtVNow = window.deliveredSpKtV
    ?? base.current.spKtV
    ?? (window.urrPct !== undefined ? spKtVFromUrr({ urrPct: window.urrPct, durationHours: minutesNow / 60, ufVolumeL: window.ufVolumeL ?? 2.5, postWeightKg: window.postWeightKg ?? 70 }) : undefined);
  const currentIdh = idhRiskProxy({
    ...(window.nadirSbp !== undefined ? { nadirSbp: window.nadirSbp } : {}),
    ...(window.idwgKg !== undefined ? { idwgKg: window.idwgKg } : {}),
    ...(window.postWeightKg !== undefined ? { postWeightKg: window.postWeightKg } : {}),
    ...(window.ufVolumeL !== undefined ? { ufVolumeL: window.ufVolumeL } : {}),
    plannedMinutes: minutesNow,
  });

  const candidates: AdequacyCandidate[] = ADEQUACY_CANDIDATE_DELTAS.map((delta) => {
    const minutes = Math.max(60, minutesNow + delta.minutes);
    const qb = qbNow !== undefined ? Math.min(ADEQUACY_MAX_QB, qbNow + delta.qb) : undefined;
    const label = delta.minutes === 0 && delta.qb === 0
      ? 'current prescription'
      : `${delta.minutes > 0 ? `+${delta.minutes}` : delta.minutes === 0 ? '±0' : delta.minutes} min${delta.qb ? ` / +${delta.qb} mL/min` : ''}`;

    // guardrails: a blocked window permits NO increase (the prescription is not
    // the problem), cardiac risk blocks Qb escalation, over-delivery blocks
    // increases, and time cannot be cut when already below target.
    let allowed = true;
    let blockedReason: string | undefined;
    if (base.guardrails.blocked && (delta.minutes > 0 || delta.qb > 0)) {
      allowed = false;
      blockedReason = base.guardrails.blockReason ?? 'Window blocked by guardrails — no prescription increase.';
    }
    if (delta.qb > 0 && !base.guardrails.qbEscalationAllowed) {
      allowed = false;
      blockedReason = blockedReason ?? (base.guardrails.flags.includes('access-recirculation-review-first')
        ? 'Recirculation ≥10% — access review before flow escalation.'
        : 'Cardiac-risk / hypotension profile — flow escalation not permitted.');
    }
    if (delta.minutes > 0 && !base.guardrails.timeEscalationAllowed) {
      allowed = false;
      blockedReason = blockedReason ?? (base.guardrails.flags.includes('ktv-above-over-delivery-ceiling')
        ? 'Already above the over-delivery ceiling.'
        : 'Shortened-session pattern — adherence intervention first.');
    }
    if (delta.minutes < 0 && spKtVNow !== undefined && spKtVNow < KTV_BAND.min) {
      allowed = false;
      blockedReason = blockedReason ?? 'Below target — time cannot be reduced.';
    }

    const multiplier = clearanceMultiplier({ minutesNow, minutesNext: minutes, ...(qbNow !== undefined ? { qbNow } : {}), ...(qb !== undefined ? { qbNext: qb } : {}) });
    const expectedSpKtV = spKtVNow !== undefined ? round2(Math.min(3, spKtVNow * multiplier)) : undefined;
    const expectedUrrPct = expectedSpKtV !== undefined ? Math.round(ktvToUrr(expectedSpKtV) * 10) / 10 : undefined;
    const weekly = expectedSpKtV !== undefined ? weeklyKtV(expectedSpKtV, sessionsPerWeek) : undefined;
    const meetsBand = expectedSpKtV !== undefined && expectedSpKtV >= KTV_BAND.min && expectedSpKtV <= KTV_BAND.max;
    const overDelivery = expectedSpKtV !== undefined && expectedSpKtV > KTV_OVER_DELIVERY;
    const expectedIdhRisk = idhRiskProxy({
      ...(window.nadirSbp !== undefined ? { nadirSbp: window.nadirSbp } : {}),
      ...(window.idwgKg !== undefined ? { idwgKg: window.idwgKg } : {}),
      ...(window.postWeightKg !== undefined ? { postWeightKg: window.postWeightKg } : {}),
      ...(window.ufVolumeL !== undefined ? { ufVolumeL: window.ufVolumeL } : {}),
      plannedMinutes: minutes,
    });

    const bandDistance = expectedSpKtV === undefined
      ? 1
      : expectedSpKtV < KTV_BAND.min
        ? KTV_BAND.min - expectedSpKtV
        : expectedSpKtV > KTV_BAND.max
          ? expectedSpKtV - KTV_BAND.max
          : 0;
    const score = round3(
      ADEQUACY_TRADEOFF_WEIGHTS.outOfBand * bandDistance
      + ADEQUACY_TRADEOFF_WEIGHTS.hypotension * Math.max(0, expectedIdhRisk - currentIdh)
      + ADEQUACY_TRADEOFF_WEIGHTS.overDelivery * (overDelivery ? expectedSpKtV! - KTV_OVER_DELIVERY : 0)
      + ADEQUACY_TRADEOFF_WEIGHTS.timeBurden * (Math.max(0, delta.minutes) / 60),
    );

    return {
      label,
      minutesDelta: minutes - minutesNow,
      qbDelta: qb !== undefined && qbNow !== undefined ? qb - qbNow : 0,
      prescriptionMinutes: minutes,
      prescriptionQb: qb,
      allowed,
      ...(blockedReason ? { blockedReason } : {}),
      expectedSpKtV,
      expectedUrrPct,
      weeklyKtV: weekly,
      meetsBand,
      overDelivery,
      expectedIdhRisk,
      score,
    };
  });

  const viable = base.guardrails.blocked ? [] : candidates.filter((c) => c.allowed && !c.overDelivery);
  const recommended = viable.length
    ? viable.slice().sort((a, b) => (Number(b.meetsBand) - Number(a.meetsBand)) || (a.score - b.score) || (a.minutesDelta - b.minutesDelta))[0]
    : undefined;

  return {
    patientId: window.patientId,
    current: {
      minutes: minutesNow,
      qb: qbNow,
      spKtV: spKtVNow,
      urrPct: window.urrPct,
      idhRisk: currentIdh,
    },
    blocked: base.guardrails.blocked,
    blockReason: base.guardrails.blockReason,
    candidates,
    recommended,
    model: ADEQUACY_SIMULATOR_MODEL,
    synthetic: true,
    note: recommended
      ? `Closest safe prescription: ${recommended.label} → expected spKt/V ${recommended.expectedSpKtV} (URR ${recommended.expectedUrrPct}%), IDH risk ${recommended.expectedIdhRisk}. Any UF increase stays with the fluid protocol; the nephrologist owns the prescription (Class C).`
      : 'No viable candidate under the current guardrails — resolve the blocking condition first.',
  };
}
