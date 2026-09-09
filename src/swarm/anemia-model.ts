/******************************************************************************
 * Anemia / ESA trained-model loader + serve — P2.
 *
 * Loads the exported weight artifact produced by anemia-train/train.py (a
 * contractive autoencoder + latent dose regressor, trained on the synthetic
 * cohort) and serves a recommendation under the SAME EsaRecommendation contract
 * as the P0/P1 reference surrogate — guardrails + coverage gate still apply, so
 * swapping the model never bypasses governance.
 *
 * NO TRAIN/SERVE DRIFT: the artifact self-describes its feature vector layout
 * and its per-feature domain bounds; this module builds the vector from a window
 * exactly as the trainer did (see tests/anemia-trained.test.ts golden parity).
 *
 * The trainer is Python-only and offline. This module (and every test) reads the
 * committed JSON artifact — vitest/CI never needs Python.
 ******************************************************************************/

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESA_DOSE_STEP, ESA_FEATURES, guardDose, type EsaPatientWindow, type EsaRecommendation } from './anemia.js';
import { esaCoverage, type EsaCoverageVerdict } from './anemia-governance.js';

export const ESA_TRAINED_ARTIFACT_PATH = 'anemia-train/artifacts/anemia.esa-dose-v1.json';
export const ESA_TRAINED_MAX_DOSE = 20000;
export const ESA_TRAINED_LEAKY = 0.3;

/* ------------------------------------------------------------------ *
 * Artifact + catalog types (mirror anemia-train/feature_catalog.json)
 * ------------------------------------------------------------------ */

export interface EsaCatalogFeature {
  id: string;
  label: string;
  loinc?: string;
  unit: string;
  min: number;
  max: number;
  relevance?: number;
}

export interface EsaVectorLayoutEntry {
  kind: 'hgb-week' | 'feature' | 'indicator';
  count?: number;
  feature?: string;
  id?: string;
}

export interface EsaLayerWeights { w: number[][]; b: number[] }

export interface EsaTrainedArtifact {
  format: string;
  model: { id: string; version: string; kind: 'trained' };
  featureCatalog: {
    hgbTarget: { min: number; max: number };
    doseStep: number;
    features: EsaCatalogFeature[];
    vector: { inputDim: number; layout: EsaVectorLayoutEntry[]; normalize: string };
  };
  /** Top-level vector spec mirror (also embedded in featureCatalog). */
  vector: { inputDim: number; layout: EsaVectorLayoutEntry[] };
  architecture: { encoder: number[]; decoder: number[]; regressor: number[]; activation: string; contractive: boolean };
  weights: { encoder: EsaLayerWeights[]; regressor: EsaLayerWeights[] };
  relevance: Array<{ id: string; relevance: number }>;
  golden: { window: Record<string, unknown>; vector: number[]; prediction: number };
  metrics: { trainMae: number; testMae: number; baselineMae: number; pearson: number; nTrain: number; nTest: number; seed: number };
  synthetic: boolean;
}

let cachedArtifact: EsaTrainedArtifact | null | undefined;

/** Load the committed trained artifact (cached). Returns null when absent. */
export function loadEsaArtifact(path: string = ESA_TRAINED_ARTIFACT_PATH): EsaTrainedArtifact | null {
  if (cachedArtifact !== undefined) return cachedArtifact;
  try {
    cachedArtifact = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as EsaTrainedArtifact;
  } catch {
    cachedArtifact = null;
  }
  return cachedArtifact;
}

/* ------------------------------------------------------------------ *
 * Vector builder — MUST mirror anemia-train/train.py build_vector()
 * ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const normDomain = (v: number, lo: number, hi: number): number =>
  clamp(((v - lo) / (hi - lo)) * 2 - 1, -1, 1);

function hgbWeeks(trend: readonly number[], currentHgb: number): number[] {
  const t = trend.length ? [...trend] : [currentHgb];
  const last = t[t.length - 1];
  if (last !== currentHgb) t.push(currentHgb);
  if (t.length > 12) t.splice(0, t.length - 12);
  while (t.length < 12) t.unshift(t[0] ?? currentHgb);
  return t.slice(0, 12);
}

export interface EsaVectorWindow {
  currentHgb: number;
  hgbTrendLast90d?: readonly number[];
  mcv?: number;
  ferritin?: number;
  transferrinSat?: number;
  crp?: number;
  calcium?: number;
  pth?: number;
  onESA: boolean;
  currentDose: number;
}

/** Build the fixed artifact-defined vector from a window. Order + normalization
 *  come from the artifact layout/catalog (mirrors the Python trainer). */
export function buildEsaVector(window: EsaVectorWindow, catalog: EsaTrainedArtifact['featureCatalog']): number[] {
  const feat = new Map<string, EsaCatalogFeature>(catalog.features.map((f) => [f.id, f]));
  const hgb = feat.get('hgb');
  const vals: number[] = [];
  for (const layout of catalog.vector.layout) {
    if (layout.kind === 'hgb-week') {
      const count = layout.count ?? 12;
      const weeks = hgbWeeks(window.hgbTrendLast90d ?? [], window.currentHgb);
      for (let k = 0; k < count; k++) {
        const v = weeks[k] ?? window.currentHgb;
        vals.push(hgb ? normDomain(v, hgb.min, hgb.max) : 0);
      }
    } else if (layout.kind === 'feature') {
      const id = layout.id ?? '';
      const f = feat.get(id);
      const raw = id === 'priorEpo' ? window.currentDose : (window as unknown as Record<string, number | undefined>)[id];
      const value = typeof raw === 'number' ? raw : 0;
      vals.push(f ? normDomain(value, f.min, f.max) : 0);
    } else if (layout.kind === 'indicator') {
      vals.push(window.onESA ? 1 : 0);
    }
  }
  return vals;
}

