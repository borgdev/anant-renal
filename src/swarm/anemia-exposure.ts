/******************************************************************************
 * Anemia / ESA PK exposure features — Paper A (Zhao et al., Blood Purif 2026).
 *
 * The transformer paper's key modelling contribution the platform lacked: ESA
 * effect depends on CUMULATIVE, TIME-WEIGHTED exposure, not the last ordered
 * dose. We decay every administration by its 130 h half-life (Mircera), track
 * the dose–time product and the 14-day IV-iron load, and derive an
 * "exposure intensity" = decayed activity ÷ the steady-state activity the
 * ordered dose would produce. That yields an effective weekly dose which falls
 * when doses lapse / are held and rises as a new order accumulates.
 *
 * Pure + deterministic (no IO). With no dosing history the readout degrades
 * gracefully to the nominal window dose (basis 'window'), so every existing
 * caller keeps its current behaviour.
 ******************************************************************************/

import type { EsaPatientWindow } from './anemia.js';

/** Mircera (methoxy PEG-epoetin beta) terminal half-life, per Paper A. */
export const ESA_HALF_LIFE_HOURS = 130;
/** Exposure look-back window. */
export const ESA_EXPOSURE_WINDOW_DAYS = 90;
/** IV-iron co-intervention window (Paper A: cumulative iron in prior 14 days). */
export const ESA_IRON_WINDOW_DAYS = 14;
/** Assumed dosing cadence when it cannot be inferred from history. */
export const ESA_DEFAULT_INTERVAL_DAYS = 7;

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round = (v: number, digits = 0): number => {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
};

/** Exponential decay weight: 0.5 at exactly one half-life. */
export function esaDecayWeight(ageHours: number, halfLifeHours: number = ESA_HALF_LIFE_HOURS): number {
  if (ageHours < 0) return 0;
  return 2 ** (-ageHours / halfLifeHours);
}

/** Steady-state decayed activity of a repeated dose at a fixed interval. */
export function esaSteadyStateFactor(intervalDays: number, halfLifeHours: number = ESA_HALF_LIFE_HOURS): number {
  const perDose = 2 ** (-(intervalDays * HOURS_PER_DAY) / halfLifeHours);
  return 1 / (1 - clamp(perDose, 0, 0.999999));
}

export interface EsaExposureFeature {
  id: string;
  label: string;
  unit: string;
  value: number;
  detail: string;
}

/** Paper-A exposure feature catalog (separate from the trained-model vector). */
export const ESA_EXPOSURE_CATALOG: readonly { id: string; label: string; unit: string; detail: string }[] = [
  { id: 'effectiveWeeklyDose', label: 'Effective weekly dose', unit: 'u/wk', detail: 'Ordered dose scaled by exposure intensity (130 h decay)' },
  { id: 'nominalWeeklyDose', label: 'Ordered weekly dose', unit: 'u/wk', detail: 'Most recent ESA order' },
  { id: 'exposureIntensity', label: 'Exposure intensity', unit: 'ratio', detail: 'Decayed activity ÷ steady-state for the ordered dose' },
  { id: 'decayedActivity', label: 'Decayed activity on board', unit: 'u', detail: 'Σ dose × 2^(−age/130 h) over 90 days' },
  { id: 'cumulativeDose90d', label: 'Cumulative dose (90 d)', unit: 'u', detail: 'Raw Σ ESA units administered in 90 days' },
  { id: 'timeWeightedExposure90d', label: 'Time-weighted exposure (90 d)', unit: 'u', detail: 'Σ dose × decay weight (pharmacokinetically informed)' },
  { id: 'doseTimeProduct', label: 'Dose–time product', unit: 'u·d', detail: 'Σ dose × days since administration' },
  { id: 'cumulativeIron14d', label: 'IV iron (14 d)', unit: 'mg', detail: 'Σ elemental iron administered in the last 14 days' },
  { id: 'daysSinceLastDose', label: 'Days since last ESA', unit: 'd', detail: 'Age of the most recent administration' },
];

export interface EsaExposureReadout {
  /** 'history' when administrations were supplied, else 'window' (nominal). */
  basis: 'history' | 'window';
  halfLifeHours: number;
  intervalDays: number;
  administrations: number;
  nominalWeeklyDose: number;
  effectiveWeeklyDose: number;
  exposureIntensity: number;
  decayedActivity: number;
  cumulativeDose90d: number;
  timeWeightedExposure90d: number;
  doseTimeProduct: number;
  cumulativeIron14d: number;
  daysSinceLastDose: number | null;
  features: EsaExposureFeature[];
}

export interface EsaExposureOptions {
  asOf?: string;
  halfLifeHours?: number;
  intervalDays?: number;
}

function inferIntervalDays(history: readonly { atMs: number }[]): number | null {
  if (history.length < 2) return null;
  const times = history.map((h) => h.atMs).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (times.length < 2) return null;
  // Median gap between administrations (robust to a single outlier).
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    if (prev === undefined || cur === undefined) continue;
    gaps.push((cur - prev) / MS_PER_DAY);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? (gaps[mid] ?? 7) : (((gaps[mid - 1] ?? 7) + (gaps[mid] ?? 7)) / 2);
  return clamp(median, 1, 90);
}

/**
 * PK exposure readout for a patient window. Decays every ESA administration by
 * the configured half-life over a 90-day look-back and expresses the result as
 * an effective weekly dose (steady-state intensity = 1).
 */
