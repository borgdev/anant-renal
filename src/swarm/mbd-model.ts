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

// P4 step E — the COUPLED multi-output CKD-MBD artifact.
//
//   npx tsx scripts/train-mbd-model.ts
//
// Three regression heads (phosphate, corrected calcium, PTH) trained on the
// coupled responder's structure plus interaction terms the additive mechanical
// prior cannot express (binder class × calcium, calcimimetic × baseline calcium,
// vitamin D × phosphate). The published cross-sectional SVM (AUC 0.840) is the
// BENCHMARK for a risk classifier — not our target and not a result of this
// system. The §2.5 acceptance is a per-analyte multi-output MAE, reported
// against the mechanical prior, so the metric matches the claim.

import { fitGbt, predictGbt, gbtModelCard, gbtAttribution, type GbtModel } from '../protocols/gbdt.js';
import { mae, rmse, bias as biasMetric, correlation } from '../protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit } from '../protocols/split.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MBD_FEATURES, MBD_REFERENCE, correctedCalcium, projectMbdTherapy,
  type MbdCoupledInput, type MbdTherapyState,
} from './mbd.js';

export const MBD_ARTIFACT_ID = 'mbd.coupled-v1';
export const MBD_ARTIFACT_PATH = 'mbd-train/artifacts/mbd.coupled-v1.json';

/** One vector, three targets — the coupling is in the features AND the heads. */
export const MBD_MODEL_FEATURES = [
  'phosphate',
  'correctedCalcium',
  'pth',
  'albumin',
  'vitaminD',
  'binderMgPerDay',
  'calcimimeticMgPerDay',
  'activeVitaminDMcgPerDay',
  'binderIsCalciumBased',
  'binderDoseDeltaG',
  'calcimimeticDoseDelta',
  'vitaminDDelta',
  'adherenceRatio',
  'ktV',
  'phosphateTrend30d',
  'calciumTrend30d',
] as const;

export type MbdHead = 'phosphate' | 'correctedCalcium' | 'pth';

/** Per-head regression metrics (the §2.5 acceptance metric — not AUROC). */
export interface HeadMetrics {
  n: number;
  mae?: number | undefined;
  rmse?: number | undefined;
  bias?: number | undefined;
  correlation?: number | undefined;
}

export interface MbdTrainingRow {
  patientId: string;
  features: number[];
  targets: { phosphate: number; correctedCalcium: number; pth: number };
  /** the mechanical coupled prior's projection (the thing to beat) */
  prior: { phosphate: number; correctedCalcium: number; pth: number };
}

