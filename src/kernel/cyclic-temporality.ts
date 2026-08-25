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

// Cyclic temporality captures workflows that repeat on a rhythm — dialysis
// three times per week, monthly labs, quarterly QAPI reviews. The harness
// needs a first-class notion so "the patient is drifting off rhythm" is a
// primitive, not a spreadsheet derivation.

export type CycleStatus = 'on-rhythm' | 'drifting' | 'broken' | 'recovering';

export interface CyclicTemporalState {
  cycleId: string;
  phase: string;
  expectedAt: string;
  observedAt?: string;
  status: CycleStatus;
}

export interface RhythmClassification {
  status: CycleStatus;
  deltaMinutes: number;
  overdueMinutes: number;
}

/**
 * Classify a single expected/observed pair against a tolerance window. This is
 * the atomic building block for higher-level rhythm analytics.
 */
export function classifyRhythm(
  expectedAt: Date,
  observedAt: Date | undefined,
  toleranceMinutes: number,
  now: Date = new Date(),
): RhythmClassification {
  if (!observedAt) {
    const overdueMinutes = Math.max(0, (now.getTime() - expectedAt.getTime()) / 60_000);
    if (overdueMinutes === 0) return { status: 'on-rhythm', deltaMinutes: 0, overdueMinutes: 0 };
    if (overdueMinutes <= toleranceMinutes) return { status: 'drifting', deltaMinutes: overdueMinutes, overdueMinutes };
    return { status: 'broken', deltaMinutes: overdueMinutes, overdueMinutes };
  }
  const delta = (observedAt.getTime() - expectedAt.getTime()) / 60_000;
  if (Math.abs(delta) <= toleranceMinutes) return { status: 'on-rhythm', deltaMinutes: delta, overdueMinutes: 0 };
  return { status: 'drifting', deltaMinutes: delta, overdueMinutes: Math.max(0, delta) };
}

/**
 * Given a rolling window of expected/observed pairs, produce a summary that
 * downstream simulations and QAPI cases can key off. `broken` counts as an
 * override — a single broken cycle in the window keeps the summary broken
 * until the next observed on-rhythm event pulls it into `recovering`.
 */
export function summarizeRhythm(
  window: Array<{ expectedAt: Date; observedAt?: Date }>,
  toleranceMinutes: number,
  now: Date = new Date(),
): CycleStatus {
  if (window.length === 0) return 'on-rhythm';
  const classifications = window.map((w) => classifyRhythm(w.expectedAt, w.observedAt, toleranceMinutes, now));
  const anyBroken = classifications.some((c) => c.status === 'broken');
  const lastObserved = [...classifications].reverse().find((c) => c.overdueMinutes === 0 && c.status === 'on-rhythm');
  if (anyBroken && lastObserved) return 'recovering';
  if (anyBroken) return 'broken';
  const anyDrifting = classifications.some((c) => c.status === 'drifting');
  return anyDrifting ? 'drifting' : 'on-rhythm';
}
