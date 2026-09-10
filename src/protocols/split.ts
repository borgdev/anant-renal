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

// F2 — Patient-level evaluation splits.
//
// Every renal protocol is evaluated on a PATIENT split, never a row split: rows
// from one patient never appear in both train and test, so reported metrics
// cannot be inflated by longitudinal leakage. Assignment is deterministic
// (stable FNV-1a hash of the patient id + salt) so a split is reproducible
// across runs and machines.

export interface SplitOptions {
  /** Fraction of patients assigned to train (default 0.7). */
  trainFraction?: number;
  /** Salt makes independent splits (different folds) from the same ids. */
  salt?: string;
}

export interface PatientSplit {
  train: string[];
  test: string[];
  trainFraction: number;
  salt: string;
}

/**
 * Stable hash → [0,1). FNV-1a followed by a final avalanche mix: plain FNV-1a
 * has weak low-bit mixing, which biases splits for ids that share a long prefix
 * (e.g. `sim-fac-a-pt-0001`…). The mix step makes the buckets evenly distributed.
 */
export function stableUnitInterval(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** Deterministic patient-level train/test split. */
export function patientLevelSplit(patientIds: readonly string[], opts: SplitOptions = {}): PatientSplit {
  const trainFraction = Math.min(0.95, Math.max(0.05, opts.trainFraction ?? 0.7));
  const salt = opts.salt ?? 'renal-f2';
  const unique = [...new Set(patientIds)].sort();
  const train: string[] = [];
  const test: string[] = [];
  for (const id of unique) {
    (stableUnitInterval(`${salt}:${id}`) < trainFraction ? train : test).push(id);
  }
  return { train, test, trainFraction, salt };
}

/** Rows belonging to the train half of a patient split. */
export function filterByPatientSplit<T extends { patientId: string }>(rows: readonly T[], split: PatientSplit): { train: T[]; test: T[] } {
  const trainSet = new Set(split.train);
  const train: T[] = [];
  const test: T[] = [];
  for (const row of rows) (trainSet.has(row.patientId) ? train : test).push(row);
  return { train, test };
}

/** Assert a split has no patient overlap — used by tests and the report builder. */
export function hasNoPatientOverlap(split: PatientSplit): boolean {
  const trainSet = new Set(split.train);
  return split.test.every((id) => !trainSet.has(id));
}
