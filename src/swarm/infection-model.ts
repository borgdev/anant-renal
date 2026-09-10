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

// P6 step E — the trained BSI triage head.
//
// WHAT IS TRAINED, AND WHAT IS DELIBERATELY NOT:
//
//   • Trained: a GBDT classifier for "this culture grew an organism", over the
//     triage feature contract. Acceptance is AUC ≥ 0.85 on synthetic held-out
//     data, and it must BEAT the temperature-rule prior (the graded CDC/NHSN
//     criteria score) on the same held-out rows. The generator's truth is a
//     DOCUMENTED LOGISTIC RISK with interactions (catheter × fever,
//     procalcitonin × NLR) — a generator dominated by Bernoulli noise would make
//     the acceptance meaningless.
//
//   • NOT trained, ever: the prevention half. Vaccination due-dates, series
//     completion, serology follow-up, audit cadence and catheter-day escalation
//     are deterministic rules over records. No model output may reach them, the
//     model card records that explicitly, and the governance gate proves it.

import { fitGbt, predictGbt, gbtModelCard, gbtAttribution, type GbtModel } from '../protocols/gbdt.js';
import { auroc, brier, ece, reliabilityBins, type ReliabilityBin } from '../protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit } from '../protocols/split.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { INFECTION_FEATURES, INFECTION_REFERENCE, assessBsi, computeNlr, type InfectionInput } from './infection.js';

export const INFECTION_ARTIFACT_ID = 'infection.bsi-v1';
export const INFECTION_ARTIFACT_PATH = 'infection-train/artifacts/infection.bsi-v1.json';
export const INFECTION_MODEL_TARGET_AUROC = 0.85;

/** The feature vector of the trained head — the triage contract, plus the two interactions. */
export const INFECTION_MODEL_FEATURES = [
  'temperatureC',
  'temperatureDeltaC',
  'procalcitoninNgMl',
  'nlr',
  'wbc',
  'crp',
  'albumin',
  'catheterDays',
  'catheterInSitu',
  'accessInfectionSigns',
  'symptomCount',
  'hospitalisedLast30d',
  'dialysisVintageYears',
  'age',
  'catheterXFever',
  'pctXNlr',
] as const;

export interface InfectionTrainingRow {
  patientId: string;
  features: number[];
  /** culture-positive label (the classifier target) */
  label: 0 | 1;
  /** the graded temperature-rule prior's score (the baseline to beat) */
  priorScore: number;
  /** the interaction structure that actually generated the label (for the audit) */
  generator: string;
}

