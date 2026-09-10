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

// F2 — Tabular baselines a protocol head must beat.
//
// Deliberately dependency-free: ridge-regularized least squares (normal
// equations + Gaussian elimination) and logistic regression (batch gradient
// descent) plus the persistence baseline. These are the honest comparisons the
// implementation strategy prescribes (per-protocol published baselines were
// trees/linear models, not transformers), and they run anywhere the harness does.

import { correlation, forecastMetrics, mae, relativeImprovementPct, round, type ForecastMetrics } from './metrics.js';

export interface LinearModel {
  kind: 'ridge-linear';
  weights: number[];
  intercept: number;
  featureNames: readonly string[];
  /** per-feature means; features are centered on these before applying weights. */
  featureMeans: number[];
  lambda: number;
}

export interface LogisticModel {
  kind: 'logistic';
  weights: number[];
  intercept: number;
  featureNames: readonly string[];
  iterations: number;
  learningRate: number;
}

export interface Sample { features: readonly number[]; target: number }

/** Solve A·x = b with partial-pivot Gaussian elimination (A is n×n, row-major). */
function solveLinearSystem(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    if (Math.abs(a[pivot]![col]!) < 1e-12) return undefined;
    if (pivot !== col) {
      const tmpRow = a[pivot]!; a[pivot] = a[col]!; a[col] = tmpRow;
      const tmpB = b[pivot]!; b[pivot] = b[col]!; b[col] = tmpB;
    }
    const pivotVal = a[col]![col]!;
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row]![col]! / pivotVal;
      if (factor === 0) continue;
      for (let k = col; k < n; k += 1) a[row]![k]! -= factor * a[col]![k]!;
      b[row]! -= factor * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k += 1) sum -= a[row]![k]! * x[k]!;
    x[row] = sum / a[row]![row]!;
  }
  return x;
}

/** Ridge-regularized least squares over mean-centered features (exact intercept = mean target). */
export function fitRidgeLinear(samples: readonly Sample[], featureNames: readonly string[], lambda = 1e-3): LinearModel | undefined {
  if (!samples.length || !featureNames.length) return undefined;
  const d = featureNames.length;
  const n = samples.length;
  const featureMeans = featureNames.map((_, i) => samples.reduce((a, s) => a + (s.features[i] ?? 0), 0) / n);
  const meanTarget = samples.reduce((a, s) => a + s.target, 0) / n;
  const ata: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const atb = new Array<number>(d).fill(0);
  for (const s of samples) {
    for (let i = 0; i < d; i += 1) {
      const xi = (s.features[i] ?? 0) - featureMeans[i]!;
      atb[i]! += xi * (s.target - meanTarget);
      for (let j = 0; j < d; j += 1) ata[i]![j]! += xi * ((s.features[j] ?? 0) - featureMeans[j]!);
    }
  }
  for (let i = 0; i < d; i += 1) ata[i]![i]! += lambda;
  const weights = solveLinearSystem(ata, atb);
  if (!weights) return undefined;
  return {
    kind: 'ridge-linear',
    weights: weights.map((w) => round(w, 8)),
    intercept: round(meanTarget, 8),
    featureNames,
    featureMeans: featureMeans.map((m) => round(m, 8)),
    lambda,
  };
}

export function predictLinear(model: LinearModel, features: readonly number[]): number {
  let y = model.intercept;
  for (let i = 0; i < model.weights.length; i += 1) y += model.weights[i]! * ((features[i] ?? 0) - (model.featureMeans[i] ?? 0));
  return y;
}

export interface LabeledSample { features: readonly number[]; label: 0 | 1 }

