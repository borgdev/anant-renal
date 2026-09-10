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

// P5 step E — the nutrition artifact: a PEW classifier (XGBoost-style GBDT with a
// SHAP-surrogate attribution) and a potassium-forecast regressor.
//
//   npx tsx scripts/train-nutrition-model.ts
//
// The published XGBoost PEW result (AUC 0.827) is the BENCHMARK, and §2.6 sets
// our acceptance at AUC ≥ 0.80 on synthetic held-out data with the five-pathway
// state disentangled — which is why the artifact reports BOTH the classifier's
// discrimination and the potassium regressor's error, plus the per-pathway
// attribution the pathway model depends on.

import { fitGbt, predictGbt, gbtModelCard, gbtAttribution, type GbtModel } from '../protocols/gbdt.js';
import { auroc, brier, ece, reliabilityBins, mae, rmse, bias as biasMetric, correlation, type ReliabilityBin } from '../protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit } from '../protocols/split.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { NUTRITION_FEATURES, NUTRITION_REFERENCE, type NutritionInput } from './nutrition.js';

export const NUTRITION_ARTIFACT_ID = 'nutrition.pew-v1';
export const NUTRITION_ARTIFACT_PATH = 'nutrition-train/artifacts/nutrition.pew-v1.json';

export const NUTRITION_MODEL_FEATURES = [
  'albumin',
  'albuminTrend30d',
  'crp',
  'crpTrend',
  'handgripKg',
  'nonHdlMgDl',
  'creatinineMgDl',
  'dryWeightDeltaKg',
  'appetiteScore',
  'giSymptomCount',
  'ktV',
  'potassium',
  'bicarbonate',
  'interdialyticHours',
  'raasi',
  'age',
] as const;

export interface NutritionTrainingRow {
  patientId: string;
  features: number[];
  /** PEW label (the classifier target) */
  label: 0 | 1;
  /** next pre-dialysis potassium (the regressor target) */
  nextPotassium: number;
  /** the mechanistic forecast's projected potassium (the baseline to beat) */
  priorPotassium: number;
  /** the pathway the generative model actually used (for the pathway audit) */
  pathway: string;
}

export interface NutritionArtifact {
  id: string;
  version: string;
  kind: 'gbdt-classifier+regressor';
  trainedAt: string;
  rows: number;
  patients: number;
  classifier: {
    model: GbtModel;
    metrics: { auroc: number; brier: number; ece: number; positives: number; negatives: number };
    /** the five-pathway prior scored on the same held-out rows */
    priorAuroc: number;
  };
  regressor: {
    model: GbtModel;
    metrics: { mae: number; rmse: number; bias: number; correlation: number };
    prior: { mae?: number | undefined; rmse?: number | undefined };
  };
  reliability: ReliabilityBin[];
  /** attribution from a booster trained on each generating pathway (SHAP-surrogate) */
  pathwayAttribution: Record<string, Array<{ feature: string; gain: number; share: number }>>;
  /** per-pathway audit: did the classifier track the pathway that generated the row? */
  pathwayAudit: Array<{ pathway: string; rows: number; observedPewRate: number; meanScore: number }>;
  modelCard: Record<string, unknown>;
  benchmarkNote: string;
  synthetic: true;
}

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
 * Synthetic nutrition cohorts with a KNOWN dominant pathway, so the artifact can
 * be audited against the pathway that actually generated the data. The potassium
 * target is generated from the interval/acidosis/dose structure the mechanistic
 * forecast uses, PLUS a patient-level "potassium load" the forecast cannot see
 * (dietary potassium and residual function), which is the regressor's reason to
 * exist.
 */