export interface InfectionArtifact {
  id: string;
  version: string;
  kind: 'gbdt-classifier';
  trainedAt: string;
  rows: number;
  patients: number;
  classifier: {
    model: GbtModel;
    metrics: { auroc: number; brier: number; ece: number; positives: number; negatives: number };
    /** the temperature-rule prior scored on the same held-out rows */
    priorAuroc: number;
    /** how much the learned head adds over the rule */
    aurocGain: number;
  };
  reliability: ReliabilityBin[];
  /** attribution from a booster trained on each generator family */
  generatorAttribution: Record<string, Array<{ feature: string; gain: number; share: number }>>;
  generatorAudit: Array<{ generator: string; rows: number; observedRate: number; meanScore: number }>;
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

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The temperature-rule prior: the graded CDC/NHSN criteria count, normalised.
 * This is exactly what a rule-only surveillance system can do, so it is the
 * honest baseline the learned head has to beat.
 */
export function temperatureRuleScore(input: InfectionInput): number {
  const series = input.temperatureSeries ?? (input.temperatureC !== undefined ? [input.temperatureC] : []);
  const peak = series.length ? Math.max(...series) : undefined;
  const R = INFECTION_REFERENCE;
  let score = 0;
  if (peak !== undefined) {
    if (peak >= R.feverC) score += 0.5;
    else if (peak >= R.lowGradeFeverC) score += 0.2;
  }
  if (input.accessType === 'catheter' && (peak ?? 0) >= R.lowGradeFeverC) score += 0.2;
  if (input.accessInfectionSigns === true) score += 0.15;
  const symptoms = input.symptoms?.length ?? 0;
  if (symptoms > 0) score += Math.min(0.15, symptoms * 0.06);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export function buildInfectionVector(
  input: InfectionInput,
  extra: { temperatureDeltaC?: number; age?: number; symptomCount?: number } = {},
): number[] {
  const series = input.temperatureSeries ?? (input.temperatureC !== undefined ? [input.temperatureC] : []);
  const latest = input.temperatureC ?? series.at(-1) ?? 36.8;
  const delta = extra.temperatureDeltaC ?? (series.length >= 2 ? latest - Math.min(...series.slice(0, -1)) : 0);
  const nlr = input.nlr ?? computeNlr(input.neutrophilPct, input.lymphocytePct) ?? 2.5;
  const catheter = input.accessType === 'catheter' ? 1 : 0;
  const pct = input.procalcitoninNgMl ?? 0.1;
  return [
    latest,
    delta,
    pct,
    nlr,
    input.wbc ?? 7,
    input.crp ?? 5,
    input.albumin ?? 3.7,
    input.catheterDays ?? 0,
    catheter,
    input.accessInfectionSigns === true ? 1 : 0,
    extra.symptomCount ?? input.symptoms?.length ?? 0,
    input.hospitalisedLast30d === true ? 1 : 0,
    input.dialysisVintageYears ?? 3,
    extra.age ?? 64,
    catheter * Math.max(0, latest - INFECTION_REFERENCE.lowGradeFeverC),
    pct * nlr / 10,
  ];
}

/**
 * Synthetic infection cohorts with a KNOWN generator family, so the artifact can
 * be audited against the structure that produced the label. The truth is a
 * documented logistic risk over the same features plus the two interactions a
 * tree model can find and a temperature rule cannot: catheter × fever and
 * procalcitonin × NLR.
 */
export function buildInfectionTrainingRows(opts: { patients?: number; observationsPerPatient?: number; seed?: number } = {}): InfectionTrainingRow[] {
  const patients = opts.patients ?? 300;
  const observationsPerPatient = opts.observationsPerPatient ?? 7;
  const rows: InfectionTrainingRow[] = [];
  for (let p = 0; p < patients; p += 1) {
    const rng = mulberry32((opts.seed ?? 29) * 6151 + p * 104729);
    const patientId = `infection-train-pt-${String(p + 1).padStart(4, '0')}`;
    const age = Math.round(34 + rng() * 56);
    const vintage = Math.round(rng() * 12 * 10) / 10;
    const catheterPatient = rng() < 0.38;
    const catheterStart = Math.round(rng() * 260);
    const hospitalised = rng() < 0.22;
    const generatorRoll = rng();
    const generator = generatorRoll < 0.3 ? 'catheter-fever' : generatorRoll < 0.55 ? 'marker-dominant' : generatorRoll < 0.75 ? 'access-site' : generatorRoll < 0.9 ? 'low-grade-afebrile' : 'culture-negative-mimic';
    for (let s = 0; s < observationsPerPatient; s += 1) {
      const drift = s / observationsPerPatient;
      const catheterInSitu = catheterPatient && drift < 0.85;
      const catheterDays = catheterInSitu ? catheterStart + Math.round(drift * 120) : 0;
      const accessType: InfectionInput['accessType'] = catheterInSitu ? 'catheter' : rng() < 0.6 ? 'avf' : 'avg';

      // generator families drive the physiology, and ONLY the physiology —
      // the label is then a function of the physiology, so the model has real
      // structure to learn instead of noise to memorise
      const feverPresent = generator === 'low-grade-afebrile' ? rng() < 0.25 : generator === 'culture-negative-mimic' ? rng() < 0.15 : rng() < 0.6;
      const baseTemp = feverPresent ? 38.4 + rng() * 1.1 : 36.5 + rng() * 1.2;
      const temperatureC = round2(baseTemp - (generator === 'culture-negative-mimic' ? 0.3 : 0));
      const temperatureSeries = [round2(temperatureC - rng() * 0.8), round2(temperatureC - rng() * 0.4), temperatureC];
      const procalcitoninNgMl = round2(Math.max(0.05, generator === 'marker-dominant' ? 2.5 + rng() * 9 : generator === 'catheter-fever' ? 0.6 + rng() * 3.4 : 0.1 + rng() * 0.8));
      const neutrophilPct = Math.round(generator === 'marker-dominant' ? 74 + rng() * 18 : generator === 'catheter-fever' ? 66 + rng() * 14 : 56 + rng() * 14);
      const lymphocytePct = Math.round(generator === 'marker-dominant' ? 9 + rng() * 8 : 18 + rng() * 12);
      const wbc = round2(Math.max(2, generator === 'marker-dominant' ? 10 + rng() * 10 : 6 + rng() * 4));
      const crp = round2(Math.max(0.4, generator === 'marker-dominant' ? 20 + rng() * 45 : 4 + rng() * 18));
      const albumin = round2(Math.max(2.1, (generator === 'marker-dominant' ? 3.2 : 3.7) - rng() * 0.5));
      const accessInfectionSigns = generator === 'access-site' ? rng() < 0.85 : rng() < 0.12;
      const symptomCountVal = generator === 'catheter-fever' ? 1 + Math.floor(rng() * 3) : rng() < 0.25 ? 1 : 0;
      const symptoms = Array.from({ length: symptomCountVal }, (_, i) => ['rigors', 'hypotension', 'confusion'][i % 3]!);
      const nlr = Math.round((neutrophilPct / lymphocytePct) * 100) / 100;

      const input: InfectionInput = {
        patientId,
        temperatureC,
        temperatureSeries,
        procalcitoninNgMl,
        neutrophilPct,
        lymphocytePct,
        wbc,
        crp,
        albumin,
        accessType,
        catheterDays,
        accessInfectionSigns,
        symptoms,
        hospitalisedLast30d: hospitalised,
        dialysisVintageYears: vintage,
      };

      // DOCUMENTED LOGISTIC RISK on the feature set, including the interactions.
      const zPlt = (procalcitoninNgMl - 0.6) / 1.8;              // per 1.8 ng/mL above 0.6
      const zNlr = (nlr - 4) / 4;                                 // per 4 units above 4
      const zTemp = (temperatureC - 37.2) / 0.9;                  // per 0.9 °C above 37.2
      const zCat = catheterInSitu ? Math.min(1.6, catheterDays / 150) : 0;
      const zSigns = accessInfectionSigns ? 1 : 0;
      const zSym = Math.min(1.6, symptomCountVal * 0.7);
      const zWbc = (wbc - 8) / 5;
      const zCrp = (crp - 10) / 25;
      const zAlb = (3.6 - albumin) / 0.5;
      const zHosp = hospitalised ? 0.8 : 0;
      const zVintage = (vintage - 4) / 6;
      const zRisk = -2.75
        + 1.30 * zPlt
        + 1.05 * zNlr
        + 1.15 * zTemp
        + 0.85 * zCat
        + 1.00 * zSigns
        + 0.85 * zSym
        + 0.45 * zWbc
        + 0.40 * zCrp
        + 0.35 * zAlb
        + 0.35 * zHosp
        + 0.25 * zVintage
        // the two interactions a rule cannot express
        + 0.95 * zCat * Math.max(0, zTemp)
        + 0.55 * Math.max(0, zPlt) * Math.max(0, zNlr);
      const probability = 1 / (1 + Math.exp(-zRisk));
      const label: 0 | 1 = rng() < probability ? 1 : 0;

      rows.push({
        patientId,
        features: buildInfectionVector(input, {
          age,
          temperatureDeltaC: round2(temperatureC - temperatureSeries[0]!),
          symptomCount: symptomCountVal,
        }),
        label,
        priorScore: temperatureRuleScore(input),
        generator,
      });
    }
  }
  return rows;
}

export function trainInfectionArtifact(rows: readonly InfectionTrainingRow[], opts: { salt?: string; trainFraction?: number } = {}): InfectionArtifact {
  const split = patientLevelSplit([...new Set(rows.map((r) => r.patientId))], {
    salt: opts.salt ?? 'infection-v1',
    trainFraction: opts.trainFraction ?? 0.75,
  });
  const { train, test } = filterByPatientSplit(rows, split);
  if (!train.length || !test.length) throw new Error('infection-split-empty');

  const classifier = fitGbt(
    train.map((r) => ({ features: r.features, target: r.label })),
    INFECTION_MODEL_FEATURES,
    { trees: 110, maxDepth: 4, learningRate: 0.12, minSamplesLeaf: 8, subsample: 0.9, maxThresholds: 28 },
  )!;

  const scored = test.map((r) => ({ score: Math.min(1, Math.max(0, predictGbt(classifier, r.features))), label: r.label }));
  const head = auroc(scored)!;
  const priorHead = auroc(test.map((r) => ({ score: r.priorScore, label: r.label })));

  const generators = [...new Set(rows.map((r) => r.generator))];
  const generatorAttribution: Record<string, Array<{ feature: string; gain: number; share: number }>> = {};
  const generatorAudit: Array<{ generator: string; rows: number; observedRate: number; meanScore: number }> = [];
  for (const generator of generators) {
    const subset = train.filter((r) => r.generator === generator);
    const subsetTest = test.filter((r) => r.generator === generator);
    const model = subset.length >= 60
      ? fitGbt(subset.map((r) => ({ features: r.features, target: r.label })), INFECTION_MODEL_FEATURES, { trees: 70, maxDepth: 4, learningRate: 0.12, minSamplesLeaf: 6, subsample: 0.9, maxThresholds: 24 })
      : undefined;
    generatorAttribution[generator] = gbtAttribution(model ?? classifier, 6);
    const scores = subsetTest.map((r) => Math.min(1, Math.max(0, predictGbt(model ?? classifier, r.features))));
    generatorAudit.push({
      generator,
      rows: subsetTest.length,
      observedRate: subsetTest.length ? Math.round((subsetTest.filter((r) => r.label === 1).length / subsetTest.length) * 1000) / 1000 : 0,
      meanScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : 0,
    });
  }

  return {
    id: INFECTION_ARTIFACT_ID,
    version: '1.0.0',
    kind: 'gbdt-classifier',
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
      aurocGain: Math.round((head.auroc - (priorHead?.auroc ?? 0)) * 10000) / 10000,
    },
    reliability: reliabilityBins(scored, 5),
    generatorAttribution,
    generatorAudit,
    modelCard: {
      features: [...INFECTION_MODEL_FEATURES],
      target: 'blood culture positive (organism grown)',
      interactions: ['catheterDays × temperature', 'procalcitonin × NLR'],
      classifierCard: gbtModelCard(classifier, { featureNames: [...INFECTION_MODEL_FEATURES] }),
      baseline: { name: 'graded CDC/NHSN temperature rule', auroc: priorHead?.auroc ?? 0 },
      // the separation, recorded in the artifact itself
      preventionPath: {
        trained: false,
        kind: 'deterministic-rules',
        modelInputs: 'none',
        note: 'Vaccination due dates, series completion, serology follow-up, audit cadence and catheter-day escalation are rules over records. No model output reaches them.',
      },
      authority: { antimicrobial: 'none', prescribing: 'none', cultureOrder: 'proposal-class-c' },
      synthetic: true,
    },
    benchmarkNote: 'The published dialysis BSI / NHSN surveillance baselines (temperature-based criteria) are the comparison, not a result of this system; our acceptance is AUC ≥ 0.85 on synthetic held-out data while beating the temperature-rule prior on the same rows.',
    synthetic: true,
  };
}

export function saveInfectionArtifact(artifact: InfectionArtifact, path = INFECTION_ARTIFACT_PATH): string {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

export function loadInfectionArtifact(path = INFECTION_ARTIFACT_PATH): InfectionArtifact | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as InfectionArtifact;
  } catch {
    return undefined;
  }
}