export interface MbdArtifact {
  id: string;
  version: string;
  kind: 'gbdt-multi-output';
  trainedAt: string;
  rows: number;
  patients: number;
  horizonDays: number;
  heads: Record<MbdHead, { model: GbtModel; metrics: HeadMetrics; prior: HeadMetrics }>;
  metrics: {
    /** per-analyte MAE of the coupled heads */
    mae: { phosphate: number; correctedCalcium: number; pth: number };
    /** per-analyte MAE of the mechanical prior */
    priorMae: { phosphate: number; correctedCalcium: number; pth: number };
    /** coupling correlation between the heads' errors (are they coupled?) */
    couplingCorrelation: number;
    calibrationOfRiskHeads: { hyperphosphatemiaBrier?: number | undefined; hypercalcemiaBrier?: number | undefined };
  };
  modelCard: Record<string, unknown>;
  referenceArchitecture: string;
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
 * Synthetic therapy-response cohorts. The observed 30-day change is drawn from
 * the coupled responder PLUS structure the responder lacks, so the heads have a
 * genuine correction to learn:
 *   - a real cohort responds late and incompletely (per-patient response gain),
 *   - binder dose-response saturates differently at high dose,
 *   - the calcium response to a calcium-based binder depends on the baseline
 *     calcium (interaction),
 *   - PTH responds with a rebound when phosphate falls fast.
 */
export function buildMbdTrainingRows(opts: { patients?: number; stepsPerPatient?: number; seed?: number; horizonDays?: number } = {}): MbdTrainingRow[] {
  const patients = opts.patients ?? 120;
  const stepsPerPatient = opts.stepsPerPatient ?? 8;
  const horizonDays = opts.horizonDays ?? 30;
  const rows: MbdTrainingRow[] = [];
  for (let p = 0; p < patients; p += 1) {
    const rng = mulberry32((opts.seed ?? 13) * 7919 + p * 104729);
    const patientId = `mbd-train-pt-${String(p + 1).padStart(4, '0')}`;
    const responseGain = 0.6 + rng() * 0.8; // per-patient response magnitude
    const basePhosphate = 3.6 + rng() * 3.6;
    const baseCalcium = 8.4 + rng() * 1.9;
    const basePth = 120 + rng() * 900;
    const albumin = 3.0 + rng() * 1.2;
    const vitaminD = 8 + rng() * 30;
    const ktV = 1.0 + rng() * 0.6;
    const baselineBinder = [0, 1600, 2400, 3200][Math.floor(rng() * 4)]!;
    const binderClass: MbdTherapyState['binderClass'] = baselineBinder === 0 ? 'none' : rng() < 0.45 ? 'calcium-acetate' : 'sevelamer';
    for (let s = 0; s < stepsPerPatient; s += 1) {
      const current: MbdTherapyState = {
        binderMgPerDay: baselineBinder,
        binderClass,
        calcimimeticMgPerDay: rng() < 0.3 ? 30 + Math.round(rng() * 3) * 30 : 0,
        activeVitaminDMcgPerDay: rng() < 0.4 ? 0.25 + Math.round(rng() * 4) * 0.25 : 0,
      };
      const next: MbdTherapyState = {
        binderMgPerDay: Math.max(0, current.binderMgPerDay + ([-1600, 0, 1200, 2400, 3600][Math.floor(rng() * 5)]!)),
        binderClass: current.binderClass === 'calcium-acetate' && rng() < 0.3 ? 'sevelamer' : current.binderClass,
        calcimimeticMgPerDay: Math.max(0, current.calcimimeticMgPerDay + (rng() < 0.5 ? 30 : -30)),
        activeVitaminDMcgPerDay: Math.max(0, current.activeVitaminDMcgPerDay + (rng() < 0.5 ? 0.25 : -0.25)),
      };
      const input: MbdCoupledInput = {
        patientId,
        phosphate: Math.round(basePhosphate * 100) / 100,
        calcium: Math.round((baseCalcium - 0) * 100) / 100,
        albumin,
        pth: Math.round(basePth),
        vitaminD: Math.round(vitaminD),
        therapy: current,
        binderDosesPerWeek: Math.round(rng() * 21),
        prescribedDosesPerWeek: 21,
        ktV: Math.round(ktV * 100) / 100,
        phosphateTrend30d: Math.round((rng() - 0.5) * 1.2 * 100) / 100,
        calciumTrend30d: Math.round((rng() - 0.5) * 0.6 * 100) / 100,
      };

      const priorProjection = projectMbdTherapy(input, next);
      const priorPoint = priorProjection.points[horizonDays] ?? priorProjection.points[30]!;

      // the truth: responder shape (scaled by the patient's gain) + interactions
      const binderDeltaG = (next.binderMgPerDay - current.binderMgPerDay) / 1000;
      const calcimimeticDelta = (next.calcimimeticMgPerDay - current.calcimimeticMgPerDay) / 30;
      const vitDDelta = next.activeVitaminDMcgPerDay - current.activeVitaminDMcgPerDay;
      const calciumBased = next.binderClass === 'calcium-acetate' ? 1 : 0;
      const adherence = input.binderDosesPerWeek! / 21;

      const phosphateTruth = basePhosphate
        - responseGain * 1.05 * (binderDeltaG / (1 + Math.abs(binderDeltaG) / 3.2))
        - responseGain * 0.5 * calcimimeticDelta
        + responseGain * 0.5 * vitDDelta
        - responseGain * 0.2 * (ktV - 1.2) * 2
        - 0.3 * (adherence - 0.8)
        + (binderDeltaG > 2 ? -0.25 : 0) // high-dose saturation the prior misses
        + (rng() - 0.5) * 0.22;

      const calciumTruth = correctedCalcium(baseCalcium, albumin)
        + responseGain * 0.32 * calciumBased * Math.max(0, binderDeltaG)
        + responseGain * 0.9 * calciumBased * Math.max(0, 10.0 - correctedCalcium(baseCalcium, albumin)) // interaction: low baseline calcium responds more
        + responseGain * 0.34 * vitDDelta
        - responseGain * 0.5 * calcimimeticDelta
        + (rng() - 0.5) * 0.16;

      const pthTruth = basePth
        - responseGain * 95 * calcimimeticDelta
        - responseGain * 40 * vitDDelta
        - responseGain * 34 * (basePhosphate - phosphateTruth)
        + (binderDeltaG > 2 ? 55 : 0) // PTH rebound on a fast phosphate fall
        - responseGain * 8 * (ktV - 1.2) * 2
        + (rng() - 0.5) * 22;

      rows.push({
        patientId,
        features: buildMbdVector(input, next),
        targets: {
          phosphate: Math.round(Math.max(1.2, phosphateTruth) * 100) / 100,
          correctedCalcium: Math.round(Math.max(6.5, calciumTruth) * 100) / 100,
          pth: Math.round(Math.max(10, pthTruth)),
        },
        prior: {
          phosphate: priorPoint.phosphate,
          correctedCalcium: priorPoint.correctedCalcium,
          pth: priorPoint.pth,
        },
      });
    }
  }
  return rows;
}

export function buildMbdVector(input: MbdCoupledInput, next: MbdTherapyState): number[] {
  const current = input.therapy ?? { binderMgPerDay: 0, binderClass: 'none' as const, calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };
  const prescribed = input.prescribedDosesPerWeek ?? 21;
  const adherence = input.binderDosesPerWeek !== undefined ? input.binderDosesPerWeek / prescribed : 1;
  return [
    input.phosphate ?? 4.8,
    correctedCalcium(input.calcium ?? 9, input.albumin),
    input.pth ?? 320,
    input.albumin ?? 3.7,
    input.vitaminD ?? 20,
    current.binderMgPerDay,
    current.calcimimeticMgPerDay,
    current.activeVitaminDMcgPerDay,
    next.binderClass === 'calcium-acetate' ? 1 : 0,
    (next.binderMgPerDay - current.binderMgPerDay) / 1000,
    (next.calcimimeticMgPerDay - current.calcimimeticMgPerDay) / 30,
    next.activeVitaminDMcgPerDay - current.activeVitaminDMcgPerDay,
    Math.round(adherence * 100) / 100,
    input.ktV ?? 1.3,
    input.phosphateTrend30d ?? 0,
    input.calciumTrend30d ?? 0,
  ];
}

export function trainMbdArtifact(rows: readonly MbdTrainingRow[], opts: { salt?: string; trainFraction?: number; horizonDays?: number } = {}): MbdArtifact {
  const split = patientLevelSplit([...new Set(rows.map((r) => r.patientId))], {
    salt: opts.salt ?? 'mbd-v1',
    trainFraction: opts.trainFraction ?? 0.75,
  });
  const { train, test } = filterByPatientSplit(rows, split);
  if (!train.length || !test.length) throw new Error('mbd-split-empty');

  const horizonDays = opts.horizonDays ?? 30;
  const heads = {} as MbdArtifact['heads'];
  const maeOut = {} as MbdArtifact['metrics']['mae'];
  const priorMaeOut = {} as MbdArtifact['metrics']['priorMae'];
  const headErrors: Record<MbdHead, number[]> = { phosphate: [], correctedCalcium: [], pth: [] };

  for (const head of ['phosphate', 'correctedCalcium', 'pth'] as MbdHead[]) {
    const samples = train.map((r) => ({ features: r.features, target: r.targets[head] }));
    const scale = head === 'pth' ? 100 : 1;
    const model = fitGbt(
      samples.map((s) => ({ features: s.features, target: s.target / scale })),
      MBD_MODEL_FEATURES,
      { trees: 90, maxDepth: 3, learningRate: 0.14, minSamplesLeaf: 8, subsample: 0.9, maxThresholds: 24 },
    )!;
    const predicted = test.map((r) => ({ predicted: predictGbt(model, r.features) * scale, observed: r.targets[head] }));
    const priorPairs = test.map((r) => ({ predicted: r.prior[head], observed: r.targets[head] }));
    for (const pair of predicted) headErrors[head].push(pair.predicted - pair.observed);
    heads[head] = {
      model,
      metrics: {
        n: predicted.length,
        mae: mae(predicted),
        rmse: rmse(predicted),
        bias: biasMetric(predicted),
        correlation: correlation(predicted),
      },
      prior: {
        n: priorPairs.length,
        mae: mae(priorPairs),
        rmse: rmse(priorPairs),
        bias: biasMetric(priorPairs),
        correlation: correlation(priorPairs),
      },
    };
    maeOut[head] = Math.round((heads[head].metrics.mae ?? 0) * 1000) / 1000;
    priorMaeOut[head] = Math.round((heads[head].prior.mae ?? 0) * 1000) / 1000;
  }

  // are the head errors coupled? (a positive correlation is the point of P4)
  const coupling = correlation(headErrors.phosphate.map((v, i) => ({ predicted: v, observed: headErrors.correctedCalcium[i] ?? 0 })));

  return {
    id: MBD_ARTIFACT_ID,
    version: '1.0.0',
    kind: 'gbdt-multi-output',
    trainedAt: new Date().toISOString(),
    rows: rows.length,
    patients: new Set(rows.map((r) => r.patientId)).size,
    horizonDays,
    heads,
    metrics: {
      mae: maeOut,
      priorMae: priorMaeOut,
      couplingCorrelation: coupling === undefined ? 0 : Math.round(coupling * 1000) / 1000,
      calibrationOfRiskHeads: {},
    },
    modelCard: {
      features: [...MBD_MODEL_FEATURES],
      heads: ['phosphate', 'correctedCalcium', 'pth'],
      attribution: {
        phosphate: gbtAttribution(heads.phosphate.model, 5),
        correctedCalcium: gbtAttribution(heads.correctedCalcium.model, 5),
        pth: gbtAttribution(heads.pth.model, 5),
      },
      validation: { phosphate: mbdCardOf(heads.phosphate.model), correctedCalcium: mbdCardOf(heads.correctedCalcium.model), pth: mbdCardOf(heads.pth.model) },
      synthetic: true,
      targetRange: MBD_REFERENCE.phosphateTargetMgDl,
    },
    referenceArchitecture: 'Published cross-sectional SVM (AUC 0.840) is the benchmark for a risk classifier, not a result of this system; the served artifact is the coupled multi-output [P, Ca, PTH] temporal model.',
    synthetic: true,
  };
}

function mbdCardOf(model: GbtModel): Record<string, unknown> {
  return gbtModelCard(model, { featureNames: [...MBD_MODEL_FEATURES] });
}

export function saveMbdArtifact(artifact: MbdArtifact, path = MBD_ARTIFACT_PATH): string {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

export function loadMbdArtifact(path = MBD_ARTIFACT_PATH): MbdArtifact | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as MbdArtifact;
  } catch {
    return undefined;
  }
}

