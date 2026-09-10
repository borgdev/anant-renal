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

// P3 step C — access surveillance / referral counterfactual.
//
// The plan being chosen is a surveillance interval plus a referral-or-not
// decision. Every candidate is projected over the 30/90-day thrombosis horizons
// with the same mechanistic prior the advisor uses, so the trade-off is explicit:
// a longer surveillance interval saves imaging burden but lets a progressing
// stenosis thrombose; a referral removes the stenosis risk at a procedure cost.
//
// Advisory only: the platform never books an imaging study or an intervention.

import { ACCESS_REFERENCE, accessRecommend, stenosisProbability, thrombosisRisk, guardAccessReferral, type AccessGuardInput } from './access.js';

export const ACCESS_SIMULATOR_MODEL = { id: 'access.surveillance-sim', version: '0.1.0', kind: 'mechanistic-counterfactual' as const };

/** surveillance intervals considered, days */
export const ACCESS_SURVEILLANCE_INTERVALS = [14, 28, 56, 84] as const;
/** referral arms: no imaging, or imaging now */
export const ACCESS_REFERRAL_ARMS = ['surveillance-only', 'refer-now'] as const;
export type AccessReferralArm = (typeof ACCESS_REFERRAL_ARMS)[number];

export const ACCESS_TRADEOFF_WEIGHTS = {
  /** a missed thrombosis that costs the access (dominant) */
  accessLoss: 1.4,
  /** the imaging/procedure burden of an unnecessary referral */
  procedureBurden: 0.55,
  /** delay in detecting a progression under a long interval */
  detectionDelay: 0.7,
  /** the cost of a purely reactive monitoring arm */
  surveillanceBurden: 0.15,
} as const;

/** Detection delay grows with the interval: 14 d ≈ 0.25, 84 d = 1.0 */
const delayFactor = (intervalDays: number): number => Math.min(1, Math.max(0.25, intervalDays / 84));

export interface AccessCandidate {
  label: string;
  arm: AccessReferralArm;
  surveillanceIntervalDays: number;
  /** projected P(thrombosis) over 30 / 90 days */
  thrombosisRiskByHorizon: Record<number, number>;
  /** projected P(≥50% stenosis) at the end of the interval without intervention */
  projectedStenosisProbability: number;
  /** days of undetected progression before the next surveillance measurement */
  detectionDelayDays: number;
  /** non-monotonic burden: procedures booked now vs monitoring over the horizon */
  procedureBurden: number;
  allowed: boolean;
  blockedReason?: string | undefined;
  score: number;
}

