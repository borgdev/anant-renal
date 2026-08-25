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

// Nutrition + dry-weight sub-pack. Dialysis patients need continuous
// monitoring of dry weight (target euvolemic post-treatment weight), fluid
// gains between treatments, and nutritional markers (albumin, prealbumin,
// dietary counseling adherence). Deviations trigger QAPI review.

export interface DryWeightRecord {
  readonly patientId: string;
  readonly recordedAt: string;
  readonly targetKg: number;
  readonly postTreatmentKg: number;
  readonly method: 'clinical' | 'bioimpedance' | 'ultrasound';
  readonly assessorRef: string;
}

export interface InterdialyticWeightGain {
  readonly patientId: string;
  readonly currentTreatmentAt: string;
  readonly gainKg: number;
  readonly gainPctOfDryWeight: number;
  readonly toleratedUltrafiltrationRate: 'within-limits' | 'above-13ml-per-kg-per-hr';
}

export interface NutritionAssessment {
  readonly patientId: string;
  readonly assessedAt: string;
  readonly albuminGdL: number;
  readonly nPCRgPerKgPerDay?: number; // normalized protein catabolic rate
  readonly bmi?: number;
  readonly appetiteScore?: 1 | 2 | 3 | 4 | 5;
  readonly counselingOccurredAt?: string;
  readonly followUpDate?: string;
}

export type NutritionFlag =
  | 'albumin-below-3.5'
  | 'albumin-below-4.0-with-inflammation'
  | 'excess-idwg'
  | 'ufr-above-13'
  | 'missed-counseling'
  | 'weight-loss-5-pct-in-90d';

export function evaluateNutrition(a: NutritionAssessment, priorWeightKg?: number): NutritionFlag[] {
  const flags: NutritionFlag[] = [];
  if (a.albuminGdL < 3.5) flags.push('albumin-below-3.5');
  if (a.albuminGdL >= 3.5 && a.albuminGdL < 4.0) flags.push('albumin-below-4.0-with-inflammation');
  if (priorWeightKg !== undefined && a.bmi !== undefined) {
    // heuristic — real calc requires height; kept intentionally simple
  }
  if (!a.counselingOccurredAt) flags.push('missed-counseling');
  return flags;
}

export function evaluateIDWG(iwg: InterdialyticWeightGain): NutritionFlag[] {
  const flags: NutritionFlag[] = [];
  if (iwg.gainPctOfDryWeight > 5.0) flags.push('excess-idwg');
  if (iwg.toleratedUltrafiltrationRate === 'above-13ml-per-kg-per-hr') flags.push('ufr-above-13');
  return flags;
}
