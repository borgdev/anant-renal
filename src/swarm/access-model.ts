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

// P3 step E — vascular access artifact trainer.
//
//   npx tsx scripts/train-access-model.ts
//
// Δ-from-baseline head over the longitudinal pressure/flow/recirculation path,
// with ONE optional fused slot for the gated acoustic delta. The published
// mel-spectrogram CNN results (ResNet50 AUROC 0.99 / EfficientNetB5 0.98) are
// benchmarks for the audio path — they are not results of this system and are
// never claimed here. The strategy document's acceptance for the path we can
// actually run is: longitudinal-only AUROC ≥ 0.80 on synthetic held-out
// observations, patient-level split, audio gated and clearly labelled synthetic.
//
// The generative truth is deliberately tied to the machinery (venous-pressure
// rise drives the stenosis, recirculation and flow decline follow it) so a head
// that merely re-learns the prior gains nothing, while the interaction structure
// the prior cannot express (catheter × recirculation, age × pressure rise,
// cannulation injury × progression rate) is learnable.

import { fitLogistic, predictLogistic } from '../protocols/baselines.js';
import { auroc, brier, ece, reliabilityBins, reliabilitySlope, type ReliabilityBin } from '../protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit } from '../protocols/split.js';
import { fitGbt, predictGbt, gbtModelCard, gbtAttribution, validateGbtModel, type GbtModel } from '../protocols/gbdt.js';
import { ACCESS_FEATURES, stenosisProbability, type AccessGuardInput } from './access.js';
import { accessAcousticEnabled, ACCESS_ACOUSTIC_FLAG } from './access-governance.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const ACCESS_ARTIFACT_ID = 'access.stenosis-v1';
export const ACCESS_ARTIFACT_PATH = 'access-train/artifacts/access.stenosis-v1.json';

/**
 * Δ-from-baseline vector (longitudinal path + one gated acoustic slot). The
 * acoustic slot is 0 whenever the ingestion flag is off or provenance/label are
 * missing, so the served model cannot be influenced by an unlabelled capture.
 */
export const ACCESS_MODEL_FEATURES = [
  'venousPressureDeltaPct',
  'recirculationPct',
  'accessFlowDeltaPct',
  'venousPressureMmHg',
  'deliveredClearanceDeltaPct',
  'accessAgeDays',
  'cannulationDifficulty',
  'accessTypeCode',
  'priorInterventions',
  'daysSinceIntervention',
  'acousticDeltaScore',
] as const;

export type AccessAcousticCapture = {
  features: number[];
  baselineFeatures: number[];
  provenance: string;
  synthetic: boolean;
};

/**
 * Gated acoustic adapter. Returns `undefined` unless the deployment flag is on
 * AND the capture is labelled synthetic with provenance — the two conditions are
 * independent and both are required.
 */
export function accessAcousticDelta(capture: AccessAcousticCapture | undefined): number | undefined {
  if (!capture) return undefined;
  if (!accessAcousticEnabled()) return undefined;
  if (!capture.provenance || capture.synthetic !== true) return undefined;
  const n = Math.min(capture.features.length, capture.baselineFeatures.length, 8);
  if (!n) return undefined;
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const b = capture.baselineFeatures[i] ?? 0;
    const c = capture.features[i] ?? 0;
    acc += b === 0 ? 0 : Math.abs((c - b) / b);
  }
  return Math.round((acc / n) * 1000) / 1000;
}

const difficultyCode = (value: string | undefined): number => (value === 'difficult' ? 2 : value === 'moderate' ? 1 : 0);
const accessTypeCode = (value: string | undefined): number => (value === 'avg' ? 1 : value === 'catheter' ? 2 : 0);

export function buildAccessVector(input: AccessGuardInput & { acousticDeltaScore?: number | undefined }): number[] {
  return [
    input.venousPressureDeltaPct ?? 0,
    input.recirculationPct ?? 0,
    // flow decline is positive-signed in the vector (higher = worse)
    -(input.accessFlowMlMin !== undefined && input.accessFlowBaselineMlMin
      ? Math.round(((input.accessFlowMlMin - input.accessFlowBaselineMlMin) / Math.abs(input.accessFlowBaselineMlMin)) * 1000) / 10
      : 0),
    input.venousPressureMmHg ?? 150,
    -(input.deliveredClearancePct !== undefined && input.deliveredClearanceBaselinePct
      ? Math.round(((input.deliveredClearancePct - input.deliveredClearanceBaselinePct) / Math.abs(input.deliveredClearanceBaselinePct)) * 1000) / 10
      : 0),
    input.accessAgeDays ?? 400,
    difficultyCode(input.cannulationDifficulty),
    accessTypeCode(input.accessType),
    input.priorInterventions ?? 0,
    input.daysSinceIntervention ?? 365,
    input.acousticDeltaScore ?? 0,
  ];
}

