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

// Liquid (CfC/LTC) engine — shared TypeScript vocabulary.
//
// The dialysis domain state dimensions, in schema order (see
// `native/domain-dialysis/src/lib.rs`). The TS side never re-implements the numerics — it
// calls the same Rust compiled to WASM, and these types describe the JSON crossing the boundary.

export const DIALYSIS_DIMENSIONS = [
  'vitals_instability',
  'deterioration_risk',
  'ktv_adequacy',
  'phosphate',
  'anemia_severity',
] as const;

export type DialysisDim = (typeof DIALYSIS_DIMENSIONS)[number];

/** A dialysis patient state vector, keyed by dimension (all 0..1). */
export type DialysisState = { [K in DialysisDim]: number };

/** The wasm-bindgen `WasmSimulation` surface we rely on (subset of the generated API). */
export interface LiquidSimulation {
  free(): void;
  forecast(steps: number, dt: number, interventionJson: string): string;
  forkFrom(stateJson: string, t: number): void;
  stepWithEvents(eventJson: string, dt: number): string;
  /** Override α in ΔX = ΔX_baseline + α·R_θ — set 0 until trained weights exist. */
  setResidualAlpha(alpha: number): void;
}

/** Parsed result of one `stepWithEvents` call. */
export interface StepResult {
  t: number;
  stage: string;
  state: DialysisState;
  /** α-scaled L2 magnitude of the learned residual — the divergence-from-baseline signal. */
  residual_magnitude?: number;
}

/** Clinical-lab projection of the learned dialysis state, matching the harness lab codes. */
export interface DialysisLabs {
  K: number; // mmol/L
  HGB: number; // g/dL
  URR: number; // %
  PHOS: number; // mg/dL
}

/** Which patient-trajectory engine a realm uses. `legacy` = the hand-authored physiology. */
export type TrajectoryEngine = 'legacy' | 'liquid';
