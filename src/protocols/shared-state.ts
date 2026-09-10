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

// F2 — Shared continuous renal state + protocol heads.
//
// ONE state vector per patient feeds every protocol head. The state is
// normalized against clinical thresholds so a single encoder can serve seven
// protocols; each head then applies the mechanistic prior for its own domain and
// (once calibrated) a learned correction. Horizons are explicit, so the same
// state answers "what happens in a week" and "what happens in a month".
//
// Honesty notes:
//   • The latent is a documented, hand-specified clinical encoder (threshold
//     anchored), not a trained autoencoder. The trained temporal model remains
//     the CfC/LTC trajectory engine in src/liquid/ (compared via
//     /admin/liquid/compare).
//   • Backtests run on the synthetic longitudinal simulator; the split is
//     patient-level so no patient appears in both train and test.

import { generateLongitudinalHistory, type LongitudinalLabs, type LongitudinalTrajectory } from '../simulator/longitudinal.js';
import { compareForecasts, fitLogistic, fitRidgeLinear, predictLinear, predictLogistic, type ForecastComparison, type Sample, type LabeledSample } from './baselines.js';
import { auroc, brier, ece, forecastMetrics, mae, reliabilityBins, relativeImprovementPct, type ForecastMetrics, type ReliabilityBin } from './metrics.js';
import { patientLevelSplit, filterByPatientSplit, hasNoPatientOverlap, type PatientSplit } from './split.js';
import {
  adequacyPrior, fluidPrior, infectionPrior, nutritionPrior, phosphatePrior,
  hgbFromWeeklyDose, ktvToUrr, potassiumAfterSession, potassiumRebound, weeklyKtV,
  KTV_TARGET, URR_FLOOR_PCT, PHOS_TARGET_MAX_MG_DL, ALBUMIN_FLOOR_G_DL, K_HYPERKALEMIA,
} from './priors.js';
import type { RenalPatientFacts } from '../swarm/renal-cohort.js';

export type ProtocolId = 'fluid' | 'adequacy' | 'anemia' | 'access' | 'ckd-mbd' | 'nutrition-electrolytes' | 'infection';

export interface ProtocolSubstate { protocol: ProtocolId; substate: string; label: string; stateDims: readonly string[] }

/**
 * Shared-state substates. The implementation strategy (doc §1) proposed SF..SI
 * for four protocols; three more substates were added so all seven protocols
 * have an explicit slot in the single state vector.
 */
export const RENAL_SUBSTATES: readonly ProtocolSubstate[] = [
  { protocol: 'fluid', substate: 'SF', label: 'Volume / ultrafiltration', stateDims: ['idwgKg', 'ufAchievementPct', 'nadirSbp', 'adherencePct'] },
  { protocol: 'adequacy', substate: 'SG', label: 'Dialysis adequacy (clearance)', stateDims: ['urrPct', 'ktvPerSession', 'sessionsPerWeek', 'adherencePct'] },
  { protocol: 'anemia', substate: 'SH', label: 'Anemia / iron', stateDims: ['hgbGdl', 'ferritinNgMl', 'tsatPct', 'esaDoseUnits', 'crpMgL'] },
  { protocol: 'ckd-mbd', substate: 'SI', label: 'CKD-MBD (P / Ca / PTH)', stateDims: ['phosMgDl', 'calciumMgDl', 'pthPgMl'] },
  { protocol: 'nutrition-electrolytes', substate: 'SJ', label: 'Nutrition / electrolytes', stateDims: ['albuminGdL', 'potassium', 'bicarbMmolL', 'crpMgL'] },
  { protocol: 'access', substate: 'SK', label: 'Vascular access', stateDims: ['recirculationPct', 'accessRiskFlag', 'qbAvg'] },
  { protocol: 'infection', substate: 'SL', label: 'Infection / inflammation', stateDims: ['tempC', 'wbc', 'crpMgL', 'accessTypeFlag'] },
] as const;

export const RENAL_STATE_DIMS = [
  'idwgKg', 'ufAchievementPct', 'nadirSbp', 'adherencePct', 'recirculationPct', 'qbAvg',
  'urrPct', 'ktvPerSession', 'sessionsPerWeek',
  'hgbGdl', 'ferritinNgMl', 'tsatPct', 'esaDoseUnits', 'crpMgL',
  'phosMgDl', 'calciumMgDl', 'pthPgMl',
  'albuminGdL', 'potassium', 'bicarbMmolL',
  'tempC', 'wbc', 'accessRiskFlag', 'accessTypeFlag',
] as const;
export type RenalStateDim = (typeof RENAL_STATE_DIMS)[number];

export type DimBag = Partial<Record<RenalStateDim, number>>;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/**
 * 0 when healthy (at/beyond `good` in the healthy direction), 1 when at/beyond
 * `bad`. Direction-agnostic: pass good < bad for "higher is worse" dims and
 * good > bad for "lower is worse" dims.
 */