/** Batch-gradient logistic regression with L2 penalty (deterministic, no shuffling). */
export function fitLogistic(samples: readonly LabeledSample[], featureNames: readonly string[], opts: { iterations?: number; learningRate?: number; lambda?: number } = {}): LogisticModel | undefined {
  if (!samples.length || !featureNames.length) return undefined;
  const iterations = opts.iterations ?? 400;
  const learningRate = opts.learningRate ?? 0.25;
  const lambda = opts.lambda ?? 1e-4;
  const d = featureNames.length;
  const weights = new Array<number>(d).fill(0);
  let intercept = 0;
  const n = samples.length;
  for (let it = 0; it < iterations; it += 1) {
    const gradW = new Array<number>(d).fill(0);
    let gradB = 0;
    for (const s of samples) {
      let z = intercept;
      for (let i = 0; i < d; i += 1) z += weights[i]! * (s.features[i] ?? 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - s.label;
      gradB += err;
      for (let i = 0; i < d; i += 1) gradW[i]! += err * (s.features[i] ?? 0);
    }
    intercept -= learningRate * (gradB / n);
    for (let i = 0; i < d; i += 1) weights[i]! -= learningRate * (gradW[i]! / n + lambda * weights[i]!);
  }
  return {
    kind: 'logistic',
    weights: weights.map((w) => round(w, 8)),
    intercept: round(intercept, 8),
    featureNames,
    iterations,
    learningRate,
  };
}

export function predictLogistic(model: LogisticModel, features: readonly number[]): number {
  let z = model.intercept;
  for (let i = 0; i < model.weights.length; i += 1) z += model.weights[i]! * (features[i] ?? 0);
  return round(1 / (1 + Math.exp(-z)));
}

/** Persistence ("last value carried forward") baseline — the sanity floor for time series. */
export function persistenceForecast(lastValue: number): number {
  return lastValue;
}

export interface ForecastComparison {
  featureOrSeries: string;
  n: number;
  persistence: ForecastMetrics;
  baseline?: ForecastMetrics;
  head: ForecastMetrics;
  /** head MAE improvement over the tabular baseline, % */
  headVsBaselineImprovementPct?: number;
  /** head MAE improvement over persistence, % */
  headVsPersistenceImprovementPct?: number;
  /** persistence ↔ observed correlation (how much signal persistence alone explains) */
  persistenceCorrelation?: number;
  winner: 'head' | 'baseline' | 'persistence';
}

/**
 * Compare a protocol head's forecasts against (a) the tabular baseline and
 * (b) persistence, on the same held-out patient rows.
 */
export function compareForecasts(input: {
  label: string;
  persistencePredicted: readonly number[];
  baselinePredicted?: readonly number[];
  headPredicted: readonly number[];
  observed: readonly number[];
}): ForecastComparison {
  const rows = input.observed.length;
  const bundle = (predicted: readonly number[]) => forecastMetrics(predicted.slice(0, rows).map((p, i) => ({ predicted: p, observed: input.observed[i]! })));
  const persistence = bundle(input.persistencePredicted);
  const head = bundle(input.headPredicted);
  const baseline = input.baselinePredicted ? bundle(input.baselinePredicted) : undefined;
  const headVsBaselineImprovementPct = relativeImprovementPct(baseline?.mae, head.mae);
  const headVsPersistenceImprovementPct = relativeImprovementPct(persistence.mae, head.mae);
  const persistencePairs = input.persistencePredicted.slice(0, rows).map((p, i) => ({ predicted: p, observed: input.observed[i]! }));
  const persistenceCorrelation = correlation(persistencePairs);
  const winner: ForecastComparison['winner'] = baseline && baseline.mae !== undefined && head.mae !== undefined && baseline.mae < head.mae
    ? 'baseline'
    : head.mae !== undefined && persistence.mae !== undefined && head.mae < persistence.mae ? 'head' : 'persistence';
  return {
    featureOrSeries: input.label,
    n: rows,
    persistence,
    ...(baseline ? { baseline } : {}),
    head,
    ...(headVsBaselineImprovementPct !== undefined ? { headVsBaselineImprovementPct } : {}),
    ...(headVsPersistenceImprovementPct !== undefined ? { headVsPersistenceImprovementPct } : {}),
    ...(persistenceCorrelation !== undefined ? { persistenceCorrelation } : {}),
    winner,
  };
}

/** Convenience: MAE of a naive persistence forecast over a held-out series. */
export function persistenceMae(observed: readonly number[], predicted: readonly number[]): number | undefined {
  return mae(observed.map((o, i) => ({ observed: o, predicted: predicted[i] ?? o })));
}
