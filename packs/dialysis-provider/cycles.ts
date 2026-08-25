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

// Dialysis-specific cyclic temporality: MWF, TTS, and custom cadences with
// expected inter-treatment gaps. The harness relies on these to detect
// drifting / broken rhythm at replay time without special-casing dates in
// workflow code.

export interface DialysisTreatmentCycle {
  id: string;
  patientId: string;
  facilityId: string;
  cadence: 'MWF' | 'TTS' | 'custom';
  expectedIntervalsHours: readonly number[];
  timezone: string;
  phase: 'pre-treatment' | 'treatment-due' | 'post-treatment' | 'recovery';
}

const CADENCE_INTERVALS: Record<'MWF' | 'TTS', readonly number[]> = {
  MWF: [48, 48, 72], // Mon->Wed 48h, Wed->Fri 48h, Fri->Mon 72h
  TTS: [48, 48, 72], // Tue->Thu 48h, Thu->Sat 48h, Sat->Tue 72h
};

export function intervalsForCadence(cadence: 'MWF' | 'TTS' | 'custom', custom?: readonly number[]): readonly number[] {
  if (cadence === 'custom') return custom ?? [];
  return CADENCE_INTERVALS[cadence];
}

export function expectedGapHours(cycle: DialysisTreatmentCycle, treatmentIndex: number): number {
  const intervals = cycle.expectedIntervalsHours;
  if (intervals.length === 0) return 0;
  return intervals[treatmentIndex % intervals.length] ?? 0;
}

export function hasCycleBreak(expectedAt: Date, completedAt: Date | undefined, toleranceMinutes: number, now = new Date()): boolean {
  if (!completedAt) return now.getTime() > expectedAt.getTime() + toleranceMinutes * 60_000;
  return Math.abs(completedAt.getTime() - expectedAt.getTime()) > toleranceMinutes * 60_000;
}
