/******************************************************************************
 * Fluid / IDH — UF-rate counterfactual simulator (P2 protocol pack, step C).
 *
 * This is the protocol's differentiator (implementation strategy §2.1): instead
 * of only predicting "will this patient crash", simulate the SESSION under
 * different ultrafiltration rates and report, for each candidate, the fluid
 * actually removed AND the IDH probability at 15 / 30 / 60 minutes.
 *
 * Physics held fixed across candidates (documented, monotone):
 *   • fluid removed = UF rate × time (bounded by the prescribed goal);
 *   • plasma-refill ceiling = 10 mL/kg/h safe, 13 mL/kg/h high;
 *   • longer sessions at a lower rate reduce the IDH probability because plasma
 *     refilling has time to keep up — that is the counterfactual being tested.
 *
 * No candidate is ever a machine command: every output is advisory (Class C).
 ******************************************************************************/

import {
  FLUID_HORIZONS_MIN,
  UF_RATE_PER_KG_SAFE,
  UF_RATE_STEP,
  fluidRecommend,
  guardFluidPrescription,
  idhProbability,
  type FluidPatientWindow,
  type FluidRecommendation,
} from './fluid.js';

export const FLUID_SIMULATOR_MODEL = { id: 'fluid.uf-sim', version: '0.1.0', kind: 'mechanistic-counterfactual' as const };

/** Candidate UF-rate factors (fraction of the current rate) and time extensions. */
export const FLUID_RATE_FACTORS = [1.25, 1.0, 0.85, 0.75, 0.5] as const;
export const FLUID_TIME_EXTENSIONS_MIN = [0, 15, 30, 45] as const;

export const FLUID_TRADEOFF_WEIGHTS = {
  fluidShortfall: 1.2,
  hypotension: 1.0,
  rateCeiling: 0.8,
  timeBurden: 0.2,
} as const;

export interface FluidCandidate {
  label: string;
  ufRateMlH: number;
  ufRatePerKg: number;
  minutes: number;
  /** fluid removed under this candidate, L (capped by the prescribed goal) */
  fluidRemovedL: number;
  /** share of the prescribed goal actually removed, % */
  goalAchievedPct: number;
  allowed: boolean;
  blockedReason?: string | undefined;
  idhRiskByMinute: Record<number, number>;
  /** worst per-horizon risk (used for ranking) */
  peakIdhRisk: number;
  aboveRefillCeiling: boolean;
  score: number;
}

