/******************************************************************************
 * Fluid / IDH — trained artifact (P2 step E).
 *
 * Evidence anchor: published SOTA for intradialytic hypotension is a TFT
 * (AUROC 0.953) — treated here as the BENCHMARK, with gradient-boosted trees as
 * the baseline-first model (the same pattern that won for adequacy). The head
 * predicts the IDH event from intra-session + pre-session features; the
 * mechanistic logistic prior stays inside the feature vector so the head only
 * has to learn the correction.
 *
 * Artifact: fluid-train/artifacts/fluid.idh-v1.json, trained by
 * scripts/train-fluid-model.ts on a physiologically consistent synthetic
 * session generator. All evidence is synthetic and labelled as such.
 ******************************************************************************/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FLUID_FEATURES, FLUID_ADVISOR_MODEL, fluidRecommend, idhProbability, type FluidPatientWindow, type FluidRecommendation } from './fluid.js';
import { fitGbt, predictGbt, gbtAttribution, gbtModelCard, validateGbtModel, type GbtModel, type GbtSample } from '../protocols/gbdt.js';
import { auroc, brier, ece, reliabilityBins, type ReliabilityBin } from '../protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit } from '../protocols/split.js';

export const FLUID_ARTIFACT_ID = 'fluid.idh-v1';
export const FLUID_ARTIFACT_PATH = 'fluid-train/artifacts/fluid.idh-v1.json';

/** Frozen feature contract of the IDH head (clearance-irrelevant inputs excluded). */
export const FLUID_MODEL_FEATURES = [
  'priorRisk60',
  'ufRatePerKg',
  'ufRateMlH',
  'ufVolumeL',
  'plannedMinutes',
  'preSbp',
  'nadirSbpPrev',
  'idwgKg',
  'postWeightKg',
  'age',
  'cardiacHistory',
] as const;

export function buildFluidVector(window: FluidPatientWindow, priorRisk60: number): number[] {
  const weight = window.postWeightKg ?? 70;
  const minutes = window.deliveredMinutes ?? window.plannedMinutes ?? 210;
  const rate = window.ufRateMlH ?? (window.ufVolumeL !== undefined && minutes ? (window.ufVolumeL * 1000 * 60) / minutes : 700);
  return [
    priorRisk60,
    Math.round((rate / weight) * 100) / 100,
    rate,
    window.ufVolumeL ?? 2.5,
    window.plannedMinutes ?? minutes,
    window.preSbp ?? 130,
    window.nadirSbpPrev ?? window.nadirSbp ?? 110,
    window.idwgKg ?? 2.5,
    weight,
    window.age ?? 62,
    window.cardiacHistory ? 1 : 0,
  ];
}

export interface FluidArtifact {
  id: string;
  version: string;
  kind: 'gbdt-regression';
  trainedAt: string;
  rows: number;
  patients: number;
  model: GbtModel;
  modelCard: Record<string, unknown>;
  metrics: {
    auroc?: number | undefined;
    brier?: number | undefined;
    ece?: number | undefined;
    priorAuroc?: number | undefined;
    priorBrier?: number | undefined;
    /** AUROC of the same booster restricted to the mechanistic prior alone */
    priorOnlyHeadAuroc?: number | undefined;
    positives: number;
    negatives: number;
  };
  reliability: ReliabilityBin[];
  synthetic: true;
}

/* ----------------------------------------------------------------------
 * Synthetic session generator (physiologically consistent)
 * ---------------------------------------------------------------------- */

export interface FluidTrainingRow { patientId: string; features: number[]; label: 0 | 1; priorRisk: number }

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

/**
 * Generate synthetic sessions. The observed event is drawn from a generative
 * model that shares the prior's shape but adds effects the prior does NOT carry
 * (body-size threshold behaviour, session length, IDWG nonlinearity), so the
 * learned head has a genuine correction to make.
 */
