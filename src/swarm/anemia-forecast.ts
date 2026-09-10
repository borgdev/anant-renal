/******************************************************************************
 * Anemia / ESA dose "what-if" + MPC controller — P2.5 (reference physiology).
 *
 * Slice 1 — trajectory what-if (Zhao et al. 2026 "Digital twin" paper): given a
 * patient's weekly ESA window, project the 12-week Hb path under EACH candidate
 * dose (suspend / 50% / 75% / hold / 125% / 150%), so a nephrologist can see
 * what a dose actually does to Hb over months — not just the next step.
 *
 * Slice 2 — MPC-style controller + variability objective (Brier & Gaweda 2011
 * "Predictive modeling for improved anemia management"): a dose OPTIMIZER that
 * selects the candidate minimizing out-of-band weeks (with the least dose
 * intervention and overshoot) — the closed-loop analogue of their randomized
 * trial that reduced Hb variability. Paper-A's 7-day erythropoiesis lag and
 * ~130 h PK decay are represented by a 1-week lag + a first-order settling
 * toward the dose's Hb set-point over ~10 weeks (≈ the 14 ± 4 week RBC lifespan
 * Paper B cites). Iron substrate / ESA resistance modulate the set-point via the
 * SAME 2-D latent manifold as the P0 surrogate, so an iron-poor / resistant
 * patient needs more ESA for the same response (and the tool says so honestly).
 *
 * Deterministic + pure (no artifact, no IO) so tests and the demo are
 * reproducible. This is a CDSS: it projects and recommends — it never orders;
 * the dose stays Class C human-approved and iron-first guardrails still apply.
 ******************************************************************************/

import {
  ESA_DOSE_STEP,
  ESA_FEATURES,
  ESA_ADVISOR_MODEL,
  HGB_TARGET,
  esaLatent,
  guardDose,
  type EsaModelKind,
  type EsaPatientWindow,
  type EsaRecommendation,
} from './anemia.js';
import { esaCoverage, type EsaCoverageVerdict } from './anemia-governance.js';

/** The recommendation direction union (anemia.ts does not export it directly). */
type EsaDirection = EsaRecommendation['direction'];

/* ======================================================================
 * 1. Reference physiology responder constants
 * ====================================================================== */

/** Default forecast horizon (weeks) — enough to see ~70% of a dose's effect. */
export const ESA_FORECAST_DEFAULT_HORIZON_WEEKS = 12;
export const ESA_FORECAST_MIN_HORIZON_WEEKS = 4;
export const ESA_FORECAST_MAX_HORIZON_WEEKS = 26;
/** ~7-day erythropoiesis lag before a dose change moves Hb (Paper A). */
export const ESA_RBC_LAG_WEEKS = 1;
/** First-order settling time constant toward the dose set-point (≈ RBC lifespan). */
export const ESA_RBC_SETTLE_TAU_WEEKS = 10;
/** Endogenous Hb floor with no ESA. */
export const ESA_NO_ESA_HGB = 7.2;
/** Max additional Hb a very large ESA dose can produce (equilibrium ≈ 12.0). */
export const ESA_MAX_ESA_GAIN = 4.8;
/** Weekly dose that produces half of max effect for a neutral patient. */
export const ESA_HALF_EFFECT_DOSE = 4800;
/** Rough cost per weekly ESA unit (USD) — used by the economic objective. */
export const ESA_UNIT_COST_USD = 0.006;
/** Rate-of-rise cap (g/dL per week) — avoid rapid Hb excursions (Paper B). */
export const ESA_MAX_WEEKLY_RISE_GD = 0.8;
/** Hb above which a candidate is scored as overshoot risk. */
export const ESA_OVERSHOOT_HGB = 12.3;

/** Candidate dose factors around the current weekly dose (slice 1 + 2). */
export const ESA_FORECAST_DOSE_FACTORS = [0, 0.5, 0.75, 1, 1.25, 1.5] as const;
/** Absolute initiation doses (u/wk) when the patient is not yet on ESA. */
export const ESA_INITIATION_DOSES = [0, 2000, 4000, 6000, 8000, 12000] as const;

/** MPC objective weights (lower is better) — displayed, informational. */
export const ESA_MPC_WEIGHTS = {
  outOfBand: 1.0,
  overshoot: 0.4,
  rapidRise: 0.3,
  doseCost: 0.25,
} as const;

