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

// Gradient-boosted regression trees — the recorded model family for adequacy,
// nutrition and infection triage in the implementation strategy (verified
// evidence: XGBoost/RF beat CNN/GRU/linear for adequacy; XGBoost+SHAP for PEW
// and BSI). We implement a deterministic, dependency-free booster so every
// protocol head can ship a real tree model with a reproducible artifact,
// instead of a stub or a heavy new dependency.
//
// Deliberate scope limits (documented, not accidental):
//   • regression trees on squared error (classification uses regression on the
//     0/1 target, which is the standard gradient-boosting formulation);
//   • depth-limited, best-split greedy construction (exact split search over
//     candidate thresholds — deterministic, no histogram approximations);
//   • gain-based feature attribution (a first-order surrogate for SHAP, which
//     is honest to report as attribution-from-gain, not Shapley values).

export interface GbtConfig {
  /** number of boosting rounds */
  trees: number;
  maxDepth: number;
  minSamplesLeaf: number;
  learningRate: number;
  /** fraction of rows sampled per tree (deterministic stride sampling) */
  subsample: number;
  /** candidate split quantiles (kept small for speed/determinism) */
  maxThresholds: number;
}

export const GBT_DEFAULTS: GbtConfig = {
  trees: 40,
  maxDepth: 3,
  minSamplesLeaf: 8,
  learningRate: 0.12,
  subsample: 0.9,
  maxThresholds: 12,
};

export interface GbtNode {
  /** leaf value when `leaf` is defined */
  leaf?: number;
  feature?: number;
  threshold?: number;
  left?: number;
  right?: number;
}

export interface GbtTree { nodes: GbtNode[] }

export interface GbtModel {
  kind: 'gbdt-regression';
  version: string;
  featureNames: readonly string[];
  baseValue: number;
  learningRate: number;
  trees: GbtTree[];
  /** total variance-reduction gain per feature (attribution input) */
  featureGain: number[];
  config: GbtConfig;
  /** training residual statistics — used for prediction bands */
  residualStd: number;
}

export interface GbtSample { features: readonly number[]; target: number }

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Sum of squared error of a value set around its mean. */
function sse(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return acc;
}

interface NodeBuild { nodes: GbtNode[]; index: number; gains: number[] }

/** Recursive best-split regression-tree construction (exact SSE reduction). */
function buildTree(
  rows: readonly GbtSample[],
  indices: readonly number[],
  residuals: readonly number[],
  depth: number,
  config: GbtConfig,
  nodes: GbtNode[],
  gains: number[],
): number {
  const idx = nodes.push({}) - 1;
  const targets = indices.map((r) => residuals[r]!);
  if (depth >= config.maxDepth || indices.length < config.minSamplesLeaf * 2) {
    nodes[idx] = { leaf: mean(targets) };
    return idx;
  }
  const parentSse = sse(targets);
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestGain = 0;
  const featureCount = rows[indices[0]!]!.features.length;

  for (let f = 0; f < featureCount; f += 1) {
    const values = indices.map((r) => rows[r]!.features[f] ?? 0);
    const unique = [...new Set(values)].sort((a, b) => a - b);
    if (unique.length < 2) continue;
    const stride = Math.max(1, Math.floor(unique.length / config.maxThresholds));
    for (let u = 0; u < unique.length - 1; u += stride) {
      const threshold = (unique[u]! + unique[u + 1]!) / 2;
      const leftTargets: number[] = [];
      const rightTargets: number[] = [];
      for (const r of indices) ((rows[r]!.features[f] ?? 0) <= threshold ? leftTargets : rightTargets).push(residuals[r]!);
      if (leftTargets.length < config.minSamplesLeaf || rightTargets.length < config.minSamplesLeaf) continue;
      const gain = parentSse - sse(leftTargets) - sse(rightTargets);
      if (gain > bestGain + 1e-12) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = threshold;
      }
    }
  }

  if (bestFeature < 0) {
    nodes[idx] = { leaf: mean(targets) };
    return idx;
  }

  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  for (const r of indices) ((rows[r]!.features[bestFeature] ?? 0) <= bestThreshold ? leftIdx : rightIdx).push(r);
  gains[bestFeature] = (gains[bestFeature] ?? 0) + bestGain;
  const left = buildTree(rows, leftIdx, residuals, depth + 1, config, nodes, gains);
  const right = buildTree(rows, rightIdx, residuals, depth + 1, config, nodes, gains);
  nodes[idx] = { feature: bestFeature, threshold: bestThreshold, left, right };
  return idx;
}

function predictTree(tree: GbtTree, features: readonly number[]): number {
  let node = tree.nodes[0]!;
  let guard = 0;
  while (guard < 64) {
    guard += 1;
    if (node.leaf !== undefined) return node.leaf;
    const value = features[node.feature ?? 0] ?? 0;
    const next = value <= (node.threshold ?? 0) ? node.left : node.right;
    if (next === undefined) return 0;
    node = tree.nodes[next]!;
  }
  return 0;
}

