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

// F2 — Mechanistic priors shared by every renal protocol head.
//
// These are the *physics* half of the shared-state model: published, monotone,
// interpretable relationships that a learned head only has to correct — never
// rediscover. Sources are the standard renal-physiology references used in the
// implementation strategy doc:
//   • Daugirdas JT. Second generation logarithmic estimates of single-pool
//     variable volume Kt/V. J Am Soc Nephrol. 1993;4(5):1205-13.
//   • KDOQI 2015 hemodialysis adequacy update (target spKt/V ≥ 1.2, ≥ 1.4 when
//     frequent/prescribed higher).
//   • Single-pool urea kinetics: URR ≈ 1 − e^(−Kt/V).
//   • Phosphate-binder binding-capacity ranges (binder class, mg PO4 bound per g).
//
// All outputs are priors for decision support on SYNTHETIC data — not device
// control, not a prescription.

export const KTV_TARGET = 1.2;
export const KTV_TARGET_FREQUENT = 1.4;
/** Daugirdas 1993 constants. */
export const DAUGIRDAS_UF_COEFF = 3.5;
export const DAUGIRDAS_INTERCEPT = 4;
export const DAUGIRDAS_TIME_COEFF = 0.008;
/** Reference predialysis urea/creatinine ceilings used by the heads. */
export const URR_FLOOR_PCT = 60;

