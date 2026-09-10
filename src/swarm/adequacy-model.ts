/******************************************************************************
 * Dialysis adequacy — trained artifact (P1 step E).
 *
 * Evidence-anchored choice (implementation strategy §0): tree ensembles beat
 * CNN/GRU/linear for adequacy (XGBoost Corr 0.873, RF AUROC 0.873), so the
 * artifact is a gradient-boosted regression head trained on the residual the
 * Daugirdas prior leaves behind — prior first, learned correction second.
 *
 * Contract: `adequacyRecommendTrained` returns the SAME shape as the reference
 * surrogate (`AdequacyRecommendation`) with `model.kind: 'trained'`, so the
 * routes and the exec panel do not branch on which artifact answered.
 *
 * Artifact: adequacy-train/artifacts/adequacy.ktv-v1.json (trained by
 * scripts/train-adequacy-model.ts on the synthetic longitudinal cohort).
 ******************************************************************************/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ADEQUACY_FEATURES,
  ADEQUACY_ADVISOR_MODEL,
  adequacyRecommend,
  type AdequacyPatientWindow,
  type AdequacyRecommendation,
} from './adequacy.js';
import { adequacyPrior, ktvToUrr, spKtVFromUrr } from '../protocols/priors.js';
import { fitGbt, predictGbt, gbtAttribution, gbtModelCard, validateGbtModel, type GbtModel, type GbtSample } from '../protocols/gbdt.js';
import { compareForecasts, fitRidgeLinear, predictLinear, type ForecastComparison } from '../protocols/baselines.js';
import { forecastMetrics } from '../protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit } from '../protocols/split.js';
import { generateLongitudinalHistory, type LongitudinalTrajectory } from '../simulator/longitudinal.js';

export const ADEQUACY_ARTIFACT_ID = 'adequacy.ktv-v1';
export const ADEQUACY_ARTIFACT_PATH = 'adequacy-train/artifacts/adequacy.ktv-v1.json';

/**
 * Feature contract of the trained clearance head — frozen; trainer and runtime
 * share it. Deliberately limited to CLEARANCE-relevant inputs: vitals (nadir
 * SBP, IDWG) and electrolytes drive the guardrails and the fluid coupling, not
 * the clearance model, and including per-patient constants would let the trees
 * memorise patient identity instead of learning machinery effects.
 */
export const ADEQUACY_MODEL_FEATURES = [
  'priorUrrPct',
  'deliveredMinutes',
  'prescribedMinutes',
  'qbAvg',
  'qd',
  'ufVolumeL',
  'postWeightKg',
  'recirculationPct',
  'accessCode',
  'sessionsPerWeek',
] as const;

export type AdequacyModelFeature = (typeof ADEQUACY_MODEL_FEATURES)[number];

const accessCode = (access: AdequacyPatientWindow['accessType']): number => (access === 'catheter' ? 2 : access === 'avg' ? 1 : 0);

/** Build the model vector (missing values fall back to the reference population). */
export function buildAdequacyVector(window: AdequacyPatientWindow, priorUrrPct: number): number[] {
  const minutes = window.deliveredMinutes ?? window.prescribedMinutes ?? 210;
  return [
    priorUrrPct,
    minutes,
    window.prescribedMinutes ?? minutes,
    window.qbAvg ?? window.qbPrescribed ?? 350,
    window.qd ?? 500,
    window.ufVolumeL ?? 2.5,
    window.postWeightKg ?? 70,
    window.recirculationPct ?? 4,
    accessCode(window.accessType),
    window.sessionsPerWeek ?? 3,
  ];
}

export interface AdequacyArtifact {
  id: string;
  version: string;
  kind: 'gbdt-regression';
  trainedAt: string;
  rows: number;
  patients: number;
  model: GbtModel;
  modelCard: Record<string, unknown>;
  metrics: {
    head: ForecastComparison['head'];
    persistence: ForecastComparison['persistence'];
    referencePrior: ReturnType<typeof forecastMetrics>;
    headVsPersistenceImprovementPct?: number;
    headVsReferenceImprovementPct?: number;
    comparison: ForecastComparison;
  };
  synthetic: true;
}

/* ----------------------------------------------------------------------
 * Training data — synthetic longitudinal cohort with per-session machinery
 * ---------------------------------------------------------------------- */

export interface AdequacyTrainingRow {
  patientId: string;
  features: number[];
  observed: number;
  prior: number;
  persistence: number;
  trajectory: LongitudinalTrajectory;
}

