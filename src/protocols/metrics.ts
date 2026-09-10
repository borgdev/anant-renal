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

// F2 — Forecast / classifier metrics used to compare a protocol head against its
// tabular baseline. Dependency-free (no new ML packages): everything here is
// deterministic, exact-arithmetic-friendly and unit-testable.

export interface ObservedPredicted { predicted: number; observed: number }
export interface ScoredLabel { score: number; label: 0 | 1 }

export const round = (v: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Mean absolute error. */
export function mae(pairs: readonly ObservedPredicted[]): number | undefined {
  if (!pairs.length) return undefined;
  return round(pairs.reduce((acc, p) => acc + Math.abs(p.predicted - p.observed), 0) / pairs.length);
}

/** Root mean squared error. */
export function rmse(pairs: readonly ObservedPredicted[]): number | undefined {
  if (!pairs.length) return undefined;
  const mse = pairs.reduce((acc, p) => acc + (p.predicted - p.observed) ** 2, 0) / pairs.length;
  return round(Math.sqrt(mse));
}

/** Mean absolute percentage error, % (skips rows whose observed is ~0). */
export function mape(pairs: readonly ObservedPredicted[]): number | undefined {
  const usable = pairs.filter((p) => Math.abs(p.observed) > 1e-9);
  if (!usable.length) return undefined;
  return round((usable.reduce((acc, p) => acc + Math.abs((p.predicted - p.observed) / p.observed), 0) / usable.length) * 100, 3);
}

/** Mean bias (predicted − observed): positive ⇒ over-forecast. */
export function bias(pairs: readonly ObservedPredicted[]): number | undefined {
  if (!pairs.length) return undefined;
  return round(pairs.reduce((acc, p) => acc + (p.predicted - p.observed), 0) / pairs.length);
}

/** Pearson correlation between predicted and observed. */
export function correlation(pairs: readonly ObservedPredicted[]): number | undefined {
  if (pairs.length < 2) return undefined;
  const n = pairs.length;
  const mp = pairs.reduce((a, p) => a + p.predicted, 0) / n;
  const mo = pairs.reduce((a, p) => a + p.observed, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const p of pairs) {
    const dx = p.predicted - mp;
    const dy = p.observed - mo;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return undefined;
  return round(sxy / Math.sqrt(sxx * syy));
}

/** Brier score for probabilistic forecasts (lower is better). */
export function brier(pairs: readonly ScoredLabel[]): number | undefined {
  if (!pairs.length) return undefined;
  return round(pairs.reduce((acc, p) => acc + (p.score - p.label) ** 2, 0) / pairs.length);
}

export interface AuRoc { auroc: number; positives: number; negatives: number }

/**
 * AUROC via the rank/Mann-Whitney formulation (ties get average ranks) — exact,
 * no threshold sweep approximation.
 */
export function auroc(pairs: readonly ScoredLabel[]): AuRoc | undefined {
  const pos = pairs.filter((p) => p.label === 1).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return undefined;
  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  const ranks = new Array<number>(sorted.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j += 1;
    const avgRank = (i + j + 2) / 2; // 1-based average rank
    for (let k = i; k <= j; k += 1) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < sorted.length; k += 1) if (sorted[k]!.label === 1) rankSumPos += ranks[k]!;
  const a = (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
  return { auroc: round(a), positives: pos, negatives: neg };
}

/** Average precision (area under precision-recall) using the step-wise integral. */
export function auprc(pairs: readonly ScoredLabel[]): number | undefined {
  const pos = pairs.filter((p) => p.label === 1).length;
  if (pos === 0) return undefined;
  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  let tp = 0; let fp = 0; let prevRecall = 0; let area = 0;
  for (const p of sorted) {
    if (p.label === 1) tp += 1; else fp += 1;
    const recall = tp / pos;
    const precision = tp / (tp + fp);
    area += (recall - prevRecall) * precision;
    prevRecall = recall;
  }
  return round(area);
}

export interface ReliabilityBin {
  bin: number;
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number;
  observedRate: number;
  calibrationGap: number;
}

/** Equal-width reliability bins with observed event rate per bin. */
export function reliabilityBins(pairs: readonly ScoredLabel[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b += 1) {
    const lo = b / bins; const hi = (b + 1) / bins;
    const inBin = pairs.filter((p) => (b === bins - 1 ? p.score >= lo && p.score <= hi : p.score >= lo && p.score < hi));
    if (!inBin.length) {
      out.push({ bin: b, lo: round(lo, 2), hi: round(hi, 2), n: 0, meanPredicted: 0, observedRate: 0, calibrationGap: 0 });
      continue;
    }
    const meanPredicted = round(inBin.reduce((a, p) => a + p.score, 0) / inBin.length);
    const observedRate = round(inBin.reduce((a, p) => a + p.label, 0) / inBin.length);
    out.push({ bin: b, lo: round(lo, 2), hi: round(hi, 2), n: inBin.length, meanPredicted, observedRate, calibrationGap: round(observedRate - meanPredicted) });
  }
  return out;
}

/** Expected calibration error — n-weighted mean absolute gap across bins. */
export function ece(pairs: readonly ScoredLabel[], bins = 10): number | undefined {
  if (!pairs.length) return undefined;
  const rows = reliabilityBins(pairs, bins);
  const total = pairs.length;
  return round(rows.reduce((acc, r) => acc + (r.n / total) * Math.abs(r.calibrationGap), 0));
}

/** Reliability slope via least-squares of observed ~ predicted (perfect = 1). */
export function reliabilitySlope(pairs: readonly ScoredLabel[]): number | undefined {
  if (pairs.length < 2) return undefined;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p.score, 0) / n;
  const my = pairs.reduce((a, p) => a + p.label, 0) / n;
  let sxy = 0; let sxx = 0;
  for (const p of pairs) { sxy += (p.score - mx) * (p.label - my); sxx += (p.score - mx) ** 2; }
  if (sxx === 0) return undefined;
  return round(sxy / sxx);
}

export interface ForecastMetrics {
  n: number;
  mae?: number;
  rmse?: number;
  mape?: number;
  bias?: number;
  correlation?: number;
}

/** Bundle of regression metrics for one forecast (protocol × horizon). */
export function forecastMetrics(pairs: readonly ObservedPredicted[]): ForecastMetrics {
  const m = mae(pairs);
  const r = rmse(pairs);
  const mp = mape(pairs);
  const b = bias(pairs);
  const c = correlation(pairs);
  return {
    n: pairs.length,
    ...(m !== undefined ? { mae: m } : {}),
    ...(r !== undefined ? { rmse: r } : {}),
    ...(mp !== undefined ? { mape: mp } : {}),
    ...(b !== undefined ? { bias: b } : {}),
    ...(c !== undefined ? { correlation: c } : {}),
  };
}

/** Percentage improvement of `candidate` MAE over `baseline` MAE (positive = better). */
export function relativeImprovementPct(baselineMae: number | undefined, candidateMae: number | undefined): number | undefined {
  if (baselineMae === undefined || candidateMae === undefined || baselineMae === 0) return undefined;
  return round(((baselineMae - candidateMae) / baselineMae) * 100, 2);
}

/**
 * Two-sample Kolmogorov–Smirnov statistic (max ECDF gap), 0..1 — the standard
 * distribution-shift test used by every protocol's drift monitor. Deterministic.
 * Returns 1 when either sample is empty (no reference ⇒ treated as drifted).
 */
export function twoSampleKs(a: readonly number[], b: readonly number[]): number {
  if (!a.length || !b.length) return 1;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  const n = x.length;
  const m = y.length;
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < n || j < m) {
    const xv = i < n ? x[i]! : Number.POSITIVE_INFINITY;
    const yv = j < m ? y[j]! : Number.POSITIVE_INFINITY;
    if (xv <= yv) i += 1;
    if (yv <= xv) j += 1;
    d = Math.max(d, Math.abs(i / n - j / m));
  }
  return round(d, 4);
}