const press = (value: number | undefined, good: number, bad: number): number => {
  if (value === undefined) return 0;
  if (good === bad) return value >= bad ? 1 : 0;
  return clamp01((value - good) / (bad - good));
};
const span = (value: number | undefined, lo: number, hi: number): number => {
  if (value === undefined) return 0;
  return clamp01((value - lo) / (hi - lo));
};

export interface RenalState {
  patientId: string;
  asOf?: string;
  dims: DimBag;
  /** Normalized 0..1 severity per substate, index-aligned with RENAL_SUBSTATES. */
  latent: number[];
  /** Mean substate severity — the global instability index. */
  instabilityIndex: number;
  provenance: 'realm-patient-state' | 'longitudinal-simulator' | 'caller';
}

/** Shared encoder: dims → normalized severities (index-aligned with RENAL_SUBSTATES). */
export function latentFromDims(dims: DimBag): number[] {
  const fluid = Math.max(
    press(dims.idwgKg, 1.5, 5),
    press(dims.ufAchievementPct, 100, 70),
    press(dims.nadirSbp, 100, 85),
  );
  const adequacy = Math.max(press(dims.urrPct, 70, URR_FLOOR_PCT), press(dims.ktvPerSession, 1.4, 1.0), press(dims.adherencePct, 95, 75));
  const anemia = Math.max(press(dims.hgbGdl, 11, 8), press(dims.tsatPct, 30, 15), press(dims.ferritinNgMl, 300, 100), press(dims.crpMgL, 5, 20));
  const mbd = Math.max(
    press(dims.phosMgDl, PHOS_TARGET_MAX_MG_DL, 7.5),
    Math.max(press(dims.calciumMgDl, 10.2, 11.2), press(dims.calciumMgDl, 8.4, 7.6)),
    press(dims.pthPgMl, 300, 900),
  );
  const nutrition = Math.max(press(dims.albuminGdL, ALBUMIN_FLOOR_G_DL, 2.8), press(dims.potassium, K_HYPERKALEMIA, 6.5), press(dims.bicarbMmolL, 22, 16));
  const access = Math.max(press(dims.recirculationPct, 8, 20), dims.accessRiskFlag ?? 0);
  const infection = Math.max(
    press(dims.tempC, 37.2, 39),
    press(dims.wbc, 11, 16),
    press(dims.crpMgL, 10, 40),
    (dims.accessTypeFlag ?? 0) * 0.8,
  );
  const rows = [fluid, adequacy, anemia, mbd, nutrition, access, infection].map((v) => Math.round(clamp01(v) * 1000) / 1000);
  const global = Math.round((rows.reduce((a, b) => a + b, 0) / rows.length) * 1000) / 1000;
  return [...rows, global];
}

/** Build the shared state from a patient's renal facts (realm-derived). */
export function buildRenalState(facts: RenalPatientFacts): RenalState {
  const adequacy = adequacyPrior({
    ...(facts.labs.URR !== undefined ? { urrPct: facts.labs.URR } : {}),
    // time-adherence driver: prescribed = 100 so delivered = adherence %
    ...(facts.sessions.avgAdherencePct !== undefined ? { prescribedMinutes: 100, deliveredMinutes: facts.sessions.avgAdherencePct } : {}),
  });
  const dims: DimBag = {
    ...(facts.sessions.avgIdwgKg !== undefined ? { idwgKg: facts.sessions.avgIdwgKg } : {}),
    ...(facts.sessions.avgUfAchievementPct !== undefined ? { ufAchievementPct: facts.sessions.avgUfAchievementPct } : {}),
    ...(facts.sessions.minNadirSbp !== undefined ? { nadirSbp: facts.sessions.minNadirSbp } : {}),
    ...(facts.sessions.avgAdherencePct !== undefined ? { adherencePct: facts.sessions.avgAdherencePct } : {}),
    ...(facts.sessions.avgRecirculationPct !== undefined ? { recirculationPct: facts.sessions.avgRecirculationPct } : {}),
    ...(facts.labs.URR !== undefined ? { urrPct: facts.labs.URR } : {}),
    ...(adequacy.spKtV !== undefined ? { ktvPerSession: adequacy.spKtV } : {}),
    sessionsPerWeek: 3,
    ...(facts.labs.HGB !== undefined ? { hgbGdl: facts.labs.HGB } : {}),
    ...(facts.labs.FERRITIN !== undefined ? { ferritinNgMl: facts.labs.FERRITIN } : {}),
    ...(facts.labs.TSAT !== undefined ? { tsatPct: facts.labs.TSAT } : {}),
    ...(facts.exposure.esaDoseUnits !== undefined ? { esaDoseUnits: facts.exposure.esaDoseUnits } : {}),
    ...(facts.labs.crp !== undefined ? { crpMgL: facts.labs.crp } : {}),
    ...(facts.labs.PHOS !== undefined ? { phosMgDl: facts.labs.PHOS } : {}),
    ...(facts.labs.calcium !== undefined ? { calciumMgDl: facts.labs.calcium } : {}),
    ...(facts.labs.pth !== undefined ? { pthPgMl: facts.labs.pth } : {}),
    ...(facts.labs.albumin !== undefined ? { albuminGdL: facts.labs.albumin } : {}),
    ...(facts.labs.K !== undefined ? { potassium: facts.labs.K } : {}),
    ...(facts.labs.bicarb !== undefined ? { bicarbMmolL: facts.labs.bicarb } : {}),
    ...(facts.labs.wbc !== undefined ? { wbc: facts.labs.wbc } : {}),
    accessRiskFlag: facts.access.dysfunction ? 1 : 0,
    accessTypeFlag: facts.access.type === 'catheter' ? 1 : 0,
  };
  const temp = facts.vitals.tempC;
  if (typeof temp === 'number') dims.tempC = temp;
  const latent = latentFromDims(dims);
  return {
    patientId: facts.patientId,
    ...(facts.sessions.lastAt ? { asOf: facts.sessions.lastAt } : {}),
    dims,
    latent,
    instabilityIndex: latent[7]!,
    provenance: 'realm-patient-state',
  };
}