/** Train a gradient-boosted regression model. Deterministic for a given input order. */
export function fitGbt(samples: readonly GbtSample[], featureNames: readonly string[], config: Partial<GbtConfig> = {}): GbtModel | undefined {
  if (!samples.length || !featureNames.length) return undefined;
  const cfg: GbtConfig = { ...GBT_DEFAULTS, ...config };
  const baseValue = mean(samples.map((s) => s.target));
  const predictions = new Array<number>(samples.length).fill(baseValue);
  const trees: GbtTree[] = [];
  const featureGain = new Array<number>(featureNames.length).fill(0);

  for (let t = 0; t < cfg.trees; t += 1) {
    const residuals = samples.map((s, i) => s.target - predictions[i]!);
    const allIdx = samples.map((_, i) => i);
    // deterministic stride subsample
    const stride = Math.max(1, Math.round(1 / Math.max(0.1, cfg.subsample)));
    const indices = stride === 1 ? allIdx : allIdx.filter((i) => i % stride === 0);
    const nodes: GbtNode[] = [];
    const gains = new Array<number>(featureNames.length).fill(0);
    buildTree(samples, indices, residuals, 0, cfg, nodes, gains);
    const tree: GbtTree = { nodes };
    trees.push(tree);
    for (let f = 0; f < gains.length; f += 1) featureGain[f]! += gains[f] ?? 0;
    for (let i = 0; i < samples.length; i += 1) predictions[i]! += cfg.learningRate * predictTree(tree, samples[i]!.features);
  }

  const residuals = samples.map((s, i) => s.target - predictions[i]!);
  return {
    kind: 'gbdt-regression',
    version: '1.0.0',
    featureNames: [...featureNames],
    baseValue: Math.round(baseValue * 1e6) / 1e6,
    learningRate: cfg.learningRate,
    trees,
    featureGain,
    config: cfg,
    residualStd: Math.round(Math.sqrt(mean(residuals.map((r) => r * r))) * 1e6) / 1e6,
  };
}

export function predictGbt(model: GbtModel, features: readonly number[]): number {
  let y = model.baseValue;
  for (const tree of model.trees) y += model.learningRate * predictTree(tree, features);
  return y;
}

/** Prediction with the model's residual standard deviation (credibility band). */
export function predictGbtWithBand(model: GbtModel, features: readonly number[]): { value: number; low: number; high: number; sd: number } {
  const value = predictGbt(model, features);
  return {
    value: Math.round(value * 1e4) / 1e4,
    low: Math.round((value - model.residualStd) * 1e4) / 1e4,
    high: Math.round((value + model.residualStd) * 1e4) / 1e4,
    sd: model.residualStd,
  };
}

export interface GbtAttribution { feature: string; gain: number; share: number }

/**
 * Gain-based feature attribution (first-order surrogate for SHAP).
 * Reported as attribution-from-gain, never as Shapley values.
 */
export function gbtAttribution(model: GbtModel, limit = 10): GbtAttribution[] {
  const total = model.featureGain.reduce((a, b) => a + b, 0);
  return model.featureNames
    .map((feature, i) => ({
      feature,
      gain: Math.round((model.featureGain[i] ?? 0) * 1e4) / 1e4,
      share: total > 0 ? Math.round(((model.featureGain[i] ?? 0) / total) * 1e4) / 1e4 : 0,
    }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit);
}

/** Structural validation before a persisted artifact is trusted. */
export function validateGbtModel(model: unknown): { valid: boolean; problems: string[] } {
  const m = model as Partial<GbtModel> | undefined;
  const problems: string[] = [];
  if (!m || typeof m !== 'object') return { valid: false, problems: ['not-an-object'] };
  if (m.kind !== 'gbdt-regression') problems.push('wrong-kind');
  if (!Array.isArray(m.featureNames) || !m.featureNames.length) problems.push('missing-feature-names');
  if (!Array.isArray(m.trees) || !m.trees.length) problems.push('missing-trees');
  if (typeof m.baseValue !== 'number' || !Number.isFinite(m.baseValue)) problems.push('bad-base-value');
  for (const [i, tree] of (m.trees ?? []).entries()) {
    if (!tree || !Array.isArray(tree.nodes) || !tree.nodes.length) { problems.push(`tree-${i}-empty`); continue; }
    for (const node of tree.nodes) {
      const isLeaf = node.leaf !== undefined;
      if (isLeaf) continue;
      if (node.feature === undefined || node.threshold === undefined || node.left === undefined || node.right === undefined) {
        problems.push(`tree-${i}-malformed-node`);
        break;
      }
    }
  }
  return { valid: problems.length === 0, problems };
}

/** Model card facts for the technical file (MDR / EU AI Act evidence). */
export function gbtModelCard(model: GbtModel, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: 'gradient-boosted regression trees (depth-limited, exact split search)',
    version: model.version,
    rounds: model.trees.length,
    maxDepth: model.config.maxDepth,
    learningRate: model.learningRate,
    subsample: model.config.subsample,
    features: [...model.featureNames],
    attribution: gbtAttribution(model, model.featureNames.length),
    residualStd: model.residualStd,
    attributionMethod: 'variance-reduction gain (first-order surrogate for SHAP — not Shapley values)',
    ...extra,
  };
}