export function mbdArtifactStatus(path = MBD_ARTIFACT_PATH): {
  present: boolean;
  id?: string | undefined;
  version?: string | undefined;
  trainedAt?: string | undefined;
  rows?: number | undefined;
  patients?: number | undefined;
  metrics?: MbdArtifact['metrics'] | undefined;
  attribution?: MbdArtifact['modelCard']['attribution'] | undefined;
  /** acceptance: every head's MAE ≤ the mechanical prior's MAE */
  beatsPriorOnAllHeads: boolean;
  band: 'pass' | 'watch' | 'insufficient';
  note: string;
} {
  const artifact = loadMbdArtifact(path);
  if (!artifact) {
    return { present: false, beatsPriorOnAllHeads: false, band: 'insufficient', note: 'No artifact — the coupled mechanical responder serves projections.' };
  }
  const heads: MbdHead[] = ['phosphate', 'correctedCalcium', 'pth'];
  const beats = heads.every((h) => artifact.metrics.mae[h] <= artifact.metrics.priorMae[h]);
  const strict = heads.filter((h) => artifact.metrics.mae[h] < artifact.metrics.priorMae[h]).length;
  return {
    present: true,
    id: artifact.id,
    version: artifact.version,
    trainedAt: artifact.trainedAt,
    rows: artifact.rows,
    patients: artifact.patients,
    metrics: artifact.metrics,
    attribution: artifact.modelCard.attribution,
    beatsPriorOnAllHeads: beats,
    band: beats && strict === heads.length ? 'pass' : beats ? 'watch' : 'insufficient',
    note: beats
      ? `Coupled heads beat the mechanical responder on every analyte — phosphate MAE ${artifact.metrics.mae.phosphate} (prior ${artifact.metrics.priorMae.phosphate}), Ca ${artifact.metrics.mae.correctedCalcium} (prior ${artifact.metrics.priorMae.correctedCalcium}), PTH ${artifact.metrics.mae.pth} (prior ${artifact.metrics.priorMae.pth}).`
      : `Coupled heads do not beat the mechanical responder on every analyte — phosphate ${artifact.metrics.mae.phosphate} vs ${artifact.metrics.priorMae.phosphate}, Ca ${artifact.metrics.mae.correctedCalcium} vs ${artifact.metrics.priorMae.correctedCalcium}, PTH ${artifact.metrics.mae.pth} vs ${artifact.metrics.priorMae.pth}. The responder serves projections; the negative result is recorded.`,
  };
}