export interface FluidWhatIfResult {
  patientId: string;
  prescribed: { ufVolumeL?: number | undefined; ufRateMlH?: number | undefined; minutes: number; postWeightKg: number; idwgKg?: number | undefined };
  blocked: boolean;
  blockReason: string | null;
  horizonsMin: readonly number[];
  candidates: FluidCandidate[];
  recommended?: FluidCandidate | undefined;
  model: typeof FLUID_SIMULATOR_MODEL;
  synthetic: boolean;
  note: string;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Simulate one candidate UF profile inside a session. */
export function simulateUfProfile(input: {
  window: FluidPatientWindow;
  ufRateMlH: number;
  minutes: number;
}): Omit<FluidCandidate, 'label' | 'allowed' | 'blockedReason' | 'aboveRefillCeiling' | 'score'> {
  const weight = input.window.postWeightKg ?? 70;
  const ufRatePerKg = round3(input.ufRateMlH / weight);
  const prescribedVolume = input.window.ufVolumeL;
  const removed = Math.min(
    (input.ufRateMlH * (input.minutes / 60)) / 1000,
    prescribedVolume !== undefined ? prescribedVolume * 1.05 : Number.POSITIVE_INFINITY,
  );
  const fluidRemovedL = Math.round(removed * 100) / 100;
  const goalAchievedPct = prescribedVolume && prescribedVolume > 0
    ? Math.round((fluidRemovedL / prescribedVolume) * 100)
    : 100;
  const currentSbp = input.window.nadirSbp ?? input.window.preSbp ?? 110;
  const idhRiskByMinute: Record<number, number> = {};
  for (const minute of FLUID_HORIZONS_MIN) {
    idhRiskByMinute[minute] = idhProbability({
      ufRatePerKg,
      currentSbp,
      ...(input.window.nadirSbpPrev !== undefined ? { nadirSbpPrev: input.window.nadirSbpPrev } : {}),
      ...(input.window.idwgKg !== undefined ? { idwgKg: input.window.idwgKg } : {}),
      ...(input.window.age !== undefined ? { age: input.window.age } : {}),
      ...(input.window.cardiacHistory !== undefined ? { cardiacHistory: input.window.cardiacHistory } : {}),
      minute,
    });
  }
  return {
    ufRateMlH: Math.round(input.ufRateMlH),
    ufRatePerKg,
    minutes: input.minutes,
    fluidRemovedL,
    goalAchievedPct,
    idhRiskByMinute,
    peakIdhRisk: Math.max(...Object.values(idhRiskByMinute)),
  };
}

/**
 * Build the full counterfactual matrix for one session and pick the safest
 * profile that still meets the fluid goal.
 */
export function fluidWhatIf(window: FluidPatientWindow): FluidWhatIfResult {
  const base: FluidRecommendation = fluidRecommend(window);
  const guardrails = guardFluidPrescription(window);
  const weight = window.postWeightKg ?? 70;
  const minutes = window.deliveredMinutes ?? window.plannedMinutes ?? 210;
  const currentRate = window.ufRateMlH ?? base.current.ufRateMlH ?? 0;
  const prescribed = {
    ufVolumeL: window.ufVolumeL,
    ufRateMlH: currentRate || undefined,
    minutes,
    postWeightKg: weight,
    idwgKg: window.idwgKg,
  };

  const candidates: FluidCandidate[] = [];
  for (const factor of FLUID_RATE_FACTORS) {
    for (const extension of FLUID_TIME_EXTENSIONS_MIN) {
      const rate = Math.max(UF_RATE_STEP, Math.round((currentRate * factor) / UF_RATE_STEP) * UF_RATE_STEP);
      const sim = simulateUfProfile({ window, ufRateMlH: rate, minutes: minutes + extension });
      const aboveRefillCeiling = sim.ufRatePerKg > UF_RATE_PER_KG_SAFE;

      let allowed = true;
      let blockedReason: string | undefined;
      const increasing = rate > currentRate;
      if (guardrails.blocked && increasing) {
        allowed = false;
        blockedReason = guardrails.blockReason ?? 'Window blocked by guardrails — no UF increase.';
      }
      if (increasing && !guardrails.ufEscalationAllowed) {
        allowed = false;
        blockedReason = blockedReason ?? (guardrails.flags.includes('idh-in-previous-session')
          ? 'Hypotension in the previous session — UF escalation not permitted.'
          : guardrails.flags.includes('cardiac-fragility')
            ? 'Cardiac fragility — UF escalation not permitted.'
            : 'UF escalation not permitted by the guardrails.');
      }
      if (aboveRefillCeiling && increasing) {
        allowed = false;
        blockedReason = blockedReason ?? `UF rate ${sim.ufRatePerKg} mL/kg/h exceeds the refill ceiling (${UF_RATE_PER_KG_SAFE}).`;
      }

      const shortfall = Math.max(0, 100 - sim.goalAchievedPct) / 100;
      const score = round3(
        FLUID_TRADEOFF_WEIGHTS.fluidShortfall * shortfall
        + FLUID_TRADEOFF_WEIGHTS.hypotension * sim.peakIdhRisk
        + FLUID_TRADEOFF_WEIGHTS.rateCeiling * (aboveRefillCeiling ? sim.ufRatePerKg - UF_RATE_PER_KG_SAFE : 0) / 10
        + FLUID_TRADEOFF_WEIGHTS.timeBurden * (extension / 60),
      );
      candidates.push({
        label: `${Math.round(factor * 100)}% rate${extension ? ` +${extension} min` : ''}`,
        ...sim,
        allowed,
        ...(blockedReason ? { blockedReason } : {}),
        aboveRefillCeiling,
        score,
      });
    }
  }

  const viable = guardrails.blocked
    ? []
    : candidates.filter((c) => c.allowed && !c.aboveRefillCeiling);
  const recommended = viable.length
    ? viable.slice().sort((a, b) => (Number(b.goalAchievedPct >= 95) - Number(a.goalAchievedPct >= 95)) || (a.score - b.score))[0]
    : undefined;

  return {
    patientId: window.patientId,
    prescribed,
    blocked: guardrails.blocked,
    blockReason: guardrails.blockReason,
    horizonsMin: FLUID_HORIZONS_MIN,
    candidates,
    recommended,
    model: FLUID_SIMULATOR_MODEL,
    synthetic: true,
    note: recommended
      ? `Safest profile that still meets the goal: ${recommended.label} → ${recommended.fluidRemovedL} L (${recommended.goalAchievedPct}% of goal) at ${recommended.ufRatePerKg} mL/kg/h, peak IDH risk ${recommended.peakIdhRisk} across 15/30/60 min. Advisory only — nursing/nephrology own the setting (Class C).`
      : 'No viable UF profile under the current guardrails — resolve the blocking condition (telemetry, target weight, adherence) first.',
  };
}

/** Per-horizon risk surface for the UI (current rate vs recommended rate). */
export function fluidRiskSurface(window: FluidPatientWindow, recommendedRate?: number): Array<{ minute: number; current: number; recommended?: number | undefined }> {
  const weight = window.postWeightKg ?? 70;
  const minutes = window.deliveredMinutes ?? window.plannedMinutes ?? 210;
  const currentRate = window.ufRateMlH ?? 0;
  const currentSbp = window.nadirSbp ?? window.preSbp ?? 110;
  return FLUID_HORIZONS_MIN.map((minute) => {
    const current = idhProbability({
      ufRatePerKg: round3(currentRate / weight),
      currentSbp,
      ...(window.nadirSbpPrev !== undefined ? { nadirSbpPrev: window.nadirSbpPrev } : {}),
      ...(window.idwgKg !== undefined ? { idwgKg: window.idwgKg } : {}),
      ...(window.age !== undefined ? { age: window.age } : {}),
      ...(window.cardiacHistory !== undefined ? { cardiacHistory: window.cardiacHistory } : {}),
      minute,
    });
    const recommended = recommendedRate !== undefined
      ? idhProbability({
        ufRatePerKg: round3(recommendedRate / weight),
        currentSbp,
        ...(window.nadirSbpPrev !== undefined ? { nadirSbpPrev: window.nadirSbpPrev } : {}),
        ...(window.idwgKg !== undefined ? { idwgKg: window.idwgKg } : {}),
        ...(window.age !== undefined ? { age: window.age } : {}),
        ...(window.cardiacHistory !== undefined ? { cardiacHistory: window.cardiacHistory } : {}),
        minute,
      })
      : undefined;
    void minutes;
    return { minute, current, ...(recommended !== undefined ? { recommended } : {}) };
  });
}