// ---- Multi-protocol, multi-horizon forecast from ONE state ----

export const RENAL_FORECAST_HORIZONS_DAYS = [7, 28, 84] as const;

export interface RenalForecast {
  protocol: ProtocolId;
  substate: string;
  label: string;
  target: string;
  unit: string;
  horizonDays: number;
  /** mechanistic prior value at the horizon */
  value: number;
  /** credibility band (documented per-target default), same units as value */
  band: { low: number; high: number };
  /** clinical target/threshold the value is judged against */
  threshold?: number;
  meetsTarget?: boolean;
  drivers: string[];
}

const bandsFor: Record<string, number> = {
  urrPct: 6,
  idwgKg: 0.6,
  hgbGdl: 0.6,
  phosMgDl: 0.7,
  potassium: 0.45,
  triageScore: 0.15,
  recirculationPct: 3.5,
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Forecast every protocol head at every horizon from a single shared state.
 * This is the F2 property under test: one latent state, ≥2 protocols, ≥2 horizons.
 */
export function forecastRenalState(state: RenalState, horizonsDays: readonly number[] = RENAL_FORECAST_HORIZONS_DAYS): RenalForecast[] {
  const d = state.dims;
  const adequacy = adequacyPrior({
    ...(d.urrPct !== undefined ? { urrPct: d.urrPct } : {}),
    ...(d.adherencePct !== undefined ? { prescribedMinutes: 100, deliveredMinutes: d.adherencePct } : {}),
    ...(d.sessionsPerWeek !== undefined ? { sessionsPerWeek: d.sessionsPerWeek } : {}),
  });
  const fluid = fluidPrior({
    ...(d.idwgKg !== undefined ? { avgIdwgKg: d.idwgKg } : {}),
    ...(d.ufAchievementPct !== undefined ? { avgUfAchievementPct: d.ufAchievementPct } : {}),
    ...(d.nadirSbp !== undefined ? { minNadirSbp: d.nadirSbp } : {}),
    ...(d.adherencePct !== undefined ? { avgDeliveredMinutes: d.adherencePct } : {}),
  });
  const mbd = phosphatePrior({
    ...(d.phosMgDl !== undefined ? { phosMgDl: d.phosMgDl } : {}),
    ...(d.calciumMgDl !== undefined ? { calciumMgDl: d.calciumMgDl } : {}),
    ...(d.pthPgMl !== undefined ? { pthPgMl: d.pthPgMl } : {}),
    ...(d.ktvPerSession !== undefined ? { spKtV: d.ktvPerSession } : {}),
    ...(d.sessionsPerWeek !== undefined ? { sessionsPerWeek: d.sessionsPerWeek } : {}),
    binderCodes: ['sevelamer'],
  });
  const nutrition = nutritionPrior({
    ...(d.albuminGdL !== undefined ? { albuminGdL: d.albuminGdL } : {}),
    ...(d.crpMgL !== undefined ? { crpMgL: d.crpMgL } : {}),
    ...(d.ktvPerSession !== undefined ? { spKtV: d.ktvPerSession } : {}),
    ...(d.idwgKg !== undefined ? { idwgKg: d.idwgKg } : {}),
  });
  const infection = infectionPrior({
    ...(d.tempC !== undefined ? { tempC: d.tempC } : {}),
    ...(d.wbc !== undefined ? { wbc: d.wbc } : {}),
    ...(d.crpMgL !== undefined ? { crpMgL: d.crpMgL } : {}),
    ...(d.accessTypeFlag !== undefined ? { accessType: d.accessTypeFlag >= 1 ? 'catheter' : 'avf' } : {}),
  });

  // Priors at each horizon.
  const hgbTarget = hgbFromWeeklyDose(d.esaDoseUnits ?? 0, {
    ...(d.tsatPct !== undefined ? { ironReplete: d.tsatPct >= 20 } : {}),
    ...(d.crpMgL !== undefined ? { crpMgL: d.crpMgL } : {}),
  });
  const urrAnchor = adequacy.urrPct ?? (d.ktvPerSession !== undefined ? ktvToUrr(d.ktvPerSession) : undefined) ?? 65;
  const phosAnchor = mbd.inTarget
    ? (d.phosMgDl ?? 4.5)
    : Math.max(3.2, (d.phosMgDl ?? 6) - (mbd.boundMgPerDay / 2400) * 0.35 - Math.max(0, (mbd.dialyticRemovalIndex ?? 3) - 3) * 0.05);
  const albAnchor = Math.max(ALBUMIN_FLOOR_G_DL, (d.albuminGdL ?? 3.8) + (nutrition.inflammatoryBurden ? -0.1 : 0.05));

  const forecasts: RenalForecast[] = [];
  for (const horizonDays of horizonsDays) {
    const wk = horizonDays / 7;
    const tau = (h: number, half: number): number => 1 - Math.exp(-h / half);

    // Adequacy — URR mean-reverts to the clearance-implied ceiling; shortened
    // treatments pull it down proportionally to the adherence deficit.
    const adherenceDeficit = Math.max(0, (95 - (d.adherencePct ?? 95)) / 100);
    const urrValue = urrAnchor + ((URR_FLOOR_PCT - 5) - urrAnchor) * tau(horizonDays, 30) - adherenceDeficit * 12 * tau(horizonDays, 21);
    forecasts.push({
      protocol: 'adequacy', substate: 'SG', label: 'Dialysis adequacy (clearance)', target: 'urrPct', unit: '%',
      horizonDays, value: round2(urrValue), band: { low: round2(urrValue - bandsFor.urrPct!), high: round2(urrValue + bandsFor.urrPct!) },
      threshold: URR_FLOOR_PCT, meetsTarget: urrValue >= URR_FLOOR_PCT, drivers: adequacy.drivers,
    });

    // Fluid — IDWG accumulates between sessions at ~0.15 kg/week unless UF is
    // failing; achieved UF above target is capped by the prescribed rate.
    const idwgValue = (d.idwgKg ?? 2) + wk * 0.15 * (fluid.ufUndelivered ? 1.6 : 1);
    forecasts.push({
      protocol: 'fluid', substate: 'SF', label: 'Volume / ultrafiltration', target: 'idwgKg', unit: 'kg',
      horizonDays, value: round2(idwgValue), band: { low: round2(idwgValue - bandsFor.idwgKg!), high: round2(idwgValue + bandsFor.idwgKg!) },
      threshold: 2.5, meetsTarget: idwgValue <= 2.5, drivers: fluid.drivers,
    });

    // Anemia — HGB approaches the ESA-dose-implied ceiling with a ~6-week time constant.
    const hgbValue = hgbTarget + ((d.hgbGdl ?? hgbTarget) - hgbTarget) * Math.exp(-horizonDays / 42);
    forecasts.push({
      protocol: 'anemia', substate: 'SH', label: 'Anemia / iron', target: 'hgbGdl', unit: 'g/dL',
      horizonDays, value: round2(hgbValue), band: { low: round2(hgbValue - bandsFor.hgbGdl!), high: round2(hgbValue + bandsFor.hgbGdl!) },
      threshold: 10, meetsTarget: hgbValue >= 10, drivers: [
        ...(d.tsatPct !== undefined && d.tsatPct < 20 ? [`TSAT ${d.tsatPct}% — functional iron deficiency limits ESA response`] : []),
        ...(d.crpMgL !== undefined && d.crpMgL > 10 ? [`CRP ${d.crpMgL} mg/L — inflammatory ESA hyporesponsiveness`] : []),
      ],
    });

    // CKD-MBD — phosphate drifts toward the binder/clearance-implied plateau.
    const phosValue = phosAnchor + ((d.phosMgDl ?? phosAnchor) - phosAnchor) * Math.exp(-horizonDays / 28);
    forecasts.push({
      protocol: 'ckd-mbd', substate: 'SI', label: 'CKD-MBD (P / Ca / PTH)', target: 'phosMgDl', unit: 'mg/dL',
      horizonDays, value: round2(phosValue), band: { low: round2(phosValue - bandsFor.phosMgDl!), high: round2(phosValue + bandsFor.phosMgDl!) },
      threshold: PHOS_TARGET_MAX_MG_DL, meetsTarget: phosValue <= PHOS_TARGET_MAX_MG_DL, drivers: mbd.drivers,
    });

    // Nutrition / electrolytes — potassium after the next sessions plus rebound.
    const sessions = Math.max(1, Math.round(wk * (d.sessionsPerWeek ?? 3)));
    const kAfter = d.ktvPerSession !== undefined ? potassiumAfterSession(d.potassium ?? 5, d.ktvPerSession) : (d.potassium ?? 5);
    const kValue = potassiumRebound(kAfter, (horizonDays % 2 === 0 ? 48 : 24) * 1, 55) + Math.max(0, sessions - 1) * 0.02 * (d.potassium ?? 5);
    forecasts.push({
      protocol: 'nutrition-electrolytes', substate: 'SJ', label: 'Nutrition / electrolytes', target: 'potassium', unit: 'mmol/L',
      horizonDays, value: round2(kValue), band: { low: round2(kValue - bandsFor.potassium!), high: round2(kValue + bandsFor.potassium!) },
      threshold: K_HYPERKALEMIA, meetsTarget: kValue <= K_HYPERKALEMIA,
      drivers: [...nutrition.drivers, ...(albAnchor < ALBUMIN_FLOOR_G_DL ? [`albumin trending to ${round2(albAnchor)} g/dL`] : [])],
    });

    // Access — recirculation creeps up when the access is already dysfunctional.
    const accessBaseline = Math.max(d.recirculationPct ?? 5, (d.accessRiskFlag ?? 0) > 0 ? 14 : 5);
    const recircValue = accessBaseline + (accessBaseline > 10 ? wk * 0.6 : wk * 0.1);
    forecasts.push({
      protocol: 'access', substate: 'SK', label: 'Vascular access', target: 'recirculationPct', unit: '%',
      horizonDays, value: round2(recircValue), band: { low: round2(recircValue - bandsFor.recirculationPct!), high: round2(recircValue + bandsFor.recirculationPct!) },
      threshold: 10, meetsTarget: recircValue <= 10,
      drivers: [
        ...((d.accessRiskFlag ?? 0) > 0 ? ['access event on the ledger (dysfunction pattern)'] : []),
        ...((d.accessTypeFlag ?? 0) > 0 ? ['central venous catheter in situ'] : []),
      ],
    });

    // Infection — triage score drifts with the current inflammatory state.
    const triageValue = Math.min(1, infection.triageScore * (1 - Math.exp(-Math.max(1, horizonDays) / 10)) + infection.triageScore * 0.2);
    forecasts.push({
      protocol: 'infection', substate: 'SL', label: 'Infection / inflammation', target: 'triageScore', unit: '0-1',
      horizonDays, value: round2(triageValue), band: { low: round2(Math.max(0, triageValue - bandsFor.triageScore!)), high: round2(Math.min(1, triageValue + bandsFor.triageScore!)) },
      threshold: 0.5, meetsTarget: triageValue < 0.5, drivers: infection.drivers,
    });
  }
  return forecasts;
}

// ---- Patient-level backtest harness (synthetic longitudinal simulator) ----

export interface BacktestPatientSpec {
  patientId: string;
  trajectory: LongitudinalTrajectory;
  facilityId?: string;
  seed?: number;
  days?: number;
}

export interface RegressionRow {
  patientId: string;
  protocol: ProtocolId;
  substate: string;
  target: string;
  unit: string;
  horizonDays: number;
  /** current observed value (persistence forecast) */
  current: number;
  /** mechanistic prior forecast at the horizon */
  prior: number;
  /** shared latent (index-aligned with RENAL_SUBSTATES) */
  latent: number[];
  observed: number;
}

export interface ClassificationRow {
  patientId: string;
  protocol: ProtocolId;
  substate: string;
  target: string;
  horizonDays: number;
  /** baseline feature vector (raw current values) */
  features: number[];
  /** shared-state score (latent-derived, threshold-anchored) */
  stateScore: number;
  label: 0 | 1;
}

export const REGRESSION_TARGETS: ReadonlyArray<{ protocol: ProtocolId; substate: string; lab: keyof LongitudinalLabs; unit: string; worse: 'higher' | 'lower' }> = [
  { protocol: 'adequacy', substate: 'SG', lab: 'URR', unit: '%', worse: 'lower' },
  { protocol: 'anemia', substate: 'SH', lab: 'HGB', unit: 'g/dL', worse: 'lower' },
  { protocol: 'ckd-mbd', substate: 'SI', lab: 'PHOS', unit: 'mg/dL', worse: 'higher' },
  { protocol: 'nutrition-electrolytes', substate: 'SJ', lab: 'K', unit: 'mmol/L', worse: 'higher' },
] as const;

export const CLASSIFICATION_TARGETS: ReadonlyArray<{ protocol: ProtocolId; substate: string; target: string }> = [
  { protocol: 'infection', substate: 'SL', target: 'clinicalDeterioration7d' },
  { protocol: 'infection', substate: 'SL', target: 'clinicalDeterioration28d' },
] as const;

const round1 = (v: number): number => Math.round(v * 10) / 10;

function systolic(bp: string): number {
  const n = Number.parseInt(bp.split('/')[0] ?? '', 10);
  return Number.isFinite(n) ? n : 120;
}

/**
 * Build labeled backtest rows from the synthetic longitudinal simulator.
 * Weekly lab points are used as anchors; the target is the same lab H days later,
 * so every row is a real forecast task on a real (simulated) trajectory.
 */
export function buildBacktestRows(opts: { patients: readonly BacktestPatientSpec[]; horizonsDays?: readonly number[] }): {
  regression: RegressionRow[]; classification: ClassificationRow[]; latestByPatient: Map<string, { labs: LongitudinalLabs; systolic: number; spo2: number; hr: number }>;
} {
  const horizons = opts.horizonsDays ?? [7, 28];
  const regression: RegressionRow[] = [];
  const classification: ClassificationRow[] = [];
  const latestByPatient = new Map<string, { labs: LongitudinalLabs; systolic: number; spo2: number; hr: number }>();
  /** Causal trailing values per patient+lab → the patient's own setpoint (no look-ahead). */
  const trailing = new Map<string, number[]>();

  for (const spec of opts.patients) {
    const profile = generateLongitudinalHistory({
      patientId: spec.patientId,
      facilityId: spec.facilityId ?? 'sim-fac-a',
      trajectory: spec.trajectory,
      days: spec.days ?? 120,
      seed: spec.seed ?? 1,
      asOf: new Date('2026-08-01T06:00:00.000Z'),
    });
    const labPoints = profile.history.filter((p) => p.labs) as Array<{ labs: LongitudinalLabs; vitals: { hr: number; bp: string; spo2: number }; esaDose?: number; date: string }>;
    if (!labPoints.length) continue;
    const last = labPoints[labPoints.length - 1]!;
    latestByPatient.set(spec.patientId, { labs: last.labs, systolic: systolic(last.vitals.bp), spo2: last.vitals.spo2, hr: last.vitals.hr });

    // lab points are 7 days apart
    for (let i = 0; i < labPoints.length; i += 1) {
      const point = labPoints[i]!;
      const currentLabs = point.labs;
      for (const target of REGRESSION_TARGETS) {
        const key = `${spec.patientId}|${target.lab}`;
        const seen = trailing.get(key) ?? [];
        const setpoint = seen.length ? seen.slice(-4).reduce((a, b) => a + b, 0) / seen.slice(-4).length : currentLabs[target.lab];
        for (const horizonDays of horizons) {
          const steps = Math.round(horizonDays / 7);
          const next = labPoints[i + steps];
          if (!next) continue;
          // shared state at the anchor point
          const dims: DimBag = {
            [target.lab === 'URR' ? 'urrPct' : target.lab === 'HGB' ? 'hgbGdl' : target.lab === 'PHOS' ? 'phosMgDl' : 'potassium']: currentLabs[target.lab],
            nadirSbp: systolic(point.vitals.bp),
            adherencePct: point.vitals.spo2,
          };
          if (point.esaDose !== undefined) dims.esaDoseUnits = point.esaDose;
          const latent = latentFromDims(dims);
          const prior = priorForTarget(target.protocol, currentLabs[target.lab], setpoint, point.esaDose, horizons.indexOf(horizonDays));
          regression.push({
            patientId: spec.patientId,
            protocol: target.protocol,
            substate: target.substate,
            target: target.lab,
            unit: target.unit,
            horizonDays,
            current: currentLabs[target.lab],
            prior,
            latent,
            observed: next.labs[target.lab],
          });
        }
        trailing.set(key, [...seen, currentLabs[target.lab]]);
      }
      // classification: clinical deterioration (hypoxaemia or tachycardia) ahead
      for (const horizonDays of [7, 28]) {
        const steps = Math.round(horizonDays / 7);
        const next = labPoints[i + steps];
        if (!next) continue;
        const label: 0 | 1 = next.vitals.hr > 100 || next.vitals.spo2 < 93 ? 1 : 0;
        const stateScore = Math.round(Math.max(
          span(point.vitals.hr, 85, 105),
          press(point.vitals.spo2, 95, 90),
          span(systolic(point.vitals.bp), 130, 95) * 0.8,
        ) * 1000) / 1000;
        classification.push({
          patientId: spec.patientId,
          protocol: 'infection',
          substate: 'SL',
          target: horizonDays === 7 ? 'clinicalDeterioration7d' : 'clinicalDeterioration28d',
          horizonDays,
          features: [point.vitals.hr, point.vitals.spo2, systolic(point.vitals.bp), currentLabs.HGB, currentLabs.K],
          stateScore,
          label,
        });
      }
    }
  }
  return { regression, classification, latestByPatient };
}

/**
 * Mechanistic prior for a regression target at a horizon.
 * The prior is causal: it reverts the current value toward (a) the patient's own
 * trailing setpoint and (b) the physiology-implied anchor (ESA-dose-implied HGB,
 * clearance-implied URR floor, binder-adjusted phosphate, K rebound plateau),
 * with a per-domain time constant.
 */
function priorForTarget(protocol: ProtocolId, current: number, setpoint: number, esaDose: number | undefined, horizonIndex: number): number {
  const h = [7, 28, 84][horizonIndex] ?? 7;
  switch (protocol) {
    case 'adequacy': {
      const anchor = 0.7 * setpoint + 0.3 * (URR_FLOOR_PCT - 5);
      return round2(anchor + (current - anchor) * Math.exp(-h / 30));
    }
    case 'anemia': {
      const anchor = 0.5 * setpoint + 0.5 * hgbFromWeeklyDose(esaDose ?? 0, {});
      return round2(anchor + (current - anchor) * Math.exp(-h / 42));
    }
    case 'ckd-mbd': {
      const anchor = Math.max(3.2, setpoint - 0.2); // steady binder binding pulls phosphate down
      return round2(anchor + (current - anchor) * Math.exp(-h / 28));
    }
    case 'nutrition-electrolytes': {
      // predialysis potassium rebounds fast to the patient's own inter-dialytic setpoint
      return round2(setpoint + (current - setpoint) * Math.exp(-h / 3));
    }
    default:
      return setpoint;
  }
}

export interface RegressionHeadReport {
  protocol: ProtocolId;
  substate: string;
  target: string;
  unit: string;
  horizonDays: number;
  trainRows: number;
  testRows: number;
  comparison: ForecastComparison;
  split: { trainPatients: number; testPatients: number };
}

export interface ClassificationHeadReport {
  protocol: ProtocolId;
  substate: string;
  target: string;
  horizonDays: number;
  testRows: number;
  stateScoreMetrics: { auroc?: number; brier?: number; ece?: number; positives: number };
  baselineMetrics: { auroc?: number; brier?: number; ece?: number };
  reliability: ReliabilityBin[];
  winner: 'state' | 'baseline' | 'tie';
}

export interface F2EvaluationReport {
  generatedAt: string;
  patientLevelSplit: PatientSplit;
  noPatientOverlap: boolean;
  rows: { regression: number; classification: number };
  regressionHeads: RegressionHeadReport[];
  classificationHeads: ClassificationHeadReport[];
  /** protocols × horizons served by the single shared state */
  coverage: { protocols: ProtocolId[]; horizonsDays: number[]; protocolHorizonPairs: number };
  summary: {
    headsBeatingPersistence: number;
    headsBeatingBaseline: number;
    totalHeads: number;
    meanHeadMae?: number;
    meanPersistenceMae?: number;
  };
}

/**
 * Train and evaluate every protocol head on a patient-level split.
 * Head features = [prior, ...latent] (mechanistic prior + shared state);
 * baseline = ridge on raw current values; floor = persistence.
 */
export function evaluateProtocolHeads(rows: { regression: RegressionRow[]; classification: ClassificationRow[] }, opts: { salt?: string; trainFraction?: number } = {}): F2EvaluationReport {
  const allPatients = [...new Set([...rows.regression.map((r) => r.patientId), ...rows.classification.map((r) => r.patientId)])];
  const split = patientLevelSplit(allPatients, { ...(opts.salt !== undefined ? { salt: opts.salt } : {}), ...(opts.trainFraction !== undefined ? { trainFraction: opts.trainFraction } : {}) });

  const regressionHeads: RegressionHeadReport[] = [];
  const keys = [...new Set(rows.regression.map((r) => `${r.protocol}|${r.target}|${r.horizonDays}`))];
  for (const key of keys) {
    const [protocol, target, horizonRaw] = key.split('|') as [ProtocolId, string, string];
    const horizonDays = Number(horizonRaw);
    const group = rows.regression.filter((r) => r.protocol === protocol && r.target === target && r.horizonDays === horizonDays);
    const { train, test } = filterByPatientSplit(group, split);
    if (!train.length || !test.length) continue;
    const headModel = fitRidgeLinear(
      train.map<Sample>((r) => ({ features: [r.prior, ...r.latent], target: r.observed })),
      ['prior', ...RENAL_SUBSTATES.map((s) => `latent_${s.substate}`)],
      1e-2,
    );
    // Tabular baseline: a fitted linear map of the current value ("model-free" tabular read).
    const baselineModel = fitRidgeLinear(
      train.map<Sample>((r) => ({ features: [r.current], target: r.observed })),
      ['current'],
      1e-3,
    );
    const comparison = compareForecasts({
      label: `${protocol}:${target}@${horizonDays}d`,
      persistencePredicted: test.map((r) => r.current),
      ...(baselineModel ? { baselinePredicted: test.map((r) => predictLinear(baselineModel, [r.current])) } : {}),
      headPredicted: test.map((r) => (headModel ? predictLinear(headModel, [r.prior, ...r.latent]) : r.prior)),
      observed: test.map((r) => r.observed),
    });
    regressionHeads.push({
      protocol, substate: group[0]!.substate, target, unit: group[0]!.unit, horizonDays,
      trainRows: train.length, testRows: test.length, comparison,
      split: { trainPatients: new Set(train.map((r) => r.patientId)).size, testPatients: new Set(test.map((r) => r.patientId)).size },
    });
  }

  const classificationHeads: ClassificationHeadReport[] = [];
  const classKeys = [...new Set(rows.classification.map((r) => `${r.target}|${r.horizonDays}`))];
  for (const key of classKeys) {
    const [target, horizonRaw] = key.split('|') as [string, string];
    const horizonDays = Number(horizonRaw);
    const group = rows.classification.filter((r) => r.target === target && r.horizonDays === horizonDays);
    const { train, test } = filterByPatientSplit(group, split);
    if (!train.length || !test.length) continue;
    const model = fitLogistic(
      train.map<LabeledSample>((r) => ({ features: r.features, label: r.label })),
      ['hr', 'spo2', 'systolic', 'hgb', 'potassium'],
      { iterations: 500 },
    );
    const stateScorePairs = test.map((r) => ({ score: r.stateScore, label: r.label }));
    const baselinePairs = test.map((r) => ({ score: model ? predictLogistic(model, r.features) : 0.5, label: r.label }));
    const stateAu = auroc(stateScorePairs);
    const baseAu = auroc(baselinePairs);
    const stateBrier = brier(stateScorePairs);
    const baseBrier = brier(baselinePairs);
    const winner: ClassificationHeadReport['winner'] = stateAu && baseAu
      ? (stateAu.auroc > baseAu.auroc ? 'state' : stateAu.auroc < baseAu.auroc ? 'baseline' : 'tie')
      : 'tie';
    const stateEce = ece(stateScorePairs);
    const baseEce = ece(baselinePairs);
    classificationHeads.push({
      protocol: 'infection', substate: 'SL', target, horizonDays, testRows: test.length,
      stateScoreMetrics: {
        ...(stateAu ? { auroc: stateAu.auroc } : {}),
        ...(stateBrier !== undefined ? { brier: stateBrier } : {}),
        ...(stateEce !== undefined ? { ece: stateEce } : {}),
        positives: stateScorePairs.filter((p) => p.label === 1).length,
      },
      baselineMetrics: {
        ...(baseAu ? { auroc: baseAu.auroc } : {}),
        ...(baseBrier !== undefined ? { brier: baseBrier } : {}),
        ...(baseEce !== undefined ? { ece: baseEce } : {}),
      },
      reliability: reliabilityBins(stateScorePairs, 5),
      winner,
    });
  }

  const headMaes = regressionHeads.map((r) => r.comparison.head.mae).filter((v): v is number => v !== undefined);
  const persMaes = regressionHeads.map((r) => r.comparison.persistence.mae).filter((v): v is number => v !== undefined);
  const protocols = [...new Set(regressionHeads.map((r) => r.protocol))];
  const horizonsDays = [...new Set(regressionHeads.map((r) => r.horizonDays))].sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    patientLevelSplit: split,
    noPatientOverlap: hasNoPatientOverlap(split),
    rows: { regression: rows.regression.length, classification: rows.classification.length },
    regressionHeads,
    classificationHeads,
    coverage: { protocols, horizonsDays, protocolHorizonPairs: regressionHeads.length },
    summary: {
      headsBeatingPersistence: regressionHeads.filter((r) => (r.comparison.headVsPersistenceImprovementPct ?? -1) > 0).length,
      headsBeatingBaseline: regressionHeads.filter((r) => r.comparison.winner === 'head').length,
      totalHeads: regressionHeads.length,
      ...(headMaes.length ? { meanHeadMae: Math.round((headMaes.reduce((a, b) => a + b, 0) / headMaes.length) * 1000) / 1000 } : {}),
      ...(persMaes.length ? { meanPersistenceMae: Math.round((persMaes.reduce((a, b) => a + b, 0) / persMaes.length) * 1000) / 1000 } : {}),
    },
  };
}