/** Deterministic 0..1 source (mulberry32) — keeps the artifact reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRAJECTORIES: LongitudinalTrajectory[] = ['stable', 'decompensating', 'recovering', 'anemic-worsening', 'anemic-recovering', 'underdialyzed', 'hyperphosphatemia'];

export interface AdequacyTrainingSpec { patientId: string; trajectory: LongitudinalTrajectory; seed?: number; days?: number }

/**
 * Sample adequacy training rows from the synthetic simulator.
 *
 * Generative model (documented, synthetic): the observed URR is produced from
 * the delivered machinery through the urea-kinetic relationship —
 *
 *   spKt/V_true = K_ref · (deliveredMinutes / 240) · sat(Qb) · (1 − recirc/100)
 *                 · accessFactor · patientDeliveryFactor · (70/weight)^0.75 + noise
 *   observed URR = 1 − e^(−spKt/V_true)   (lab-rounded, 0.1%)
 *
 * The reference prior only knows minutes and a population mean, so the head has
 * a genuine residual to learn: access, recirculation, Qb saturation and the
 * patient's own delivery efficiency. Nothing here claims real-data validity.
 */
export function buildAdequacyTrainingRows(specs: readonly AdequacyTrainingSpec[]): AdequacyTrainingRow[] {
  const rows: AdequacyTrainingRow[] = [];
  const saturate = (qb: number): number => qb / (qb + 60);
  const K_REF = 1.45; // reference single-pool Kt/V at 240 min / Qb 350 for an AVF
  for (const spec of specs) {
    const rng = mulberry32((spec.seed ?? 1) * 2654435761 + spec.patientId.length * 7919);
    const profile = generateLongitudinalHistory({
      patientId: spec.patientId,
      facilityId: 'adequacy-train',
      trajectory: spec.trajectory,
      days: spec.days ?? 120,
      seed: spec.seed ?? 1,
      asOf: new Date('2026-08-01T06:00:00.000Z'),
    });
    const labPoints = profile.history.filter((p) => p.labs) as Array<{ labs: { URR: number; K: number }; date: string }>;
    const catheter = rng() < 0.25;
    const accessType: AdequacyPatientWindow['accessType'] = catheter ? 'catheter' : rng() < 0.2 ? 'avg' : 'avf';
    const postWeightKg = Math.round((55 + rng() * 55) * 10) / 10;
    const prescribedMinutes = [180, 210, 240, 270][Math.floor(rng() * 4)]!;
    const qbBase = catheter ? 300 : 350 + Math.floor(rng() * 3) * 25;
    const recirculationPct = catheter ? Math.round((8 + rng() * 8) * 10) / 10 : Math.round((2 + rng() * 6) * 10) / 10;
    const adherenceBase = 0.78 + rng() * 0.22;
    // patient-specific delivery efficiency (urea distribution volume, flow limits)
    const patientDeliveryFactor = {
      stable: 1.0, decompensating: 0.9, recovering: 1.05,
      'anemic-worsening': 0.96, 'anemic-recovering': 0.98,
      underdialyzed: 0.82, hyperphosphatemia: 0.99,
    }[spec.trajectory];
    const accessFactor = catheter ? 0.85 : accessType === 'avg' ? 0.94 : 1.0;

    let previousUrr: number | undefined;
    for (const point of labPoints) {
      const deliveredMinutes = Math.round(prescribedMinutes * Math.max(0.6, Math.min(1, adherenceBase + (rng() - 0.5) * 0.08)));
      const qbAvg = qbBase - Math.floor(rng() * 3) * 10;
      const ufVolumeL = Math.round((1.5 + rng() * 2) * 10) / 10;
      const window: AdequacyPatientWindow = {
        patientId: spec.patientId,
        sessionCount: 6,
        sessionsPerWeek: 3,
        prescribedMinutes,
        deliveredMinutes,
        qbPrescribed: qbBase,
        qbAvg,
        qd: 500,
        ufVolumeL,
        postWeightKg,
        recirculationPct,
        accessType,
        nadirSbp: Math.round(95 + rng() * 30),
        idwgKg: Math.round((1.2 + rng() * 2.4) * 10) / 10,
        potassium: point.labs.K,
        asOf: '2026-08-01T06:00:00.000Z',
      };

      const saturationFactor = qbAvg > 0 ? saturate(qbAvg) / saturate(350) : 1;
      // Urea distribution volume scales with body size ⇒ smaller patients get
      // more clearance per litre of blood processed.
      const sizeFactor = (70 / postWeightKg) ** 0.75;
      const trueSpKtV = K_REF
        * (deliveredMinutes / 240)
        * saturationFactor
        * (1 - recirculationPct / 100)
        * accessFactor
        * patientDeliveryFactor
        * sizeFactor
        + (rng() - 0.5) * 0.06;
      const observed = Math.round(ktvToUrr(trueSpKtV) * 10) / 10;
      // Reference prior the head must correct: minutes only, population mean.
      const referenceSpKtV = K_REF * (deliveredMinutes / 240);
      const priorUrrPct = Math.round(ktvToUrr(referenceSpKtV) * 10) / 10;

      rows.push({
        patientId: spec.patientId,
        features: buildAdequacyVector(window, priorUrrPct),
        observed,
        prior: priorUrrPct,
        persistence: previousUrr ?? observed,
        trajectory: spec.trajectory,
      });
      previousUrr = observed;
    }
  }
  return rows;
}