export interface SpKtVInput {
  preUrea: number;
  postUrea: number;
  durationHours: number;
  ufVolumeL: number;
  postWeightKg: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Daugirdas second-generation single-pool Kt/V from measured pre/post urea.
 * spKt/V = −ln(R − 0.008·t) + (4 − 3.5·R)·UF/W  with R = postUrea / preUrea.
 * Returns undefined when inputs are unusable (R ≤ 0.008·t ⇒ undialyzable).
 */
export function daugirdasSpKtV(input: SpKtVInput): number | undefined {
  const { preUrea, postUrea, durationHours, ufVolumeL, postWeightKg } = input;
  if (!(preUrea > 0) || !(postUrea > 0) || !(durationHours > 0) || !(postWeightKg > 0)) return undefined;
  const r = postUrea / preUrea;
  const inner = r - DAUGIRDAS_TIME_COEFF * durationHours;
  if (inner <= 0) return undefined;
  const ufTerm = ((DAUGIRDAS_INTERCEPT - DAUGIRDAS_UF_COEFF * r) * ufVolumeL) / postWeightKg;
  return Math.round((-Math.log(inner) + ufTerm) * 100) / 100;
}

/** Single-pool Kt/V implied by a measured URR (R = 1 − URR). */
export function spKtVFromUrr(input: { urrPct: number; durationHours: number; ufVolumeL: number; postWeightKg: number }): number | undefined {
  const urr = clamp(input.urrPct, 1, 99.5) / 100;
  return daugirdasSpKtV({
    preUrea: 100,
    postUrea: 100 * (1 - urr),
    durationHours: input.durationHours,
    ufVolumeL: input.ufVolumeL,
    postWeightKg: input.postWeightKg,
  });
}

/** URR (%) from single-pool Kt/V ignoring ultrafiltration (inverse check). */
export function ktvToUrr(ktv: number): number {
  if (!(ktv > 0)) return 0;
  return Math.round((1 - Math.exp(-ktv)) * 1000) / 10;
}

/** Single-pool Kt/V from a URR (no UF term). */
export function urrToKtv(urrPct: number): number {
  const urr = clamp(urrPct, 0.1, 99.5) / 100;
  return Math.round(-Math.log(1 - urr) * 100) / 100;
}

/**
 * Minimum treatment time (hours) to reach a target spKt/V, given the delivered
 * clearance and urea distribution volume. Kt/V scales linearly with time, so the
 * required time is target · V / K (minutes → hours).
 */
export function minDurationHoursForTarget(input: { targetSpKtV: number; clearanceMlMin: number; volumeL: number }): number | undefined {
  const { targetSpKtV, clearanceMlMin, volumeL } = input;
  if (!(clearanceMlMin > 0) || !(volumeL > 0) || !(targetSpKtV > 0)) return undefined;
  const minutes = (targetSpKtV * volumeL * 1000) / clearanceMlMin;
  return Math.round((minutes / 60) * 10) / 10;
}

/**
 * Urea distribution volume estimate (Watson-style anthropometric prior, mL→L).
 * Used when V is not measured — a prior, never a substitute for urea kinetics.
 */
export function estimatedUreaVolumeL(input: { weightKg: number; heightCm: number; age: number; sex: 'F' | 'M' }): number {
  const { weightKg, heightCm, age, sex } = input;
  const base = sex === 'M'
    ? 2.447 - 0.09516 * age + 0.1074 * heightCm + 0.3362 * weightKg
    : -2.097 + 0.1069 * heightCm + 0.2466 * weightKg;
  return Math.round(base * 10) / 10;
}

/** Standardized Kt/V (weekly) from per-session spKt/V × sessions/week. */
export function weeklyKtV(perSessionSpKtV: number, sessionsPerWeek: number): number {
  return Math.round(perSessionSpKtV * sessionsPerWeek * 100) / 100;
}

export interface AdequacyPriorInput {
  spKtV?: number | undefined;
  urrPct?: number | undefined;
  sessionsPerWeek?: number | undefined;
  prescribedMinutes?: number | undefined;
  deliveredMinutes?: number | undefined;
}

export interface AdequacyPrior {
  spKtV?: number;
  urrPct?: number;
  weeklyKtV?: number;
  meetsTarget: boolean;
  /** delivered / prescribed treatment time, % */
  timeAdherencePct?: number;
  drivers: string[];
}

/** Mechanistic adequacy prior from session facts — the adequacy head's baseline. */
export function adequacyPrior(input: AdequacyPriorInput): AdequacyPrior {
  const sessionsPerWeek = input.sessionsPerWeek ?? 3;
  const spKtV = input.spKtV ?? (input.urrPct !== undefined
    ? spKtVFromUrr({ urrPct: input.urrPct, durationHours: 4, ufVolumeL: 2.5, postWeightKg: 70 })
    : undefined);
  const urrPct = input.urrPct ?? (spKtV !== undefined ? ktvToUrr(spKtV) : undefined);
  const wk = spKtV !== undefined ? weeklyKtV(spKtV, sessionsPerWeek) : undefined;
  const timeAdherencePct = input.prescribedMinutes && input.deliveredMinutes
    ? Math.round((input.deliveredMinutes / input.prescribedMinutes) * 100)
    : undefined;
  const drivers: string[] = [];
  if (spKtV !== undefined && spKtV < KTV_TARGET) drivers.push(`spKt/V ${spKtV} below target ${KTV_TARGET}`);
  if (urrPct !== undefined && urrPct < URR_FLOOR_PCT) drivers.push(`URR ${urrPct}% below ${URR_FLOOR_PCT}% floor`);
  if (timeAdherencePct !== undefined && timeAdherencePct < 90) drivers.push(`shortened treatments (${timeAdherencePct}% of prescribed time)`);
  if (sessionsPerWeek < 3) drivers.push(`${sessionsPerWeek} sessions/week (below thrice-weekly)`);
  return {
    ...(spKtV !== undefined ? { spKtV } : {}),
    ...(urrPct !== undefined ? { urrPct } : {}),
    ...(wk !== undefined ? { weeklyKtV: wk } : {}),
    meetsTarget: spKtV !== undefined ? spKtV >= KTV_TARGET : (urrPct ?? 0) >= URR_FLOOR_PCT,
    ...(timeAdherencePct !== undefined ? { timeAdherencePct } : {}),
    drivers,
  };
}

// ---- Volume / fluid ----

export const IDWG_FLAG_KG = 2.5;
export const UF_ACHIEVEMENT_FLOOR_PCT = 90;
export const NADIR_SBP_FLOOR = 90;

export interface FluidPriorInput {
  avgIdwgKg?: number | undefined;
  avgUfAchievementPct?: number | undefined;
  minNadirSbp?: number | undefined;
  avgDeliveredMinutes?: number | undefined;
  dryWeightKg?: number | undefined;
}

export interface FluidPrior {
  /** IDWG as % of body weight (falls back to a 70 kg reference when unknown). */
  idwgPctBodyWeight?: number;
  /** prescribed UF rate implied by IDWG over a 48h interval, mL/h */
  ufRateMlH?: number;
  volumeOverloaded: boolean;
  ufUndelivered: boolean;
  intradialyticHypotension: boolean;
  drivers: string[];
}

/** Mechanistic fluid prior: IDWG → UF demand → achievable rate → hypotension risk. */
export function fluidPrior(input: FluidPriorInput): FluidPrior {
  const refWeight = input.dryWeightKg ?? 70;
  const idwgPctBodyWeight = input.avgIdwgKg !== undefined ? Math.round((input.avgIdwgKg / refWeight) * 1000) / 10 : undefined;
  const ufRateMlH = input.avgIdwgKg !== undefined ? Math.round((input.avgIdwgKg * 1000) / 48) : undefined;
  const drivers: string[] = [];
  const volumeOverloaded = (input.avgIdwgKg ?? 0) > IDWG_FLAG_KG || (idwgPctBodyWeight ?? 0) > 4;
  const ufUndelivered = (input.avgUfAchievementPct ?? 100) < UF_ACHIEVEMENT_FLOOR_PCT;
  const intradialyticHypotension = (input.minNadirSbp ?? 999) < NADIR_SBP_FLOOR;
  if (volumeOverloaded) drivers.push(`IDWG ${input.avgIdwgKg} kg (>${IDWG_FLAG_KG} kg) — volume overload`);
  if (ufUndelivered) drivers.push(`UF only ${input.avgUfAchievementPct}% of target`);
  if (intradialyticHypotension) drivers.push(`nadir SBP ${input.minNadirSbp} mmHg (<${NADIR_SBP_FLOOR})`);
  if ((input.avgDeliveredMinutes ?? 999) < 200) drivers.push(`mean delivered time ${input.avgDeliveredMinutes} min`);
  return {
    ...(idwgPctBodyWeight !== undefined ? { idwgPctBodyWeight } : {}),
    ...(ufRateMlH !== undefined ? { ufRateMlH } : {}),
    volumeOverloaded,
    ufUndelivered,
    intradialyticHypotension,
    drivers,
  };
}

// ---- Potassium / electrolytes ----

export const K_DIALYSIS_FLOOR = 3.5;
export const K_HYPERKALEMIA = 5.5;

/** Exponential inter-dialytic decay toward the dialytic floor given per-session Kt/V. */
export function potassiumAfterSession(currentK: number, spKtV: number): number {
  if (!(spKtV > 0)) return currentK;
  return Math.round((K_DIALYSIS_FLOOR + (currentK - K_DIALYSIS_FLOOR) * Math.exp(-0.45 * spKtV)) * 100) / 100;
}

/** Predialysis potassium rebound across an inter-dialytic interval (h) at a daily load. */
export function potassiumRebound(postK: number, hoursSince: number, loadMmPerDay = 55): number {
  return Math.round((postK + (loadMmPerDay / 24) * hoursSince * 0.006) * 100) / 100;
}

// ---- CKD-MBD / phosphate ----

/** Phosphate binding capacity per gram of binder (mg PO4 bound/g) — literature ranges. */
export const BINDER_CAPACITY_MG_PER_G: Record<string, number> = {
  sevelamer: 25,
  'calcium-acetate': 45,
  'calcium-carbonate': 39,
  lanthanum: 90,
  'sucroferric-oxyhydroxide': 22,
};

export interface PhosphatePriorInput {
  phosMgDl?: number | undefined;
  binderCodes?: readonly string[] | undefined;
  binderDoseMgPerDay?: number | undefined;
  spKtV?: number | undefined;
  sessionsPerWeek?: number | undefined;
  calciumMgDl?: number | undefined;
  pthPgMl?: number | undefined;
}

export interface PhosphatePrior {
  /** mg of PO4 removed by binders per day. */
  boundMgPerDay: number;
  /** dialytic clearance proxy: weekly Kt/V weighted phosphate removal index */
  dialyticRemovalIndex?: number;
  inTarget: boolean;
  drivers: string[];
}

export const PHOS_TARGET_MAX_MG_DL = 5.5;

/**
 * Phosphate prior: dietary load minus binder binding minus dialytic removal.
 * Dialytic removal is proxied by standardized weekly Kt/V (higher clearance →
 * more phosphate removed), which is how the adequacy and MBD heads stay coupled.
 */
export function phosphatePrior(input: PhosphatePriorInput): PhosphatePrior {
  const doseMgPerDay = input.binderDoseMgPerDay ?? 2400 * (input.binderCodes?.length ? 1 : 0);
  const capacity = (input.binderCodes ?? []).reduce((acc, code) => {
    const c = BINDER_CAPACITY_MG_PER_G[code] ?? 25;
    return Math.max(acc, c);
  }, 0);
  const boundMgPerDay = Math.round((doseMgPerDay / 1000) * capacity);
  const dialyticRemovalIndex = input.spKtV !== undefined
    ? Math.round(weeklyKtV(input.spKtV, input.sessionsPerWeek ?? 3) * 100) / 100
    : undefined;
  const drivers: string[] = [];
  const inTarget = (input.phosMgDl ?? 0) <= PHOS_TARGET_MAX_MG_DL;
  if (!inTarget) drivers.push(`phosphate ${input.phosMgDl} mg/dL above ${PHOS_TARGET_MAX_MG_DL}`);
  if ((input.binderCodes ?? []).length === 0) drivers.push('no phosphate binder on the medication record');
  if ((input.calciumMgDl ?? 9.0) > 10.2) drivers.push(`calcium ${input.calciumMgDl} mg/dL (hypercalcemia — limits calcium-based binders)`);
  if ((input.pthPgMl ?? 300) > 600) drivers.push(`PTH ${input.pthPgMl} pg/mL (>600 — secondary hyperparathyroidism)`);
  return {
    boundMgPerDay,
    ...(dialyticRemovalIndex !== undefined ? { dialyticRemovalIndex } : {}),
    inTarget,
    drivers,
  };
}

// ---- Nutrition ----

export const ALBUMIN_FLOOR_G_DL = 3.5;
export const PEW_ALBUMIN_FLOOR_G_DL = 3.5;
export const CRP_INFLAMMATION_MG_L = 10;

export interface NutritionPrior {
  proteinEnergyWastingRisk: boolean;
  inflammatoryBurden: boolean;
  /** normalized protein catabolic rate proxy, g/kg/day from URR + Kt/V demand */
  npcrProxy?: number;
  drivers: string[];
}

/** Nutrition prior: albumin + inflammation + delivered clearance (PEW/MICS pattern). */
export function nutritionPrior(input: { albuminGdL?: number | undefined; crpMgL?: number | undefined; spKtV?: number | undefined; idwgKg?: number | undefined }): NutritionPrior {
  const albumin = input.albuminGdL;
  const crp = input.crpMgL;
  const proteinEnergyWastingRisk = (albumin ?? 99) < PEW_ALBUMIN_FLOOR_G_DL;
  const inflammatoryBurden = (crp ?? 0) > CRP_INFLAMMATION_MG_L;
  const npcrProxy = input.spKtV !== undefined ? Math.round((0.8 + 0.45 * input.spKtV) * 100) / 100 : undefined;
  const drivers: string[] = [];
  if (proteinEnergyWastingRisk) drivers.push(`albumin ${albumin} g/dL below ${ALBUMIN_FLOOR_G_DL}`);
  if (inflammatoryBurden) drivers.push(`CRP ${crp} mg/L — inflammation-driven malnutrition (MICS)`);
  if (npcrProxy !== undefined && npcrProxy < 1.0) drivers.push(`low normalized protein catabolic rate proxy ${npcrProxy} g/kg/day`);
  return {
    proteinEnergyWastingRisk,
    inflammatoryBurden,
    ...(npcrProxy !== undefined ? { npcrProxy } : {}),
    drivers,
  };
}

// ---- Infection ----

export const TEMP_FEVER_C = 38;
export const PCT_SEPSIS_NG_ML = 0.5;
export const WBC_HIGH = 12;
/** CDC NHSN access-infection surveillance window after a positive culture draw. */
export const ACCESS_INFECTION_WINDOW_DAYS = 7;

export interface InfectionPrior {
  /** deterministic CDC-style criteria flag — never model-derived (compliance inputs are rules). */
  meetsSurveillanceCriteria: boolean;
  /** model-derived triage score in [0,1] used only to prioritize human review. */
  triageScore: number;
  drivers: string[];
}

/**
 * Split-priority infection prior: deterministic surveillance criteria (rules,
 * CDC NHSN — used for reporting/compliance) are kept separate from the ML
 * triage score (used only to rank who a human reviews first).
 */
export function infectionPrior(input: {
  tempC?: number | undefined;
  wbc?: number | undefined;
  procalcitoninNgMl?: number | undefined;
  crpMgL?: number | undefined;
  accessType?: string | undefined;
  accessEvent?: string | undefined;
}): InfectionPrior {
  const fever = (input.tempC ?? 0) > TEMP_FEVER_C;
  const leukocytosis = (input.wbc ?? 0) > WBC_HIGH;
  const pctHigh = (input.procalcitoninNgMl ?? 0) > PCT_SEPSIS_NG_ML;
  const crpHigh = (input.crpMgL ?? 0) > CRP_INFLAMMATION_MG_L;
  const accessSignal = input.accessEvent === 'infection' || input.accessEvent === 'thrombosis';
  const meetsSurveillanceCriteria = fever && (leukocytosis || pctHigh);
  const parts = [fever ? 1 : 0, leukocytosis ? 1 : 0, pctHigh ? 1 : 0, crpHigh ? 0.5 : 0, accessSignal ? 0.5 : 0, input.accessType === 'catheter' ? 0.5 : 0];
  const maxScore = 4.5;
  const triageScore = Math.round((parts.reduce((a, b) => a + b, 0) / maxScore) * 100) / 100;
  const drivers: string[] = [];
  if (fever) drivers.push(`temperature ${input.tempC} °C`);
  if (leukocytosis) drivers.push(`WBC ${input.wbc} ×10³/µL`);
  if (pctHigh) drivers.push(`procalcitonin ${input.procalcitoninNgMl} ng/mL`);
  if (accessSignal) drivers.push(`access event: ${input.accessEvent}`);
  if (input.accessType === 'catheter') drivers.push('central venous catheter in place (highest access infection risk)');
  return { meetsSurveillanceCriteria, triageScore, drivers };
}

// ---- Anemia (ESA PK re-export so every head reads one set of constants) ----

export { ESA_HALF_LIFE_HOURS, esaDecayWeight, esaSteadyStateFactor } from '../swarm/anemia-exposure.js';

/** Predicted HGB response to a weekly ESA dose (Hill-type saturating prior). */
export const HGB_NO_ESA_BASELINE = 7.2;
export const HGB_MAX_ESA_GAIN = 4.8;
export const HGB_HALF_EFFECT_DOSE_UNITS = 4800;

export function hgbFromWeeklyDose(weeklyDoseUnits: number, opts: { ironReplete?: boolean; crpMgL?: number } = {}): number {
  const dose = Math.max(0, weeklyDoseUnits);
  const gain = HGB_MAX_ESA_GAIN * (dose / (dose + HGB_HALF_EFFECT_DOSE_UNITS));
  const ironFactor = opts.ironReplete === false ? 0.6 : 1;
  const inflammationFactor = (opts.crpMgL ?? 0) > CRP_INFLAMMATION_MG_L ? 0.75 : 1;
  return Math.round((HGB_NO_ESA_BASELINE + gain * ironFactor * inflammationFactor) * 100) / 100;
}

export const PRIOR_CATALOG = [
  { id: 'daugirdas-spktv', domain: 'adequacy', basis: 'Daugirdas 1993 single-pool Kt/V', reference: 'J Am Soc Nephrol 1993;4:1205-13' },
  { id: 'urr-ktv', domain: 'adequacy', basis: 'single-pool urea kinetics URR ≈ 1 − e^(−Kt/V)', reference: 'KDOQI 2015 HD adequacy' },
  { id: 'fluid-idwg', domain: 'fluid', basis: 'IDWG → UF demand → achievable rate → hypotension risk', reference: 'KDOQI 2015 volume management' },
  { id: 'potassium-decay', domain: 'nutrition-electrolytes', basis: 'exponential dialytic K decay to a 3.5 mmol/L floor', reference: 'Renal electrolyte physiology' },
  { id: 'phosphate-binding', domain: 'ckd-mbd', basis: 'binder class binding capacity (mg PO4 bound / g)', reference: 'Binder-class binding capacity ranges' },
  { id: 'infection-split', domain: 'infection', basis: 'CDC NHSN surveillance criteria separated from ML triage', reference: 'CDC NHSN Dialysis Event protocol' },
  { id: 'esa-hill', domain: 'anemia', basis: 'Hill-type saturating HGB response to weekly ESA dose', reference: 'Anemia CDS model card (anemia.esa-dose-v1)' },
] as const;