/* ======================================================================
 * 2. Set-point + weekly projection helpers (pure + deterministic)
 * ====================================================================== */

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round = (v: number, digits = 2): number => {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
};

/** Renormalize a latent axis from [-1,1] to a substrate scalar in [0,1]. */
const substrate = (axis: number): number => clamp((axis + 1) / 2, 0, 1);

/** Effective D50 — inflated by ESA resistance and iron deficiency. */
function effectiveD50(iron: number, resistance: number): number {
  return ESA_HALF_EFFECT_DOSE * (1 + 0.6 * (1 - iron) + 0.8 * resistance);
}

/** The Hb equilibrium a steady weekly `dose` drives toward (monotone in dose). */
export function esaSetPointHgb(dose: number, iron: number, resistance: number): number {
  if (dose <= 0) return ESA_NO_ESA_HGB;
  const d50 = effectiveD50(iron, resistance);
  const fraction = 1 - Math.exp(-dose / d50);
  return ESA_NO_ESA_HGB + ESA_MAX_ESA_GAIN * fraction;
}

export interface EsaForecastPoint {
  week: number;
  hgb: number;
  inBand: boolean;
}

/** Iron / resistance substrate for a window — from the SAME esaLatent manifold. */
export function esaForecastSubstrate(window: Pick<EsaPatientWindow, 'mcv' | 'ferritin' | 'transferrinSat' | 'crp' | 'pth' | 'calcium'>): { iron: number; resistance: number } {
  const latent = esaLatent({
    ...(window.mcv !== undefined ? { mcv: window.mcv } : {}),
    ...(window.ferritin !== undefined ? { ferritin: window.ferritin } : {}),
    ...(window.transferrinSat !== undefined ? { transferrinSat: window.transferrinSat } : {}),
    ...(window.crp !== undefined ? { crp: window.crp } : {}),
    ...(window.pth !== undefined ? { pth: window.pth } : {}),
    ...(window.calcium !== undefined ? { calcium: window.calcium } : {}),
  });
  return { iron: substrate(latent.l1), resistance: substrate(latent.l2) };
}

/**
 * Weekly Hb series under a fixed `dose` for `horizonWeeks`. Starts at the
 * observed currentHgb, waits the 1-week erythropoiesis lag, then settles
 * first-order toward the dose's set-point (≈ 10-week RBC time constant).
 */
export function esaForecastSeries(
  window: Pick<EsaPatientWindow, 'currentHgb' | 'mcv' | 'ferritin' | 'transferrinSat' | 'crp' | 'pth' | 'calcium'>,
  dose: number,
  opts: { horizonWeeks?: number; iron?: number; resistance?: number } = {},
): EsaForecastPoint[] {
  const horizon = opts.horizonWeeks ?? ESA_FORECAST_DEFAULT_HORIZON_WEEKS;
  const { iron, resistance } = opts.iron !== undefined && opts.resistance !== undefined
    ? { iron: opts.iron, resistance: opts.resistance }
    : esaForecastSubstrate(window);
  const setPoint = esaSetPointHgb(Math.max(0, dose), iron, resistance);
  const alpha = 1 - Math.exp(-1 / ESA_RBC_SETTLE_TAU_WEEKS);
  const points: EsaForecastPoint[] = [];
  let hgb = window.currentHgb;
  for (let week = 1; week <= horizon; week++) {
    if (week > ESA_RBC_LAG_WEEKS) hgb += alpha * (setPoint - hgb);
    hgb = clamp(hgb, 5, 14);
    const inBand = hgb >= HGB_TARGET.min && hgb <= HGB_TARGET.max;
    points.push({ week, hgb: round(hgb), inBand });
  }
  return points;
}

/* ======================================================================
 * 3. Candidate forecast + MPC scoring
 * ====================================================================== */

const roundStep = (dose: number): number => Math.max(0, Math.round(dose / ESA_DOSE_STEP) * ESA_DOSE_STEP);