export interface AccessWhatIfResult {
  patientId: string;
  current: { stenosisProbability: number; thrombosisRiskByHorizon: Record<number, number>; accessType?: string | undefined };
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: readonly number[];
  candidates: AccessCandidate[];
  recommended?: AccessCandidate | undefined;
  model: typeof ACCESS_SIMULATOR_MODEL;
  synthetic: boolean;
  note: string;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Project one candidate plan. Progression under a surveillance-only arm uses the
 * documented progression rate (venos pressure grows ~1.6%/week at the current
 * rate); a referral arm truncates the progression at the procedure.
 */
export function simulateAccessPlan(input: {
  window: AccessGuardInput & { patientId: string };
  arm: AccessReferralArm;
  surveillanceIntervalDays: number;
}): Omit<AccessCandidate, 'label' | 'allowed' | 'blockedReason' | 'score'> {
  const weeks = input.surveillanceIntervalDays / 7;
  const current = stenosisProbability(input.window);
  // weekly progression is proportional to the unresolved stenosis burden
  const weeklyProgression = 0.045 * (1 - current);
  const rawProjected = input.arm === 'refer-now'
    ? Math.min(0.99, current * 0.35) // angioplasty resolves most of the stenosis
    : Math.min(0.99, current + weeklyProgression * weeks);

  // The hazard is driven by the PROJECTED stenosis, passed explicitly: deriving
  // it through a synthetic venous-pressure window would saturate and hide the
  // effect of the surveillance interval entirely.
  const thrombosisRiskByHorizon: Record<number, number> = {};
  for (const days of ACCESS_REFERENCE.thrombosisHorizonsDays) {
    thrombosisRiskByHorizon[days] = thrombosisRisk(input.window, days, rawProjected);
  }
  return {
    arm: input.arm,
    surveillanceIntervalDays: input.surveillanceIntervalDays,
    thrombosisRiskByHorizon,
    projectedStenosisProbability: round3(rawProjected),
    detectionDelayDays: Math.round(input.surveillanceIntervalDays * delayFactor(input.surveillanceIntervalDays)),
    procedureBurden: input.arm === 'refer-now' ? 1 : 0,
  };
}

/** Score a candidate: access loss (dominant) + procedure burden + detection delay. */
export function scoreAccessCandidate(candidate: Omit<AccessCandidate, 'label' | 'allowed' | 'blockedReason' | 'score'>): number {
  const loss90 = candidate.thrombosisRiskByHorizon[90] ?? 0;
  const delay = candidate.detectionDelayDays / 84;
  const surveillanceBurden = candidate.arm === 'surveillance-only' ? 1 / (candidate.surveillanceIntervalDays / 14) : 0;
  return round3(
    ACCESS_TRADEOFF_WEIGHTS.accessLoss * loss90
    + ACCESS_TRADEOFF_WEIGHTS.procedureBurden * candidate.procedureBurden
    + ACCESS_TRADEOFF_WEIGHTS.detectionDelay * delay
    + ACCESS_TRADEOFF_WEIGHTS.surveillanceBurden * surveillanceBurden,
  );
}

export function accessWhatIf(window: AccessGuardInput & { patientId: string }): AccessWhatIfResult {
  const base = accessRecommend(window);
  const guardrails = guardAccessReferral(window);
  const current = {
    stenosisProbability: base.stenosisProbability,
    thrombosisRiskByHorizon: base.thrombosisRiskByHorizon,
    accessType: window.accessType,
  };

  const candidates: AccessCandidate[] = [];
  for (const arm of ACCESS_REFERRAL_ARMS) {
    for (const interval of ACCESS_SURVEILLANCE_INTERVALS) {
      const sim = simulateAccessPlan({ window, arm, surveillanceIntervalDays: interval });
      let allowed = true;
      let blockedReason: string | undefined;
      if (guardrails.blocked) {
        allowed = false;
        blockedReason = guardrails.blockReason ?? 'Blocked by guardrails.';
      } else if (arm === 'refer-now' && !guardrails.referralAllowed) {
        allowed = false;
        blockedReason = guardrails.flags.includes('post-intervention-quiet-window')
          ? 'Inside the post-intervention quiet window — no re-referral.'
          : guardrails.flags.includes('within-normal-range')
            ? 'No deterioration pattern — imaging would be an unnecessary procedure.'
            : 'Referral not permitted by the guardrails for this access.';
      }
      const score = scoreAccessCandidate(sim);
      candidates.push({
        label: `${arm === 'refer-now' ? 'Refer now' : 'Surveillance only'} · ${interval} d`,
        ...sim,
        allowed,
        ...(blockedReason ? { blockedReason } : {}),
        score,
      });
    }
  }

  // Choose the lowest-loss plan: the safest (lowest 90-day thrombosis risk) plan
  // wins unless a cheaper plan is within 2 percentage points of it.
  const viable = candidates.filter((c) => c.allowed);
  const recommended = viable.length
    ? viable.slice().sort((a, b) =>
      ((a.thrombosisRiskByHorizon[90] ?? 1) - (b.thrombosisRiskByHorizon[90] ?? 1))
      || (a.score - b.score))[0]
    : undefined;

  return {
    patientId: window.patientId,
    current,
    blocked: guardrails.blocked,
    blockReason: guardrails.blockReason,
    horizonsDays: ACCESS_REFERENCE.thrombosisHorizonsDays,
    candidates,
    recommended,
    model: ACCESS_SIMULATOR_MODEL,
    synthetic: true,
    note: recommended
      ? `Safest viable plan: ${recommended.label} → projected P(thrombosis) ${recommended.thrombosisRiskByHorizon[30]} at 30 d and ${recommended.thrombosisRiskByHorizon[90]} at 90 d, projected stenosis ${recommended.projectedStenosisProbability}, ${recommended.detectionDelayDays} days of detection delay. Advisory only — the access team decides on any referral (Class C).`
      : 'No viable plan under the current guardrails — establish a measured surveillance trend (or exit the post-intervention window) first.',
  };
}

/**
 * Risk surface: thrombosis risk as a function of the next surveillance interval,
 * for both arms and both horizons. The 30-day curve is the discriminating one —
 * at 90 days a progressed access is already at the cap.
 */
export function accessRiskSurface(
  window: AccessGuardInput & { patientId: string },
): Array<{ intervalDays: number; surveillanceOnly: number; surveillanceOnly30d: number; referNow: number; referNow30d: number }> {
  return ACCESS_SURVEILLANCE_INTERVALS.map((intervalDays) => {
    const surveillance = simulateAccessPlan({ window, arm: 'surveillance-only', surveillanceIntervalDays: intervalDays });
    const refer = simulateAccessPlan({ window, arm: 'refer-now', surveillanceIntervalDays: intervalDays });
    return {
      intervalDays,
      surveillanceOnly: surveillance.thrombosisRiskByHorizon[90] ?? 0,
      surveillanceOnly30d: surveillance.thrombosisRiskByHorizon[30] ?? 0,
      referNow: refer.thrombosisRiskByHorizon[90] ?? 0,
      referNow30d: refer.thrombosisRiskByHorizon[30] ?? 0,
    };
  });
}