/** Default training corpus: 7 trajectories × 8 patients. */
export function defaultAdequacyTrainingSpecs(): AdequacyTrainingSpec[] {
  const out: AdequacyTrainingSpec[] = [];
  for (const [ti, trajectory] of TRAJECTORIES.entries()) {
    for (let k = 0; k < 8; k += 1) {
      out.push({ patientId: `adequacy-train-pt-${String(ti * 8 + k + 1).padStart(4, '0')}`, trajectory, seed: 11 + k, days: 120 });
    }
  }
  return out;
}

/**
 * Train the artifact on a PATIENT-level split and report head vs persistence vs
 * the mechanistic prior (the acceptance comparison the strategy demands).
 */
export function trainAdequacyArtifact(rows: readonly AdequacyTrainingRow[], opts: { salt?: string; trainFraction?: number } = {}): AdequacyArtifact {
  const split = patientLevelSplit([...new Set(rows.map((r) => r.patientId))], {
    ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
    ...(opts.trainFraction !== undefined ? { trainFraction: opts.trainFraction } : {}),
  });
  const { train, test } = filterByPatientSplit(rows as AdequacyTrainingRow[], split);
  const samples: GbtSample[] = train.map((r) => ({ features: r.features, target: r.observed }));
  const model = fitGbt(samples, ADEQUACY_MODEL_FEATURES, { trees: 80, maxDepth: 4, learningRate: 0.15, minSamplesLeaf: 6, subsample: 0.9, maxThresholds: 16 })!;

  // baseline = ridge on the same vector (the "tabular model" floor)
  const ridge = fitRidgeLinear(train.map<GbtSample>((r) => ({ features: r.features, target: r.observed })), ADEQUACY_MODEL_FEATURES, 1e-2);
  const headPred = test.map((r) => predictGbt(model, r.features));
  const comparison = compareForecasts({
    label: 'adequacy.urr',
    persistencePredicted: test.map((r) => r.persistence),
    ...(ridge ? { baselinePredicted: test.map((r) => predictLinear(ridge, r.features)) } : {}),
    headPredicted: headPred,
    observed: test.map((r) => r.observed),
  });
  const referencePrior = forecastMetrics(test.map((r) => ({ predicted: r.prior, observed: r.observed })));

  return {
    id: ADEQUACY_ARTIFACT_ID,
    version: '1.0.0',
    kind: 'gbdt-regression',
    trainedAt: new Date().toISOString(),
    rows: rows.length,
    patients: new Set(rows.map((r) => r.patientId)).size,
    model,
    modelCard: gbtModelCard(model, {
      artifact: ADEQUACY_ARTIFACT_ID,
      target: 'predialysis URR (%)',
      trainedOn: 'synthetic longitudinal cohort (src/simulator/longitudinal.ts)',
      patientLevelSplit: { train: split.train.length, test: split.test.length, overlap: false },
      features: [...ADEQUACY_MODEL_FEATURES],
      sourceFeatures: ADEQUACY_FEATURES.map((f) => f.id),
      prior: 'Daugirdas 1993 single-pool Kt/V → URR (src/protocols/priors.ts)',
    }),
    metrics: {
      head: comparison.head,
      persistence: comparison.persistence,
      referencePrior,
      ...(comparison.headVsPersistenceImprovementPct !== undefined ? { headVsPersistenceImprovementPct: comparison.headVsPersistenceImprovementPct } : {}),
      ...(referencePrior.mae !== undefined && comparison.head.mae !== undefined
        ? { headVsReferenceImprovementPct: Math.round(((referencePrior.mae - comparison.head.mae) / referencePrior.mae) * 10000) / 100 }
        : {}),
      comparison,
    },
    synthetic: true,
  };
}