/** Deterministic candidate doses for a window, sorted ascending, deduped. */
export function esaCandidateDoses(window: Pick<EsaPatientWindow, 'currentDose'>): number[] {
  const current = Math.max(0, window.currentDose);
  const raw = current > 0
    ? ESA_FORECAST_DOSE_FACTORS.map((f) => roundStep(current * f))
    : [...ESA_INITIATION_DOSES];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const d of [...raw].sort((a, b) => a - b)) {
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

export type EsaCandidateRelation = 'suspend' | 'reduce' | 'hold' | 'increase' | 'initiate' | 'none';

function candidateLabel(dose: number, current: number): { label: string; relation: EsaCandidateRelation } {
  if (current > 0) {
    if (dose === 0) return { label: 'Suspend ESA', relation: 'suspend' };
    if (dose === current) return { label: 'Hold (current)', relation: 'hold' };
    const pct = Math.round((dose / current) * 100);
    return dose < current
      ? { label: `Reduce → ${pct}%`, relation: 'reduce' }
      : { label: `Increase → ${pct}%`, relation: 'increase' };
  }
  return dose === 0
    ? { label: 'No ESA', relation: 'none' }
    : { label: `Initiate ${dose.toLocaleString()} u/wk`, relation: 'initiate' };
}

const populationStd = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

export interface EsaCandidateForecast {
  dose: number;
  label: string;
  relation: EsaCandidateRelation;
  series: EsaForecastPoint[];
  /** Weeks outside the 10–12 band over the horizon. */
  weeksBelow: number;
  weeksInBand: number;
  weeksAbove: number;
  weeksOutOfBand: number;
  pctInBand: number;
  endHgb: number;
  peakHgb: number;
  troughHgb: number;
  /** Standard deviation of the projected weekly Hb (variability objective). */
  variabilityGd: number;
  maxWeeklyRise: number;
  projectedCostUsd: number;
  overshoot: boolean;
  rapidRise: boolean;
  /** Lower = better (MPC objective). */
  score: number;
}

function computeCandidate(
  window: Pick<EsaPatientWindow, 'currentHgb' | 'currentDose' | 'mcv' | 'ferritin' | 'transferrinSat' | 'crp' | 'pth' | 'calcium'>,
  dose: number,
  iron: number,
  resistance: number,
  horizonWeeks: number,
): EsaCandidateForecast {
  const series = esaForecastSeries(window, dose, { horizonWeeks, iron, resistance });
  let below = 0;
  let inBand = 0;
  let above = 0;
  let peak = -Infinity;
  let trough = Infinity;
  let overshoot = false;
  let maxRise = 0;
  let previous = window.currentHgb;
  for (const p of series) {
    if (p.inBand) inBand += 1; else if (p.hgb < HGB_TARGET.min) below += 1; else above += 1;
    peak = Math.max(peak, p.hgb);
    trough = Math.min(trough, p.hgb);
    if (p.hgb > ESA_OVERSHOOT_HGB) overshoot = true;
    const rise = Math.abs(p.hgb - previous);
    maxRise = Math.max(maxRise, rise);
    previous = p.hgb;
  }
  const weeksOutOfBand = below + above;
  const current = Math.max(0, window.currentDose);
  const { label, relation } = candidateLabel(dose, current);
  // MPC objective (lower is better): stay in band first; penalize overshoot /
  // rapid rise / dose cost. Selection favors the least intervention on ties.
  const doseCostRatio = Math.min(1, dose / 20000);
  const score = round(
    ESA_MPC_WEIGHTS.outOfBand * (weeksOutOfBand / horizonWeeks)
    + (overshoot ? ESA_MPC_WEIGHTS.overshoot : 0)
    + (maxRise > ESA_MAX_WEEKLY_RISE_GD ? ESA_MPC_WEIGHTS.rapidRise : 0)
    + ESA_MPC_WEIGHTS.doseCost * doseCostRatio,
    4,
  );
  return {
    dose,
    label,
    relation,
    series,
    weeksBelow: below,
    weeksInBand: inBand,
    weeksAbove: above,
    weeksOutOfBand,
    pctInBand: Math.round((inBand / horizonWeeks) * 100),
    endHgb: series[series.length - 1]?.hgb ?? window.currentHgb,
    peakHgb: round(peak),
    troughHgb: round(trough),
    variabilityGd: round(populationStd(series.map((p) => p.hgb))),
    maxWeeklyRise: round(maxRise, 3),
    projectedCostUsd: round(dose * ESA_UNIT_COST_USD * horizonWeeks, 2),
    overshoot,
    rapidRise: maxRise > ESA_MAX_WEEKLY_RISE_GD,
    score,
  };
}

/** Pick the MPC-optimal candidate: fewest out-of-band weeks, then least dose
 *  intervention (closest to current), then lower cost / dose. */
export function pickMpcCandidate(candidates: readonly EsaCandidateForecast[], currentDose: number): EsaCandidateForecast {
  const sorted = [...candidates].sort((a, b) =>
    (a.weeksOutOfBand - b.weeksOutOfBand)
    || (Math.abs(a.dose - currentDose) - Math.abs(b.dose - currentDose))
    || (a.dose - b.dose)
    || (a.projectedCostUsd - b.projectedCostUsd));
  return sorted[0] as EsaCandidateForecast;
}

/* ======================================================================
 * 4. What-if result + controller
 * ====================================================================== */

export interface EsaMpcController {
  horizonWeeks: number;
  weights: typeof ESA_MPC_WEIGHTS;
  constraints: {
    targetBand: { min: number; max: number };
    maxWeeklyRiseGd: number;
    overshootHgb: number;
    unitCostUsd: number;
  };
  chosenIndex: number;
  expected: {
    weeksInBand: number;
    pctInBand: number;
    projectedCostUsd: number;
    endHgb: number;
    peakHgb: number;
  };
}

export interface EsaWhatIfResult {
  patientId: string;
  asOf: string;
  currentHgb: number;
  currentDose: number;
  onESA: boolean;
  horizonWeeks: number;
  guardrails: { flags: string[]; blocked: boolean; blockReason: string | null };
  blocked: boolean;
  blockReason: string | null;
  candidates: EsaCandidateForecast[];
  chosenIndex: number | null;
  controller: EsaMpcController | null;
  note: string;
}

export function esaWhatIf(window: EsaPatientWindow, opts: { horizonWeeks?: number } = {}): EsaWhatIfResult {
  const guardrails = guardDose(window);
  const horizon = clamp(
    opts.horizonWeeks ?? ESA_FORECAST_DEFAULT_HORIZON_WEEKS,
    ESA_FORECAST_MIN_HORIZON_WEEKS,
    ESA_FORECAST_MAX_HORIZON_WEEKS,
  );
  const current = Math.max(0, window.currentDose);
  if (guardrails.blocked) {
    return {
      patientId: window.patientId,
      asOf: window.asOf,
      currentHgb: window.currentHgb,
      currentDose: current,
      onESA: window.onESA,
      horizonWeeks: horizon,
      guardrails,
      blocked: true,
      blockReason: guardrails.blockReason,
      candidates: [],
      chosenIndex: null,
      controller: null,
      note: guardrails.blockReason ?? 'Blocked by an iron-first guardrail — fix the substrate before projecting ESA response.',
    };
  }

  const { iron, resistance } = esaForecastSubstrate(window);
  const candidates = esaCandidateDoses(window).map((dose) => computeCandidate(window, dose, iron, resistance, horizon));
  const chosen = pickMpcCandidate(candidates, current);
  const chosenIndex = candidates.findIndex((c) => c.dose === chosen.dose);
  const chosenWeeksInBand = chosen.weeksInBand;
  const hyporesponse = window.onESA && chosen.endHgb < HGB_TARGET.min;
  const note = hyporesponse
    ? `Even the best candidate ends the horizon below ${HGB_TARGET.min} g/dL (${chosen.endHgb.toFixed(1)}) — escalate only after assessing iron indices / inflammation (ESA hyporesponse).`
    : `${chosen.label} projects ${chosenWeeksInBand}/${horizon} weeks in the 10–12 band (${chosen.pctInBand}%), ending ≈ ${chosen.endHgb.toFixed(1)} g/dL at ≈ $${chosen.projectedCostUsd.toFixed(0)} over the horizon.`;

  const controller: EsaMpcController = {
    horizonWeeks: horizon,
    weights: ESA_MPC_WEIGHTS,
    constraints: {
      targetBand: { min: HGB_TARGET.min, max: HGB_TARGET.max },
      maxWeeklyRiseGd: ESA_MAX_WEEKLY_RISE_GD,
      overshootHgb: ESA_OVERSHOOT_HGB,
      unitCostUsd: ESA_UNIT_COST_USD,
    },
    chosenIndex,
    expected: {
      weeksInBand: chosen.weeksInBand,
      pctInBand: chosen.pctInBand,
      projectedCostUsd: chosen.projectedCostUsd,
      endHgb: chosen.endHgb,
      peakHgb: chosen.peakHgb,
    },
  };

  return {
    patientId: window.patientId,
    asOf: window.asOf,
    currentHgb: window.currentHgb,
    currentDose: current,
    onESA: window.onESA,
    horizonWeeks: horizon,
    guardrails,
    blocked: false,
    blockReason: null,
    candidates,
    chosenIndex,
    controller,
    note,
  };
}

/* ======================================================================
 * 5. MPC recommendation (Slice 2) — SAME EsaRecommendation contract
 * ====================================================================== */

export const ESA_MPC_MODEL = { id: 'anemia.esa-mpc-v0', version: '0.1.0', kind: 'reference-surrogate' as EsaModelKind };

export function esaRecommendMpc(
  window: EsaPatientWindow,
  opts: { horizonWeeks?: number } = {},
): { recommendation: EsaRecommendation & { coverage: EsaCoverageVerdict }; whatIf: EsaWhatIfResult } {
  const guardrails = guardDose(window);
  const coverage = esaCoverage(window);
  const whatIf = esaWhatIf(window, opts);
  const latent = esaLatent({
    ...(window.mcv !== undefined ? { mcv: window.mcv } : {}),
    ...(window.ferritin !== undefined ? { ferritin: window.ferritin } : {}),
    ...(window.transferrinSat !== undefined ? { transferrinSat: window.transferrinSat } : {}),
    ...(window.crp !== undefined ? { crp: window.crp } : {}),
    ...(window.pth !== undefined ? { pth: window.pth } : {}),
    ...(window.calcium !== undefined ? { calcium: window.calcium } : {}),
  });
  const drivers = ESA_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance }))
    .sort((a, b) => b.relevance - a.relevance);
  const current = Math.max(0, window.currentDose);
  const inTargetBand = window.currentHgb >= HGB_TARGET.min && window.currentHgb <= HGB_TARGET.max;

  const base: EsaRecommendation & { coverage: EsaCoverageVerdict } = {
    patientId: window.patientId,
    inTargetBand,
    guardrails,
    latent,
    currentDose: current,
    recommendedDose: null,
    delta: 0,
    direction: 'blocked' as EsaDirection,
    drivers,
    model: ESA_MPC_MODEL,
    synthetic: true,
    note: 'MPC controller blocked this window.',
    coverage,
  };

  if (guardrails.blocked) {
    return { recommendation: { ...base, note: guardrails.blockReason ?? base.note }, whatIf };
  }
  if (!coverage.covered) {
    return { recommendation: { ...base, note: coverage.reason ?? base.note }, whatIf };
  }

  const chosen = whatIf.chosenIndex !== null && whatIf.chosenIndex !== undefined
    ? whatIf.candidates[whatIf.chosenIndex]
    : undefined;
  if (!chosen) return { recommendation: base, whatIf };

  const step = ESA_DOSE_STEP;
  let direction: EsaDirection;
  let recommendedDose: number;
  if (chosen.dose <= 0 && window.onESA) {
    direction = 'suspend'; recommendedDose = 0;
  } else if (chosen.dose > current + step / 2) {
    direction = 'increase'; recommendedDose = chosen.dose;
  } else if (chosen.dose < current - step / 2) {
    direction = chosen.dose <= 0 ? 'suspend' : 'reduce'; recommendedDose = chosen.dose;
  } else {
    direction = 'hold'; recommendedDose = chosen.dose;
  }

  const note = whatIf.blocked
    ? (whatIf.blockReason ?? base.note)
    : `${whatIf.note} MPC projects ${chosen.weeksInBand}/${whatIf.horizonWeeks} weeks in band — Class C review required.`;

  return {
    recommendation: {
      ...base,
      recommendedDose,
      delta: recommendedDose - current,
      direction,
      note,
    },
    whatIf,
  };
}

export const ESA_MPC_REFERENCE = { advisor: ESA_ADVISOR_MODEL, controller: ESA_MPC_MODEL };