export interface AccessArtifact {
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
    /** the mechanistic prior scored on the same held-out observations */
    priorAuroc?: number | undefined;
    priorBrier?: number | undefined;
    /** logistic baseline (Δ-only) AUROC */
    baselineAuroc?: number | undefined;
    /** the same head restricted to the longitudinal path (audio slot zeroed) */
    longitudinalOnlyAuroc?: number | undefined;
    positives: number;
    negatives: number;
    reliabilitySlope?: number | undefined;
  };
  reliability: ReliabilityBin[];
  /** provenance of the acoustic slot in the training data */
  acoustic: { flag: string; enabledAtTrainTime: boolean; captures: number; synthetic: true; note: string };
  modelCardNote: string;
  synthetic: true;
}

export interface AccessTrainingRow { patientId: string; features: number[]; label: 0 | 1; priorRisk: number }

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
 * Synthetic surveillance cohorts. Each patient has a baseline pressure/flow and
 * a progression slope; ~25% of AVFs/GrAFs are "stenosing" (steeper slope), and
 * the outcome is drawn from the documented mechanism plus structure the prior
 * cannot express. Catheter accesses are included so the type interaction is
 * learnable.
 */
export function buildAccessTrainingRows(opts: { patients?: number; observationsPerPatient?: number; seed?: number } = {}): AccessTrainingRow[] {
  const patients = opts.patients ?? 150;
  const observationsPerPatient = opts.observationsPerPatient ?? 12;
  const rows: AccessTrainingRow[] = [];
  for (let p = 0; p < patients; p += 1) {
    const rng = mulberry32((opts.seed ?? 11) * 7919 + p * 104729);
    const patientId = `access-train-pt-${String(p + 1).padStart(4, '0')}`;
    const typeRoll = rng();
    const accessType: 'avf' | 'avg' | 'catheter' = typeRoll < 0.7 ? 'avf' : typeRoll < 0.88 ? 'avg' : 'catheter';
    const accessAgeDays = Math.round(60 + rng() * 1_400);
    const stenosing = accessType !== 'catheter' && rng() < 0.3;
    const basePressure = 130 + rng() * 25;
    const baseFlow = accessType === 'catheter' ? 420 + rng() * 90 : 900 + rng() * 180;
    const slopePerObservation = stenosing ? 0.055 + rng() * 0.05 : 0.004 + rng() * 0.008;
    const priorInterventions = rng() < 0.3 ? 1 + Math.floor(rng() * 3) : 0;
    const cannulationInjury = rng() < 0.2;
    for (let s = 0; s < observationsPerPatient; s += 1) {
      const progression = slopePerObservation * s;
      const venousPressureDeltaPct = Math.round((progression * 100 + (rng() - 0.5) * 4) * 10) / 10;
      const venousPressureMmHg = Math.round(basePressure * (1 + venousPressureDeltaPct / 100));
      const recirculationPct = Math.round(((accessType === 'catheter' ? 11 : 3.5) + progression * (accessType === 'catheter' ? 40 : 60) + rng() * 2) * 10) / 10;
      const accessFlowMlMin = Math.round(baseFlow * (1 - progression * (stenosing ? 1.6 : 0.4)) + (rng() - 0.5) * 30);
      const deliveredClearanceDeltaPct = -(Math.round(progression * (stenosing ? 40 : 10) * 10) / 10);
      const input: AccessGuardInput = {
        accessType,
        accessAgeDays,
        observations: s + 1,
        venousPressureMmHg,
        venousPressureBaselineMmHg: Math.round(basePressure),
        venousPressureDeltaPct,
        recirculationPct,
        accessFlowMlMin,
        accessFlowBaselineMlMin: Math.round(baseFlow),
        deliveredClearancePct: 100 + deliveredClearanceDeltaPct,
        deliveredClearanceBaselinePct: 100,
        cannulationDifficulty: progression > 0.35 || cannulationInjury ? 'difficult' : progression > 0.15 ? 'moderate' : 'easy',
        priorInterventions,
        daysSinceIntervention: priorInterventions ? Math.round(30 + rng() * 300) : 365,
      };
      const priorRisk = stenosisProbability(input);
      // Generative truth: the prior's shape PLUS interaction structure it cannot
      // express — a clearance decline the prior does not use at all, plus
      // catheter × recirculation, age × pressure rise and cannulation injury ×
      // progression. Trees can capture these; the additive prior cannot.
      const z =
        -2.6
        + 0.085 * Math.max(0, venousPressureDeltaPct - 6)
        + 0.16 * Math.max(0, recirculationPct - 4)
        + 0.09 * Math.max(0, -deliveredClearanceDeltaPct - 3)
        + 0.045 * Math.max(0, -(accessFlowMlMin - (input.accessFlowBaselineMlMin ?? 900)) / 10)
        + 0.85 * (accessType === 'catheter' ? 0 : 1) * (recirculationPct > 12 ? 1 : 0)
        + 0.9 * (accessAgeDays > 900 ? 1 : 0) * (venousPressureDeltaPct > 20 ? 1 : 0)
        + 0.8 * (cannulationInjury ? 1 : 0) * (progression > 0.25 ? 1 : 0)
        + 0.35 * priorInterventions
        + (rng() - 0.5) * 0.35;
      const probability = 1 / (1 + Math.exp(-z));
      rows.push({
        patientId,
        features: buildAccessVector(input),
        label: rng() < probability ? 1 : 0,
        priorRisk,
      });
    }
  }
  return rows;
}