export function esaExposure(window: EsaPatientWindow, opts: EsaExposureOptions = {}): EsaExposureReadout {
  const halfLife = opts.halfLifeHours ?? ESA_HALF_LIFE_HOURS;
  const asOfMs = Date.parse(opts.asOf ?? window.asOf ?? new Date().toISOString());
  const usableAsOf = Number.isFinite(asOfMs) ? asOfMs : Date.now();

  const history = (window.esaDosingHistory ?? [])
    .filter((h) => Number.isFinite(Date.parse(h.at)) && Number.isFinite(h.dose) && h.dose >= 0)
    .map((h) => ({ atMs: Date.parse(h.at), dose: h.dose }))
    .filter((h) => h.atMs <= usableAsOf)
    .sort((a, b) => a.atMs - b.atMs);

  const nominal = history.length
    ? (history[history.length - 1]?.dose ?? 0)
    : Math.max(0, window.currentDose ?? 0);

  const intervalDays = opts.intervalDays ?? inferIntervalDays(history) ?? ESA_DEFAULT_INTERVAL_DAYS;

  let decayedActivity = 0;
  let cumulativeDose90d = 0;
  let doseTimeProduct = 0;
  let latestMs: number | null = null;
  let inWindowCount = 0;
  for (const h of history) {
    const ageDays = (usableAsOf - h.atMs) / MS_PER_DAY;
    if (ageDays < 0 || ageDays > ESA_EXPOSURE_WINDOW_DAYS) continue;
    const ageHours = ageDays * HOURS_PER_DAY;
    decayedActivity += h.dose * esaDecayWeight(ageHours, halfLife);
    cumulativeDose90d += h.dose;
    doseTimeProduct += h.dose * ageDays;
    latestMs = latestMs === null ? h.atMs : Math.max(latestMs, h.atMs);
    inWindowCount += 1;
  }

  const ironHistory = (window.ivIronHistory ?? [])
    .filter((i) => Number.isFinite(Date.parse(i.at)) && Number.isFinite(i.mg) && i.mg > 0)
    .filter((i) => {
      const ageDays = (usableAsOf - Date.parse(i.at)) / MS_PER_DAY;
      return ageDays >= 0 && ageDays <= ESA_IRON_WINDOW_DAYS;
    });
  const cumulativeIron14d = round(ironHistory.reduce((sum, i) => sum + i.mg, 0));

  const steadyState = esaSteadyStateFactor(intervalDays, halfLife);
  const exposureIntensity = history.length && nominal > 0
    ? clamp(decayedActivity / (nominal * steadyState), 0, 3)
    : 1;
  const effectiveWeeklyDose = history.length ? round(nominal * exposureIntensity) : nominal;
  const daysSinceLastDose = latestMs === null ? null : round((usableAsOf - latestMs) / MS_PER_DAY, 1);

  const features: EsaExposureFeature[] = [
    { id: 'effectiveWeeklyDose', label: 'Effective weekly dose', unit: 'u/wk', value: effectiveWeeklyDose, detail: `${nominal.toLocaleString()} ordered × ${round(exposureIntensity, 2)} intensity` },
    { id: 'nominalWeeklyDose', label: 'Ordered weekly dose', unit: 'u/wk', value: nominal, detail: history.length ? 'Most recent administration' : 'No dosing history — nominal window dose' },
    { id: 'exposureIntensity', label: 'Exposure intensity', unit: 'ratio', value: round(exposureIntensity, 3), detail: `${round(steadyState, 2)}× steady state for ${intervalDays}-day cadence` },
    { id: 'decayedActivity', label: 'Decayed activity on board', unit: 'u', value: round(decayedActivity), detail: `130 h half-life over ${inWindowCount} administration(s)` },
    { id: 'cumulativeDose90d', label: 'Cumulative dose (90 d)', unit: 'u', value: round(cumulativeDose90d), detail: `${inWindowCount} administration(s) in 90 days` },
    { id: 'timeWeightedExposure90d', label: 'Time-weighted exposure (90 d)', unit: 'u', value: round(decayedActivity), detail: 'Σ dose × decay weight' },
    { id: 'doseTimeProduct', label: 'Dose–time product', unit: 'u·d', value: round(doseTimeProduct), detail: 'Σ dose × days since administration' },
    { id: 'cumulativeIron14d', label: 'IV iron (14 d)', unit: 'mg', value: cumulativeIron14d, detail: `${ironHistory.length} iron administration(s)` },
    { id: 'daysSinceLastDose', label: 'Days since last ESA', unit: 'd', value: daysSinceLastDose ?? 0, detail: daysSinceLastDose === null ? 'No administration on record' : 'Age of the most recent dose' },
  ];

  return {
    basis: history.length ? 'history' : 'window',
    halfLifeHours: halfLife,
    intervalDays: round(intervalDays, 2),
    administrations: history.length,
    nominalWeeklyDose: nominal,
    effectiveWeeklyDose,
    exposureIntensity: round(exposureIntensity, 3),
    decayedActivity: round(decayedActivity),
    cumulativeDose90d: round(cumulativeDose90d),
    timeWeightedExposure90d: round(decayedActivity),
    doseTimeProduct: round(doseTimeProduct),
    cumulativeIron14d,
    daysSinceLastDose,
    features,
  };
}

/** Effective weekly dose (nominal window dose when no history is supplied). */
export function esaEffectiveWeeklyDose(window: EsaPatientWindow, opts: EsaExposureOptions = {}): number {
  return esaExposure(window, opts).effectiveWeeklyDose;
}