export function infectionArtifactStatus(path = INFECTION_ARTIFACT_PATH): {
  present: boolean;
  id?: string | undefined;
  version?: string | undefined;
  trainedAt?: string | undefined;
  rows?: number | undefined;
  patients?: number | undefined;
  classifier?: InfectionArtifact['classifier']['metrics'] | undefined;
  priorAuroc?: number | undefined;
  aurocGain?: number | undefined;
  attribution?: Array<{ feature: string; gain: number; share: number }> | undefined;
  generatorAudit?: InfectionArtifact['generatorAudit'] | undefined;
  meetsTarget: boolean;
  beatsRulePrior: boolean;
  band: 'pass' | 'watch' | 'insufficient';
  note: string;
} {
  const artifact = loadInfectionArtifact(path);
  if (!artifact) {
    return { present: false, meetsTarget: false, beatsRulePrior: false, band: 'insufficient', note: 'No artifact — the graded CDC/NHSN criteria reference model serves the triage.' };
  }
  const meetsTarget = artifact.classifier.metrics.auroc >= INFECTION_MODEL_TARGET_AUROC;
  const beatsRulePrior = artifact.classifier.metrics.auroc > artifact.classifier.priorAuroc;
  return {
    present: true,
    id: artifact.id,
    version: artifact.version,
    trainedAt: artifact.trainedAt,
    rows: artifact.rows,
    patients: artifact.patients,
    classifier: artifact.classifier.metrics,
    priorAuroc: artifact.classifier.priorAuroc,
    aurocGain: artifact.classifier.aurocGain,
    attribution: artifact.generatorAttribution['catheter-fever'],
    generatorAudit: artifact.generatorAudit,
    meetsTarget,
    beatsRulePrior,
    band: meetsTarget && beatsRulePrior ? 'pass' : meetsTarget ? 'watch' : 'insufficient',
    note: meetsTarget && beatsRulePrior
      ? `BSI triage AUROC ${artifact.classifier.metrics.auroc} vs the temperature-rule prior ${artifact.classifier.priorAuroc} (≥ ${INFECTION_MODEL_TARGET_AUROC} target met; gain ${artifact.classifier.aurocGain}). Brier ${artifact.classifier.metrics.brier}, ECE ${artifact.classifier.metrics.ece}.`
      : `BSI triage AUROC ${artifact.classifier.metrics.auroc} (rule prior ${artifact.classifier.priorAuroc}) — below or at the ${INFECTION_MODEL_TARGET_AUROC} / beats-prior bar. The graded criteria reference model serves the triage and the shortfall is recorded rather than hidden.`,
  };
}

/** Trained BSI probability for one window (the classifier head) + its drivers. */
export function infectionTriageTrained(
  input: InfectionInput,
  opts: { path?: string } = {},
): { trained?: { artifactId: string; probability: number; drivers: Array<{ feature: string; gain: number; share: number }>; reference: { probability: number; band: string }; prior: number } } {
  const artifact = loadInfectionArtifact(opts.path ?? INFECTION_ARTIFACT_PATH);
  if (!artifact) return {};
  const probability = Math.min(1, Math.max(0, predictGbt(artifact.classifier.model, buildInfectionVector(input))));
  const reference = assessBsi(input);
  return {
    trained: {
      artifactId: INFECTION_ARTIFACT_ID,
      probability: Math.round(probability * 1000) / 1000,
      drivers: gbtAttribution(artifact.classifier.model, 6),
      reference: { probability: reference.probability, band: reference.band },
      prior: temperatureRuleScore(input),
    },
  };
}

export { INFECTION_FEATURES, INFECTION_REFERENCE };