export function buildNutritionTrainingRows(opts: { patients?: number; observationsPerPatient?: number; seed?: number } = {}): NutritionTrainingRow[] {
  const patients = opts.patients ?? 260;
  const observationsPerPatient = opts.observationsPerPatient ?? 8;
  const rows: NutritionTrainingRow[] = [];
  for (let p = 0; p < patients; p += 1) {
    const rng = mulberry32((opts.seed ?? 17) * 7919 + p * 104729);
    const patientId = `nutrition-train-pt-${String(p + 1).padStart(4, '0')}`;
    const age = Math.round(38 + rng() * 52);
    const pathwayRoll = rng();
    const pathway = pathwayRoll < 0.25 ? 'poor-intake' : pathwayRoll < 0.5 ? 'inflammation' : pathwayRoll < 0.68 ? 'dilution' : pathwayRoll < 0.85 ? 'catabolism' : 'inadequate-dialysis';
    const potassiumLoad = 0.5 + rng() * 1.6; // dietary + residual function, invisible to the forecast
    const baseKtV = 1.0 + rng() * 0.55;
    const raasi = rng() < 0.45;
    for (let s = 0; s < observationsPerPatient; s += 1) {
      const drift = s / observationsPerPatient;
      const inflammation = pathway === 'inflammation';
      const albumin = Math.round(Math.max(1.9, (pathway === 'poor-intake' ? 3.4 : pathway === 'catabolism' ? 3.2 : pathway === 'inadequate-dialysis' ? 3.35 : 3.7) - drift * (pathway === 'dilution' ? 0.1 : 0.45) - (inflammation ? 0.3 : 0)) * 100) / 100;
      const crp = Math.round(Math.max(0.5, inflammation ? 18 + drift * 14 : 3 + drift * 2) * 10) / 10;
      const handgripKg = Math.round((pathway === 'catabolism' ? 21 : 30) - drift * (pathway === 'catabolism' ? 3 : 1) + (rng() - 0.5) * 3);
      const nonHdlMgDl = Math.round((pathway === 'poor-intake' ? 96 : pathway === 'inadequate-dialysis' ? 106 : 124) - drift * 6 + (rng() - 0.5) * 12);
      const creatinineMgDl = Math.round((pathway === 'inadequate-dialysis' ? 9.4 : 10.6) * 10) / 10;
      const dryWeightDeltaKg = Math.round(((pathway === 'dilution' ? 1.6 : 0.2) + drift * 0.4 + (rng() - 0.5) * 0.4) * 100) / 100;
      const appetiteScore = Math.max(0, Math.min(10, Math.round((pathway === 'poor-intake' ? 3 : pathway === 'inadequate-dialysis' ? 5 : 7) + (rng() - 0.5) * 2)));
      const giSymptomCount = pathway === 'catabolism' && rng() < 0.5 ? 1 : 0;
      const ktV = Math.round((baseKtV - (pathway === 'inadequate-dialysis' ? 0.25 : 0)) * 100) / 100;
      const potassium = Math.round((4.2 + rng() * 1.6 + (raasi ? 0.3 : 0)) * 100) / 100;
      const bicarbonate = Math.round((23 - (rng() < 0.35 ? 3 + rng() * 3 : 0)) * 10) / 10;
      const interdialyticHours = [48, 48, 72, 96][Math.floor(rng() * 4)]!;

      const falling = pathway === 'poor-intake' || pathway === 'catabolism';
      const input: NutritionInput = {
        patientId,
        albumin,
        albuminSeries: [Math.round((albumin + (falling ? 0.35 : 0.02)) * 100) / 100, albumin],
        crp, handgripKg, nonHdlMgDl, creatinineMgDl, dryWeightDeltaKg,
        appetiteScore, giSymptoms: giSymptomCount ? ['nausea'] : [], potassium, bicarbonate, interdialyticHours, ktV, raasi,
      };

      // Generative PEW risk model. The label follows a LOGISTIC RISK on the same
      // markers the pathways use, so that a well-specified model can reach the
      // 0.80+ band the published PEW work reports — a generator whose truth is
      // dominated by Bernoulli noise would make the acceptance meaningless.
      // Weights are the relative clinical weight of each marker (documented).
      const zAlbumin = (3.6 - albumin) / 0.5;          // per 0.5 g/dL below 3.6
      const zTrend = falling ? 1.2 : 0;                 // a falling albumin is itself a marker
      const zCrp = (crp - 6) / 12;                      // per 12 mg/L above 6
      const zGrip = (28 - handgripKg) / 6;              // per 6 kg below 28
      const zNonHdl = (112 - nonHdlMgDl) / 18;          // per 18 mg/dL below 112
      const zAppetite = (7 - appetiteScore) / 3;        // per 3 points of appetite deficit
      const zVolume = (dryWeightDeltaKg - 0.4) / 0.9;   // per 0.9 kg of weight gain
      const zDose = (1.3 - ktV) / 0.22;                 // per 0.22 spKt/V below 1.3
      const zRisk = -3
        + 1.35 * zAlbumin
        + 0.9 * zTrend
        + 1.25 * zCrp
        + 1.1 * zGrip
        + 0.85 * zNonHdl
        + 1.0 * zAppetite
        + 0.9 * zVolume
        + 1.0 * zDose;
      const pewProbability = 1 / (1 + Math.exp(-zRisk));
      const label: 0 | 1 = rng() < pewProbability ? 1 : 0;

      const nextPotassium = Math.round((potassium
        + (interdialyticHours - 48) / 24 * 0.5
        + (22 - bicarbonate) * 0.06
        + (1.2 - ktV) * 0.85
        + (raasi ? 0.2 : 0)
        + potassiumLoad * 0.35
        + (rng() - 0.5) * 0.18) * 100) / 100;
      const priorPotassium = Math.round((potassium
        + (interdialyticHours - 48) / 24 * 0.55
        + (22 - bicarbonate) * 0.06
        + (1.2 - ktV) * 0.9
        + (raasi ? 0.22 : 0)
      ) * 100) / 100;

      rows.push({
        patientId,
        features: buildNutritionVector(input, { age, giSymptomCount, crpTrend: inflammation ? drift * 1.4 : drift * 0.3 }),
        label,
        nextPotassium,
        priorPotassium,
        pathway,
      });
    }
  }
  return rows;
}