export function buildFluidTrainingRows(opts: { patients?: number; sessionsPerPatient?: number; seed?: number } = {}): FluidTrainingRow[] {
  const patients = opts.patients ?? 90;
  const sessionsPerPatient = opts.sessionsPerPatient ?? 12;
  const rows: FluidTrainingRow[] = [];
  for (let p = 0; p < patients; p += 1) {
    const rng = mulberry32((opts.seed ?? 5) * 7919 + p * 104729);
    const patientId = `fluid-train-pt-${String(p + 1).padStart(4, '0')}`;
    const age = Math.round(38 + rng() * 50);
    const cardiac = rng() < 0.35;
    const postWeightKg = Math.round((52 + rng() * 60) * 10) / 10;
    const priorNadir = Math.round(92 + rng() * 30);
    for (let s = 0; s < sessionsPerPatient; s += 1) {
      const idwgKg = Math.round((0.8 + rng() * 4.2) * 10) / 10;
      const plannedMinutes = [180, 210, 240, 270][Math.floor(rng() * 4)]!;
      const deliveredMinutes = Math.round(plannedMinutes * (0.82 + rng() * 0.18));
      const ufVolumeL = Math.round(Math.min(5.5, idwgKg * (0.85 + rng() * 0.2)) * 100) / 100;
      // mL/h = litres removed × 1000 ÷ hours delivered
      const ufRateMlH = Math.round((ufVolumeL * 1000 * 60) / deliveredMinutes);
      const preSbp = Math.round(104 + rng() * 46);
      const window: FluidPatientWindow = {
        patientId,
        sessionCount: 6,
        telemetryPoints: 12,
        plannedMinutes,
        deliveredMinutes,
        ufVolumeL,
        ufRateMlH,
        postWeightKg,
        preSbp,
        nadirSbp: priorNadir,
        nadirSbpPrev: priorNadir,
        idwgKg,
        adherencePct: Math.round((deliveredMinutes / plannedMinutes) * 100),
        age,
        cardiacHistory: cardiac,
        asOf: '2026-09-01T00:00:00Z',
      };
      const priorRisk = idhProbability({
        ufRatePerKg: Math.round((ufRateMlH / postWeightKg) * 100) / 100,
        currentSbp: preSbp,
        nadirSbpPrev: priorNadir,
        idwgKg,
        age,
        cardiacHistory: cardiac,
        minute: 60,
      });
      // Generative truth: the prior's additive shape PLUS interaction structure
      // an additive logistic model cannot express (rate × cardiac, prior nadir ×
      // IDWG, small body size × shortened session). Trees can capture these,
      // which is exactly why the head exists alongside the mechanistic prior.
      const ratePerKg = ufRateMlH / postWeightKg;
      const z =
        -2.0
        + 0.55 * Math.max(0, ratePerKg - 7)
        + 0.065 * (110 - preSbp)
        + (priorNadir < 90 ? 0.7 : 0)
        + Math.max(0, idwgKg - 3) * 0.45
        + 0.8 * (age >= 80 ? 1 : 0)
        + 0.7 * (cardiac ? 1 : 0)
        // interactions (the head's reason to exist)
        + 1.3 * (ratePerKg > 11 ? 1 : 0) * (cardiac ? 1 : 0)
        + 1.1 * (priorNadir < 90 ? 1 : 0) * (idwgKg > 3.5 ? 1 : 0)
        + 0.9 * (postWeightKg < 62 ? 1 : 0) * (deliveredMinutes < plannedMinutes * 0.9 ? 1 : 0)
        + (rng() - 0.5) * 0.5;
      const probability = 1 / (1 + Math.exp(-z));
      const label: 0 | 1 = rng() < probability ? 1 : 0;
      rows.push({ patientId, features: buildFluidVector(window, priorRisk), label, priorRisk });
    }
  }
  return rows;
}