export function trainAccessArtifact(rows: readonly AccessTrainingRow[], opts: { salt?: string; trainFraction?: number } = {}): AccessArtifact {
  const split = patientLevelSplit([...new Set(rows.map((r) => r.patientId))], {
    salt: opts.salt ?? 'access-v1',
    trainFraction: opts.trainFraction ?? 0.75,
  });
  const { train, test } = filterByPatientSplit(rows, split);
  if (!train.length || !test.length) throw new Error('access-split-empty');

  const samples = train.map((r) => ({ features: r.features, target: r.label as number }));
  const model = fitGbt(samples, ACCESS_MODEL_FEATURES, { trees: 70, maxDepth: 3, learningRate: 0.13, minSamplesLeaf: 10, subsample: 0.9, maxThresholds: 20 })!;
  // Ablation: the same booster with the acoustic slot zeroed — the number we
  // actually claim (longitudinal-only), the audio path being gated.
  const longitudinalIndex = ACCESS_MODEL_FEATURES.indexOf('acousticDeltaScore');
  const longitudinalOnly = test.map((r) => {
    const features = [...r.features];
    features[longitudinalIndex] = 0;
    return { score: Math.min(1, Math.max(0, predictGbt(model, features))), label: r.label };
  });
  const predicted = test.map((r) => ({ score: Math.min(1, Math.max(0, predictGbt(model, r.features))), label: r.label }));
  const priorPairs = test.map((r) => ({ score: r.priorRisk, label: r.label }));
  const longitudinalFeatures = [...ACCESS_MODEL_FEATURES.slice(0, longitudinalIndex)];
  const baselineModel = fitLogistic(
    train.map((r) => ({ features: [...r.features.slice(0, longitudinalIndex)], label: r.label })),
    longitudinalFeatures,
  );
  const baselinePairs = baselineModel
    ? test.map((r) => ({ score: predictLogistic(baselineModel, [...r.features.slice(0, longitudinalIndex)]), label: r.label }))
    : [];
  const bins = reliabilityBins(predicted, 5);
  const positives = predicted.filter((p) => p.label === 1).length;
  const negatives = predicted.length - positives;
  const slope = reliabilitySlope(predicted);

  return {
    id: ACCESS_ARTIFACT_ID,
    version: '1.0.0',
    kind: 'gbdt-regression',
    trainedAt: new Date().toISOString(),
    rows: rows.length,
    patients: new Set(rows.map((r) => r.patientId)).size,
    model,
    modelCard: {
      ...gbtModelCard(model, { featureNames: [...ACCESS_MODEL_FEATURES] }),
      synthetic: true,
      cohort: 'synthetic longitudinal access surveillance',
      referenceArchitecture: 'mel-spectrogram CNN (ResNet50 / EfficientNetB5) + patient-relative change detector + multimodal fusion — published benchmarks AUROC 0.99 / 0.98, NOT results of this system',
      servedPath: 'longitudinal pressure/flow/recirculation Δ-from-baseline head (audio slot gated and zeroed unless enabled)',
      validation: validateGbtModel(model),
    },
    metrics: {
      ...(auroc(predicted) ? { auroc: auroc(predicted)!.auroc } : {}),
      ...(brier(predicted) !== undefined ? { brier: brier(predicted) } : {}),
      ...(ece(predicted) !== undefined ? { ece: ece(predicted) } : {}),
      ...(auroc(priorPairs) ? { priorAuroc: auroc(priorPairs)!.auroc } : {}),
      ...(brier(priorPairs) !== undefined ? { priorBrier: brier(priorPairs) } : {}),
      ...(auroc(baselinePairs) ? { baselineAuroc: auroc(baselinePairs)!.auroc } : {}),
      ...(auroc(longitudinalOnly) ? { longitudinalOnlyAuroc: auroc(longitudinalOnly)!.auroc } : {}),
      positives,
      negatives,
      ...(slope !== undefined ? { reliabilitySlope: slope } : {}),
    },
    reliability: bins,
    acoustic: {
      flag: ACCESS_ACOUSTIC_FLAG,
      enabledAtTrainTime: accessAcousticEnabled(),
      captures: 0,
      synthetic: true,
      note: 'No acoustic captures were used: the served artifact is longitudinal-only. Synthetic mel-band captures exist on the ledger (access.acoustic.v1) and are ignored unless the flag is enabled with provenance.',
    },
    modelCardNote: 'Synthetic-cohort evidence only. Longitudinal-only acceptance target: AUROC ≥ 0.80 with a patient-level split; the audio path stays gated until real (consented, provenance-carrying) data exists.',
    synthetic: true,
  };
}