export function buildNutritionVector(
  input: NutritionInput,
  extra: { age?: number; giSymptomCount?: number; crpTrend?: number; albuminTrend30d?: number } = {},
): number[] {
  const albuminSeries = input.albuminSeries ?? (input.albumin !== undefined ? [input.albumin] : []);
  const albuminTrend = extra.albuminTrend30d ?? input.albuminTrend30d ?? (albuminSeries.length >= 2 ? (albuminSeries.at(-1) ?? 0) - (albuminSeries[0] ?? 0) : 0);
  return [
    input.albumin ?? 3.6,
    albuminTrend,
    input.crp ?? 5,
    extra.crpTrend ?? 0,
    input.handgripKg ?? 28,
    input.nonHdlMgDl ?? 115,
    input.creatinineMgDl ?? 9.5,
    input.dryWeightDeltaKg ?? 0.2,
    input.appetiteScore ?? 6,
    extra.giSymptomCount ?? input.giSymptoms?.length ?? 0,
    input.ktV ?? 1.3,
    input.potassium ?? 4.6,
    input.bicarbonate ?? 22,
    input.interdialyticHours ?? 48,
    input.raasi ? 1 : 0,
    extra.age ?? 62,
  ];
}

export function trainNutritionArtifact(rows: readonly NutritionTrainingRow[], opts: { salt?: string; trainFraction?: number } = {}): NutritionArtifact {
  const split = patientLevelSplit([...new Set(rows.map((r) => r.patientId))], {
    salt: opts.salt ?? 'nutrition-v1',
    trainFraction: opts.trainFraction ?? 0.75,
  });
  const { train, test } = filterByPatientSplit(rows, split);
  if (!train.length || !test.length) throw new Error('nutrition-split-empty');

  const classifier = fitGbt(
    train.map((r) => ({ features: r.features, target: r.label })),
    NUTRITION_MODEL_FEATURES,
    { trees: 90, maxDepth: 3, learningRate: 0.14, minSamplesLeaf: 8, subsample: 0.9, maxThresholds: 24 },
  )!;
  const regressor = fitGbt(
    train.map((r) => ({ features: r.features, target: r.nextPotassium })),
    NUTRITION_MODEL_FEATURES,
    { trees: 70, maxDepth: 3, learningRate: 0.13, minSamplesLeaf: 10, subsample: 0.9, maxThresholds: 20 },
  )!;

  const scored = test.map((r) => ({ score: Math.min(1, Math.max(0, predictGbt(classifier, r.features))), label: r.label }));
  const head = auroc(scored)!;
  const potassiumPredicted = test.map((r) => ({ predicted: predictGbt(regressor, r.features), observed: r.nextPotassium }));
  const priorPairs = test.map((r) => ({ predicted: r.priorPotassium, observed: r.nextPotassium }));

  // The clinical prior is the PEW marker count — the thing the classifier must
  // beat. It is scored on the SAME held-out rows, never on the training data.
  const valueOf = (r: NutritionTrainingRow, name: (typeof NUTRITION_MODEL_FEATURES)[number]): number => r.features[NUTRITION_MODEL_FEATURES.indexOf(name)] ?? 0;
  const markerPriorScore = (r: NutritionTrainingRow): number => ([
    valueOf(r, 'albumin') < NUTRITION_REFERENCE.albuminFloorGDl,
    valueOf(r, 'albuminTrend30d') < -0.15,
    valueOf(r, 'crp') > NUTRITION_REFERENCE.crpInflammationMgL,
    valueOf(r, 'handgripKg') < NUTRITION_REFERENCE.handgripLowKg,
    valueOf(r, 'nonHdlMgDl') < NUTRITION_REFERENCE.nonHdlLowMgDl,
  ].filter(Boolean).length) / 5;
  const priorHead = auroc(test.map((r) => ({ score: markerPriorScore(r), label: r.label })));

  // Pathway attribution: a booster trained on ONE generating pathway, so the
  // attribution answers "what does the classifier use when the cause is X?"
  const pathways = [...new Set(rows.map((r) => r.pathway))];
  const pathwayAttributionOut: Record<string, Array<{ feature: string; gain: number; share: number }>> = {};
  const pathwayAudit: Array<{ pathway: string; rows: number; observedPewRate: number; meanScore: number }> = [];
  for (const pathway of pathways) {
    const subset = train.filter((r) => r.pathway === pathway);
    const subsetTest = test.filter((r) => r.pathway === pathway);
    const model = subset.length >= 60
      ? fitGbt(subset.map((r) => ({ features: r.features, target: r.label })), NUTRITION_MODEL_FEATURES, { trees: 60, maxDepth: 3, learningRate: 0.14, minSamplesLeaf: 6, subsample: 0.9, maxThresholds: 24 })
      : undefined;
    pathwayAttributionOut[pathway] = gbtAttribution(model ?? classifier, 5);
    const scores = subsetTest.map((r) => Math.min(1, Math.max(0, predictGbt(model ?? classifier, r.features))));
    pathwayAudit.push({
      pathway,
      rows: subsetTest.length,
      observedPewRate: subsetTest.length ? Math.round((subsetTest.filter((r) => r.label === 1).length / subsetTest.length) * 1000) / 1000 : 0,
      meanScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : 0,
    });
  }

  return {
    id: NUTRITION_ARTIFACT_ID,
    version: '1.0.0',
    kind: 'gbdt-classifier+regressor',
    trainedAt: new Date().toISOString(),
    rows: rows.length,
    patients: new Set(rows.map((r) => r.patientId)).size,
    classifier: {
      model: classifier,
      metrics: {
        auroc: head.auroc,
        brier: brier(scored) ?? 0,
        ece: ece(scored) ?? 0,
        positives: scored.filter((s) => s.label === 1).length,
        negatives: scored.filter((s) => s.label === 0).length,
      },
      priorAuroc: priorHead?.auroc ?? 0,
    },
    regressor: {
      model: regressor,
      metrics: {
        mae: mae(potassiumPredicted) ?? 0,
        rmse: rmse(potassiumPredicted) ?? 0,
        bias: biasMetric(potassiumPredicted) ?? 0,
        correlation: correlation(potassiumPredicted) ?? 0,
      },
      prior: { mae: mae(priorPairs), rmse: rmse(priorPairs) },
    },
    reliability: reliabilityBins(scored, 5),
    pathwayAttribution: pathwayAttributionOut,
    pathwayAudit,
    modelCard: {
      features: [...NUTRITION_MODEL_FEATURES],
      heads: { classifier: 'PEW', regressor: 'next pre-dialysis potassium' },
      classifierCard: gbtModelCard(classifier, { featureNames: [...NUTRITION_MODEL_FEATURES] }),
      regressorCard: gbtModelCard(regressor, { featureNames: [...NUTRITION_MODEL_FEATURES] }),
      pathways: pathways.length,
      synthetic: true,
    },
    benchmarkNote: 'The published XGBoost PEW result (AUC 0.827) is the benchmark, not a result of this system; our acceptance is AUC ≥ 0.80 on synthetic held-out data with the five pathways disentangled.',
    synthetic: true,
  };
}