/* ------------------------------------------------------------------ *
 * Forward pass (leaky ReLU 0.3 MLP) — mirrors anemia-train/train.py
 * ------------------------------------------------------------------ */

function leakyRelu(x: number): number {
  return x > 0 ? x : ESA_TRAINED_LEAKY * x;
}

function matvec(w: number[][], b: number[], x: number[]): number[] {
  const out: number[] = new Array(w.length).fill(0);
  for (let r = 0; r < w.length; r++) {
    const row = w[r];
    if (!row) continue;
    let acc = b[r] ?? 0;
    for (let c = 0; c < x.length; c++) {
      acc += (row[c] ?? 0) * (x[c] ?? 0);
    }
    out[r] = acc;
  }
  return out;
}

function forwardLayers(layers: EsaLayerWeights[], x: number[], activate: boolean): number[] {
  let h = x;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i] ?? { w: [], b: [] };
    h = matvec(layer.w, layer.b, h);
    const isLast = i === layers.length - 1;
    if (activate && !isLast) h = h.map(leakyRelu);
    if (!activate && i < layers.length - 1) h = h.map(leakyRelu);
  }
  return h;
}

/** Encoder forward → 2-D latent (bounded by tanh, mirroring the trainer). */
export function encodeLatent(artifact: EsaTrainedArtifact, vector: number[]): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  const pre = forwardLayers(artifact.weights.encoder, vector, true);
  const l1 = Math.tanh(pre[0] ?? 0);
  const l2 = Math.tanh(pre[1] ?? 0);
  return { l1, l2, polarRadius: Math.hypot(l1, l2), polarAngleRad: Math.atan2(l2, l1) };
}

/** Dose prediction in units/wk: RN(z)*1000 clamped to [0, ESA_TRAINED_MAX_DOSE]. */
export function predictEsaDoseUnits(artifact: EsaTrainedArtifact, window: EsaVectorWindow): number {
  const vector = buildEsaVector(window, artifact.featureCatalog);
  const zRaw = forwardLayers(artifact.weights.encoder, vector, true);
  const z = [Math.tanh(zRaw[0] ?? 0), Math.tanh(zRaw[1] ?? 0)];
  const doseK = forwardLayers(artifact.weights.regressor, z, true)[0] ?? 0;
  return clamp(doseK * 1000, 0, ESA_TRAINED_MAX_DOSE);
}

export const roundEsaStep = (dose: number): number => Math.max(0, Math.round(dose / ESA_DOSE_STEP) * ESA_DOSE_STEP);

/* ------------------------------------------------------------------ *
 * Serve — same EsaRecommendation contract as the reference surrogate
 * ------------------------------------------------------------------ */

/** Trained-model recommendation. Guardrails + coverage gate apply exactly as in
 *  the reference path; only the dose itself comes from the trained latent model.
 */
export function esaRecommendTrained(
  window: EsaPatientWindow,
  artifact: EsaTrainedArtifact,
): EsaRecommendation & { coverage: EsaCoverageVerdict } {
  const guardrails = guardDose(window);
  const coverage = esaCoverage(window);
  const latent = encodeLatent(artifact, buildEsaVector(window, artifact.featureCatalog));
  const model: EsaRecommendation['model'] = { id: artifact.model.id, version: artifact.model.version, kind: artifact.model.kind };
  const inTargetBand = window.currentHgb >= 10 && window.currentHgb <= 12;
  const currentDose = Math.max(0, window.currentDose);
  const drivers = artifact.relevance
    .map((r) => ({ id: r.id, label: ESA_FEATURES.find((f) => f.id === r.id)?.label ?? r.id, relevance: r.relevance }))
    .sort((a, b) => b.relevance - a.relevance);

  const base: EsaRecommendation & { coverage: EsaCoverageVerdict } = {
    patientId: window.patientId,
    inTargetBand,
    guardrails,
    latent,
    currentDose,
    recommendedDose: null,
    delta: 0,
    direction: 'blocked',
    drivers,
    model,
    synthetic: true,
    note: 'Trained latent model blocked this window.',
    coverage,
  };

  if (guardrails.blocked) {
    base.note = guardrails.blockReason ?? base.note;
    return base;
  }
  if (!coverage.covered) {
    base.note = coverage.reason ?? base.note;
    return base;
  }

  const predicted = roundEsaStep(predictEsaDoseUnits(artifact, window));
  if (predicted > currentDose + ESA_DOSE_STEP / 2) {
    return { ...base, direction: 'increase', recommendedDose: predicted, delta: predicted - currentDose, note: `Trained latent model projects ${predicted.toLocaleString()} u/wk (current ${currentDose.toLocaleString()}). Class C review required.` };
  }
  if (predicted < currentDose - ESA_DOSE_STEP / 2) {
    if (predicted <= 0) {
      return { ...base, direction: 'suspend', recommendedDose: 0, delta: -currentDose, note: 'Trained latent model projects a suspension (0 u/wk).' };
    }
    return { ...base, direction: 'reduce', recommendedDose: predicted, delta: predicted - currentDose, note: `Trained latent model projects ${predicted.toLocaleString()} u/wk (current ${currentDose.toLocaleString()}).` };
  }
  return { ...base, direction: 'hold', recommendedDose: currentDose, delta: 0, note: `Trained latent model holds at ${currentDose.toLocaleString()} u/wk (current window in band).` };
}