/** Convenience: full F2 evaluation over a synthetic cohort. */
export function runF2Evaluation(opts: { patients?: readonly BacktestPatientSpec[]; horizonsDays?: readonly number[]; salt?: string; trainFraction?: number } = {}): F2EvaluationReport {
  const patients = opts.patients ?? defaultCohort();
  const rows = buildBacktestRows({ patients, ...(opts.horizonsDays ? { horizonsDays: opts.horizonsDays } : {}) });
  return evaluateProtocolHeads(rows, { ...(opts.salt !== undefined ? { salt: opts.salt } : {}), ...(opts.trainFraction !== undefined ? { trainFraction: opts.trainFraction } : {}) });
}

/** Default synthetic evaluation cohort: 7 trajectories × 6 patients = 42 patients. */
export function defaultCohort(): BacktestPatientSpec[] {
  const trajectories: LongitudinalTrajectory[] = ['stable', 'decompensating', 'recovering', 'anemic-worsening', 'anemic-recovering', 'underdialyzed', 'hyperphosphatemia'];
  const out: BacktestPatientSpec[] = [];
  for (let i = 0; i < trajectories.length; i += 1) {
    for (let k = 0; k < 6; k += 1) {
      out.push({ patientId: `sim-fac-a-pt-${String(i * 6 + k + 1).padStart(4, '0')}`, trajectory: trajectories[i]!, seed: 7 + k, days: 120 });
    }
  }
  return out;
}

export { mae, forecastMetrics, relativeImprovementPct, weeklyKtV, KTV_TARGET };