/** Trained projection for one candidate therapy: three heads, one coupled answer. */
export function mbdProjectTrained(
  input: MbdCoupledInput,
  next: MbdTherapyState,
  opts: { path?: string } = {},
): { trained?: { artifactId: string; point: { phosphate: number; correctedCalcium: number; pth: number }; priorPoint: { phosphate: number; correctedCalcium: number; pth: number }; ranker: 'head' | 'prior' } } {
  const artifact = loadMbdArtifact(opts.path ?? MBD_ARTIFACT_PATH);
  if (!artifact) return {};
  const vector = buildMbdVector(input, next);
  const point = {
    phosphate: Math.round(predictGbt(artifact.heads.phosphate.model, vector) * 100) / 100,
    correctedCalcium: Math.round(predictGbt(artifact.heads.correctedCalcium.model, vector) * 100) / 100,
    pth: Math.round(predictGbt(artifact.heads.pth.model, vector) * 100),
  };
  const priorProjection = projectMbdTherapy(input, next);
  const priorPoint = priorProjection.points[artifact.horizonDays] ?? priorProjection.points[30]!;
  const status = mbdArtifactStatus(opts.path);
  return {
    trained: {
      artifactId: MBD_ARTIFACT_ID,
      point,
      priorPoint: { phosphate: priorPoint.phosphate, correctedCalcium: priorPoint.correctedCalcium, pth: priorPoint.pth },
      ranker: status.beatsPriorOnAllHeads ? 'head' : 'prior',
    },
  };
}

export { MBD_FEATURES, MBD_REFERENCE };