export function saveAdequacyArtifact(artifact: AdequacyArtifact, path = ADEQUACY_ARTIFACT_PATH): string {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return absolute;
}

let cached: AdequacyArtifact | undefined;

/** Load + structurally validate the artifact (cached). */
export function loadAdequacyArtifact(path = ADEQUACY_ARTIFACT_PATH): AdequacyArtifact | undefined {
  if (cached && path === ADEQUACY_ARTIFACT_PATH) return cached;
  try {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as AdequacyArtifact;
    const check = validateGbtModel(parsed.model);
    if (!check.valid) return undefined;
    if (path === ADEQUACY_ARTIFACT_PATH) cached = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

export function adequacyArtifactStatus(path = ADEQUACY_ARTIFACT_PATH): {
  present: boolean;
  id?: string | undefined;
  version?: string | undefined;
  trainedAt?: string | undefined;
  rows?: number | undefined;
  patients?: number | undefined;
  mae?: number | undefined;
  mapePct?: number | undefined;
  attribution?: ReturnType<typeof gbtAttribution> | undefined;
} {
  const artifact = loadAdequacyArtifact(path);
  if (!artifact) return { present: false };
  return {
    present: true,
    id: artifact.id,
    version: artifact.version,
    trainedAt: artifact.trainedAt,
    rows: artifact.rows,
    patients: artifact.patients,
    mae: artifact.metrics.head.mae,
    mapePct: artifact.metrics.head.mape,
    attribution: gbtAttribution(artifact.model, 6),
  };
}

/**
 * Trained advisor — same contract as the reference surrogate, with the learned
 * head correcting the mechanistic prior. Returns the reference recommendation
 * when no artifact is present (never silently falls back to unvalidated numbers).
 */
export function adequacyRecommendTrained(
  window: AdequacyPatientWindow,
  opts: { path?: string } = {},
): AdequacyRecommendation & { trained: { artifactId: string; predictedUrrPct: number; priorUrrPct: number; correction: number; band: { low: number; high: number } } } | AdequacyRecommendation {
  const artifact = loadAdequacyArtifact(opts.path ?? ADEQUACY_ARTIFACT_PATH);
  const base = adequacyRecommend(window);
  if (!artifact) return { ...base, model: { ...ADEQUACY_ADVISOR_MODEL, kind: 'reference-surrogate' } };

  const priorUrrPct = base.current.urrPct
    ?? (base.current.spKtV !== undefined ? ktvToUrr(base.current.spKtV) : 70);
  const features = buildAdequacyVector(window, priorUrrPct);
  const predictedUrrPct = Math.round(Math.max(30, Math.min(95, predictGbt(artifact.model, features))) * 10) / 10;
  const correction = Math.round((predictedUrrPct - priorUrrPct) * 10) / 10;
  const sd = artifact.model.residualStd;

  // The learned head re-scores the recommendation against the corrected clearance.
  const correctedSpKtV = spKtVFromUrr({ urrPct: predictedUrrPct, durationHours: (window.deliveredMinutes ?? window.prescribedMinutes ?? 210) / 60, ufVolumeL: window.ufVolumeL ?? 2.5, postWeightKg: window.postWeightKg ?? 70 });
  return {
    ...base,
    current: { ...base.current, urrPct: predictedUrrPct, spKtV: correctedSpKtV ?? base.current.spKtV },
    model: { id: ADEQUACY_ARTIFACT_ID, version: artifact.version, kind: 'trained' },
    note: `${base.note} Trained head (${ADEQUACY_ARTIFACT_ID}): URR ${predictedUrrPct}% (prior ${priorUrrPct}%, correction ${correction >= 0 ? '+' : ''}${correction}).`,
    trained: {
      artifactId: ADEQUACY_ARTIFACT_ID,
      predictedUrrPct,
      priorUrrPct,
      correction,
      band: { low: Math.round((predictedUrrPct - sd) * 10) / 10, high: Math.round((predictedUrrPct + sd) * 10) / 10 },
    },
  };
}
