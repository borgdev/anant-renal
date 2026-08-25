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

// Shared projection of the learned 0..1 dialysis state onto the clinical fields the rest of
// the harness understands (labs, vitals, risk, trajectory label). Used by both the realm
// trajectory process and the What-If forecast service so they can't drift apart.

import type { DialysisLabs, DialysisState } from './types.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface ProjectedState {
  labs: DialysisLabs;
  hr: number;
  spo2: number;
  risk: number;
  trajectory: string;
}

export function projectDialysisState(state: DialysisState): ProjectedState {
  const ktv = state.ktv_adequacy;
  const anemia = state.anemia_severity;
  const phos = state.phosphate;
  const vitals = state.vitals_instability;
  const risk = state.deterioration_risk;

  const labs: DialysisLabs = {
    K: round1(6.5 - 3.0 * ktv), // 3.5 (ktv=1) .. 6.5 (ktv=0)
    HGB: round1(13.0 - 5.0 * anemia), // 13 (anemia=0) .. 8 (anemia=1)
    URR: Math.round(55 + 30 * ktv), // 55% .. 85%
    PHOS: round1(3.5 + 4.0 * phos), // 3.5 .. 7.5
  };
  return {
    labs,
    hr: Math.round(70 + 30 * vitals),
    spo2: Math.round(clamp(98 - 8 * vitals, 80, 100)),
    risk: round3(risk),
    trajectory: trajectoryLabel(state),
  };
}

export function trajectoryLabel(s: DialysisState): string {
  if (s.deterioration_risk > 0.6) return 'decompensating';
  if (s.ktv_adequacy < 0.4) return 'underdialyzed';
  if (s.phosphate > 0.65) return 'hyperphosphatemia';
  if (s.anemia_severity > 0.6) return 'anemic-worsening';
  if (s.deterioration_risk < 0.2) return 'stable';
  return 'recovering';
}