/** Train the IDH head on a PATIENT-level split and compare against the prior. */
export function trainFluidArtifact(rows: readonly FluidTrainingRow[], opts: { salt?: string; trainFraction?: number } = {}): FluidArtifact {
  const split = patientLevelSplit([...new Set(rows.map((r) => r.patientId))], {
    ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
    ...(opts.trainFraction !== undefined ? { trainFraction: opts.trainFraction } : {}),
  });
  const { train, test } = filterByPatientSplit(rows as FluidTrainingRow[], split);
  const samples: GbtSample[] = train.map((r) => ({ features: r.features, target: r.label }));
  const model = fitGbt(samples, FLUID_MODEL_FEATURES, { trees: 40, maxDepth: 2, learningRate: 0.12, minSamplesLeaf: 20, subsample: 0.9, maxThresholds: 24 })!;
  // Ablation: the same booster with ONLY the mechanistic prior as input. If the
  // full head cannot beat this, the extra features are adding noise, not signal.
  const priorOnlyModel = fitGbt(train.map<GbtSample>((r) => ({ features: [r.priorRisk], target: r.label })), ['priorRisk'], { trees: 40, maxDepth: 2, learningRate: 0.12, minSamplesLeaf: 20, subsample: 0.9, maxThresholds: 24 });
  const priorOnlyPairs = priorOnlyModel
    ? test.map((r) => ({ score: Math.min(1, Math.max(0, predictGbt(priorOnlyModel, [r.priorRisk]))), label: r.label }))
    : [];

  const predicted = test.map((r) => ({ score: Math.min(1, Math.max(0, predictGbt(model, r.features))), label: r.label }));
  const priorPairs = test.map((r) => ({ score: r.priorRisk, label: r.label }));
  const head = auroc(predicted);
  const prior = auroc(priorPairs);
  const positives = predicted.filter((p) => p.label === 1).length;
  const negatives = predicted.length - positives;

  return {
    id: FLUID_ARTIFACT_ID,
    version: '1.0.0',
    kind: 'gbdt-regression',
    trainedAt: new Date().toISOString(),
    rows: rows.length,
    patients: new Set(rows.map((r) => r.patientId)).size,
    model,
    modelCard: gbtModelCard(model, {
      artifact: FLUID_ARTIFACT_ID,
      target: 'intradialytic hypotension event (nadir SBP < 90 or ≥20 mmHg fall)',
      trainedOn: 'synthetic intra-session generator (physiologically consistent)',
      benchmark: 'published temporal-fusion-transformer AUROC 0.953 is the benchmark, not this model',
      patientLevelSplit: { train: split.train.length, test: split.test.length, overlap: false },
      features: [...FLUID_MODEL_FEATURES],
      sourceFeatures: FLUID_FEATURES.map((f) => f.id),
      prior: 'mechanistic logistic UF-rate/refill prior (src/swarm/fluid.ts idhProbability)',
      horizonsMinutes: [15, 30, 60],
    }),
    metrics: {
      ...(head ? { auroc: head.auroc } : {}),
      ...(brier(predicted) !== undefined ? { brier: brier(predicted) } : {}),
      ...(ece(predicted) !== undefined ? { ece: ece(predicted) } : {}),
      ...(prior ? { priorAuroc: prior.auroc } : {}),
      ...(brier(priorPairs) !== undefined ? { priorBrier: brier(priorPairs) } : {}),
      ...(priorOnlyPairs.length && auroc(priorOnlyPairs) ? { priorOnlyHeadAuroc: auroc(priorOnlyPairs)!.auroc } : {}),
      positives,
      negatives,
    },
    reliability: reliabilityBins(predicted, 5),
    synthetic: true,
  };
}

export function saveFluidArtifact(artifact: FluidArtifact, path = FLUID_ARTIFACT_PATH): string {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return absolute;
}

let cachedFluid: FluidArtifact | undefined;