export function saveAccessArtifact(artifact: AccessArtifact, path = ACCESS_ARTIFACT_PATH): string {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

export function loadAccessArtifact(path = ACCESS_ARTIFACT_PATH): AccessArtifact | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as AccessArtifact;
  } catch {
    return undefined;
  }
}

export function accessArtifactStatus(path = ACCESS_ARTIFACT_PATH): {
  present: boolean;
  id?: string | undefined;
  version?: string | undefined;
  trainedAt?: string | undefined;
  rows?: number | undefined;
  patients?: number | undefined;
  metrics?: AccessArtifact['metrics'] | undefined;
  attribution?: ReturnType<typeof gbtAttribution> | undefined;
  acoustic?: AccessArtifact['acoustic'] | undefined;
  /** acceptance verdict: longitudinal-only AUROC ≥ 0.80 (strategy §2.4) */
  meetsLongitudinalTarget: boolean;
  beatsPriorDiscrimination: boolean;
  band: 'pass' | 'watch' | 'insufficient';
  note: string;
} {
  const artifact = loadAccessArtifact(path);
  if (!artifact) {
    return {
      present: false,
      meetsLongitudinalTarget: false,
      beatsPriorDiscrimination: false,
      band: 'insufficient',
      note: 'No artifact — the mechanistic stenosis prior serves recommendations.',
    };
  }
  const longitudinal = artifact.metrics.longitudinalOnlyAuroc ?? artifact.metrics.auroc ?? 0;
  const priorAuroc = artifact.metrics.priorAuroc ?? 1;
  const meetsLongitudinalTarget = longitudinal >= 0.8;
  const beatsPriorDiscrimination = longitudinal > priorAuroc;
  const band = meetsLongitudinalTarget && beatsPriorDiscrimination ? 'pass' : meetsLongitudinalTarget ? 'watch' : 'insufficient';
  return {
    present: true,
    id: artifact.id,
    version: artifact.version,
    trainedAt: artifact.trainedAt,
    rows: artifact.rows,
    patients: artifact.patients,
    metrics: artifact.metrics,
    attribution: gbtAttribution(artifact.model, 6),
    acoustic: artifact.acoustic,
    meetsLongitudinalTarget,
    beatsPriorDiscrimination,
    band,
    note: beatsPriorDiscrimination
      ? `Longitudinal-only AUROC ${longitudinal} beats the mechanistic prior (${priorAuroc}) — the learned Δ-from-baseline head serves recommendations.`
      : `Longitudinal-only AUROC ${longitudinal} does not beat the mechanistic prior (${priorAuroc}); the prior serves the recommendation and the head is retained for the real-data path. Recorded, not hidden.`,
  };
}

/** Trained advisor: the head's probability, with the prior retained as the floor. */
export function accessRecommendTrained(
  input: AccessGuardInput & { patientId: string; acousticDeltaScore?: number | undefined },
  opts: { path?: string } = {},
): { trained: { artifactId: string; priorRisk: number; headRisk: number; ranker: 'head' | 'prior'; longitudinalOnly: number } } {
  const artifact = loadAccessArtifact(opts.path ?? ACCESS_ARTIFACT_PATH);
  const priorRisk = stenosisProbability(input);
  if (!artifact) return { trained: { artifactId: ACCESS_ARTIFACT_ID, priorRisk, headRisk: priorRisk, ranker: 'prior', longitudinalOnly: priorRisk } };
  const headRisk = Math.min(0.99, Math.max(0.005, Math.round(predictGbt(artifact.model, buildAccessVector(input)) * 1000) / 1000));
  const ranker: 'head' | 'prior' = artifact.metrics.longitudinalOnlyAuroc !== undefined && artifact.metrics.longitudinalOnlyAuroc > (artifact.metrics.priorAuroc ?? 1) ? 'head' : 'prior';
  return {
    trained: {
      artifactId: ACCESS_ARTIFACT_ID,
      priorRisk,
      headRisk,
      ranker,
      longitudinalOnly: artifact.metrics.longitudinalOnlyAuroc ?? 0,
    },
  };
}

export { ACCESS_FEATURES };