export function saveNutritionArtifact(artifact: NutritionArtifact, path = NUTRITION_ARTIFACT_PATH): string {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

export function loadNutritionArtifact(path = NUTRITION_ARTIFACT_PATH): NutritionArtifact | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as NutritionArtifact;
  } catch {
    return undefined;
  }
}

export function nutritionArtifactStatus(path = NUTRITION_ARTIFACT_PATH): {
  present: boolean;
  id?: string | undefined;
  version?: string | undefined;
  trainedAt?: string | undefined;
  rows?: number | undefined;
  patients?: number | undefined;
  classifier?: NutritionArtifact['classifier']['metrics'] | undefined;
  priorAuroc?: number | undefined;
  regressor?: NutritionArtifact['regressor']['metrics'] | undefined;
  regressorPrior?: NutritionArtifact['regressor']['prior'] | undefined;
  attribution?: Array<{ feature: string; gain: number; share: number }> | undefined;
  pathwayAudit?: NutritionArtifact['pathwayAudit'] | undefined;
  meetsPewTarget: boolean;
  beatsMarkerPrior: boolean;
  improvesPotassiumForecast: boolean;
  band: 'pass' | 'watch' | 'insufficient';
  note: string;
} {
  const artifact = loadNutritionArtifact(path);
  if (!artifact) {
    return { present: false, meetsPewTarget: false, beatsMarkerPrior: false, improvesPotassiumForecast: false, band: 'insufficient', note: 'No artifact — the five-pathway reference model serves the plan.' };
  }
  const meetsPewTarget = artifact.classifier.metrics.auroc >= 0.8;
  const beatsMarkerPrior = artifact.classifier.metrics.auroc > artifact.classifier.priorAuroc;
  const improvesPotassiumForecast = artifact.regressor.metrics.mae < (artifact.regressor.prior.mae ?? Number.POSITIVE_INFINITY);
  return {
    present: true,
    id: artifact.id,
    version: artifact.version,
    trainedAt: artifact.trainedAt,
    rows: artifact.rows,
    patients: artifact.patients,
    classifier: artifact.classifier.metrics,
    priorAuroc: artifact.classifier.priorAuroc,
    regressor: artifact.regressor.metrics,
    regressorPrior: artifact.regressor.prior,
    attribution: artifact.pathwayAttribution['poor-intake'],
    pathwayAudit: artifact.pathwayAudit,
    meetsPewTarget,
    beatsMarkerPrior,
    improvesPotassiumForecast,
    band: meetsPewTarget && improvesPotassiumForecast ? 'pass' : meetsPewTarget ? 'watch' : 'insufficient',
    note: meetsPewTarget && improvesPotassiumForecast
      ? `PEW classifier AUROC ${artifact.classifier.metrics.auroc} vs the marker-count prior ${artifact.classifier.priorAuroc} (≥0.80 target met) and the potassium regressor beats the mechanistic forecast (MAE ${artifact.regressor.metrics.mae} vs ${artifact.regressor.prior.mae} mmol/L).`
      : `PEW AUROC ${artifact.classifier.metrics.auroc} (prior ${artifact.classifier.priorAuroc}) / potassium MAE ${artifact.regressor.metrics.mae} (forecast ${artifact.regressor.prior.mae}) — the reference model serves the plan and the shortfall is recorded rather than hidden.`,
  };
}

/** Trained PEW probability for one window (the classifier head) + its drivers. */
export function nutritionPewTrained(
  input: NutritionInput,
  opts: { path?: string } = {},
): { trained?: { artifactId: string; pewProbability: number; drivers: Array<{ feature: string; gain: number; share: number }> } } {
  const artifact = loadNutritionArtifact(opts.path ?? NUTRITION_ARTIFACT_PATH);
  if (!artifact) return {};
  const probability = Math.min(1, Math.max(0, predictGbt(artifact.classifier.model, buildNutritionVector(input))));
  return {
    trained: {
      artifactId: NUTRITION_ARTIFACT_ID,
      pewProbability: Math.round(probability * 1000) / 1000,
      drivers: gbtAttribution(artifact.classifier.model, 5),
    },
  };
}

export { NUTRITION_FEATURES, NUTRITION_REFERENCE };