export function loadFluidArtifact(path = FLUID_ARTIFACT_PATH): FluidArtifact | undefined {
  if (cachedFluid && path === FLUID_ARTIFACT_PATH) return cachedFluid;
  try {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as FluidArtifact;
    if (!validateGbtModel(parsed.model).valid) return undefined;
    if (path === FLUID_ARTIFACT_PATH) cachedFluid = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

export function fluidArtifactStatus(path = FLUID_ARTIFACT_PATH): {
  present: boolean;
  id?: string | undefined;
  version?: string | undefined;
  trainedAt?: string | undefined;
  rows?: number | undefined;
  patients?: number | undefined;
  metrics?: FluidArtifact['metrics'] | undefined;
  attribution?: ReturnType<typeof gbtAttribution> | undefined;
  /** acceptance verdicts — recorded honestly, not asserted */
  meetsSyntheticAurocTarget: boolean;
  beatsPriorDiscrimination: boolean;
  improvesCalibration: boolean;
  /** which model the trained advisor actually ranks with */
  ranker: 'head' | 'prior';
  note: string;
} {
  const artifact = loadFluidArtifact(path);
  if (!artifact) {
    return {
      present: false,
      meetsSyntheticAurocTarget: false,
      beatsPriorDiscrimination: false,
      improvesCalibration: false,
      ranker: 'prior',
      note: 'No artifact — the mechanistic prior ranks.',
    };
  }
  const auroc = artifact.metrics.auroc ?? 0;
  const priorAuroc = artifact.metrics.priorAuroc ?? 1;
  const brier = artifact.metrics.brier ?? 1;
  const priorBrier = artifact.metrics.priorBrier ?? 0;
  const beatsPriorDiscrimination = auroc > priorAuroc;
  const improvesCalibration = brier < priorBrier;
  return {
    present: true,
    id: artifact.id,
    version: artifact.version,
    trainedAt: artifact.trainedAt,
    rows: artifact.rows,
    patients: artifact.patients,
    metrics: artifact.metrics,
    attribution: gbtAttribution(artifact.model, 6),
    meetsSyntheticAurocTarget: auroc >= 0.85,
    beatsPriorDiscrimination,
    improvesCalibration,
    ranker: beatsPriorDiscrimination ? 'head' : 'prior',
    note: beatsPriorDiscrimination
      ? `Head discriminates better than the mechanistic prior (AUROC ${auroc} vs ${priorAuroc}) — the head ranks.`
      : `Head does NOT beat the mechanistic prior on discrimination (AUROC ${auroc} vs ${priorAuroc})${improvesCalibration ? `, but it is better calibrated (Brier ${brier} vs ${priorBrier})` : ''} — the prior ranks and the head is retained for calibration and for the real-data path. Recorded as a negative result rather than hidden.`,
  };
}

/**
 * Trained advisor — same contract as the reference surrogate, with the learned
 * head replacing the mechanistic probability (and the prior kept for contrast).
 */
export function fluidRecommendTrained(
  window: FluidPatientWindow,
  opts: { path?: string } = {},
): (FluidRecommendation & { trained?: { artifactId: string; priorRisk60: number; headRisk60: number; ranker: 'head' | 'prior'; horizon: Record<number, number> } }) | FluidRecommendation {
  const artifact = loadFluidArtifact(opts.path ?? FLUID_ARTIFACT_PATH);
  const base = fluidRecommend(window);
  if (!artifact) return { ...base, model: { ...FLUID_ADVISOR_MODEL, kind: 'reference-surrogate' } };

  const priorRisk60 = base.current.idhRiskByMinute?.[60] ?? idhProbability({ currentSbp: window.nadirSbp ?? window.preSbp ?? 110, minute: 60 });
  const features = buildFluidVector(window, priorRisk60);
  const headRisk60 = Math.min(1, Math.max(0.001, Math.round(predictGbt(artifact.model, features) * 1000) / 1000));
  // Rank with whichever model actually discriminates better on held-out sessions.
  const headWins = (artifact.metrics.auroc ?? 0) > (artifact.metrics.priorAuroc ?? 1);
  const ranker: 'head' | 'prior' = headWins ? 'head' : 'prior';
  const anchor = headWins ? headRisk60 : priorRisk60;
  const horizon: Record<number, number> = {};
  for (const minute of [15, 30, 60]) {
    const priorAt = base.current.idhRiskByMinute?.[minute] ?? priorRisk60;
    horizon[minute] = Math.round(Math.min(1, Math.max(0.001, (priorAt / Math.max(0.01, priorRisk60)) * anchor)) * 1000) / 1000;
  }

  return {
    ...base,
    model: { id: FLUID_ARTIFACT_ID, version: artifact.version, kind: 'trained' },
    current: { ...base.current, idhRiskByMinute: horizon },
    note: `${base.note} Learned head (${FLUID_ARTIFACT_ID}): 60-min IDH risk ${headRisk60} vs mechanistic ${priorRisk60} — ranking with the ${ranker} (held-out AUROC ${ranker === 'head' ? artifact.metrics.auroc : artifact.metrics.priorAuroc}).`,
    trained: { artifactId: FLUID_ARTIFACT_ID, priorRisk60, headRisk60, ranker, horizon },
  };
}
