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

// What-If forecast — run the WASM engine locally (in-process in Node, in-browser in the admin
// UI) to project a patient's dialysis trajectory under an intervention. Zero network
// round-trip for the forecast itself: the operator picks a fork point + a nudge and the
// trajectory is computed by the same Rust code compiled to WASM (Phase 4 parity guarantees the
// browser result equals what the server would compute).

import { ensureWasmSimulation } from './wasm.js';
import type { DialysisState } from './types.js';
import { projectDialysisState, type ProjectedState } from './project.js';

export interface ForecastPoint extends ProjectedState {
  /** Realm-hours since forecast start. */
  t: number;
  state: DialysisState;
}

export interface WhatIfRequest {
  modelKind?: 'cfc' | 'ltc';
  /** Trained SafeTensors weights; default random-init (gated to α=0 → deterministic baseline). */
  weights?: Uint8Array;
  seed?: number;
  /** Fork point — the patient's current liquid state (`{dim: value}`). Default: domain initial state. */
  fromState?: Partial<DialysisState>;
  /** Number of steps to project (default 72 = 3 days). */
  steps?: number;
  /** Realm-hours per step (default 1). */
  dt?: number;
  /** One-shot state deltas applied at the start (anant InterventionSpec semantics). */
  intervention?: Record<string, number>;
}

/** Project a patient's trajectory forward under an optional one-shot intervention. */
export async function forecastPatient(req: WhatIfRequest): Promise<ForecastPoint[]> {
  const Ctor = await ensureWasmSimulation();
  const sim = new Ctor('dialysis', req.modelKind ?? 'cfc', req.weights ?? new Uint8Array(0), req.seed ?? 1);
  try {
    if (!req.weights) sim.setResidualAlpha(0); // baseline-only until trained weights exist
    if (req.fromState) sim.forkFrom(JSON.stringify(req.fromState), 0);
    const steps = req.steps ?? 72;
    const dt = req.dt ?? 1;
    const interventionJson = JSON.stringify(Object.entries(req.intervention ?? {}));
    const raw = sim.forecast(steps, dt, interventionJson);
    const ticks = JSON.parse(raw) as Array<{ t: number; stage: string; state: DialysisState }>;
    return ticks.map((tk) => ({ t: tk.t, state: tk.state, ...projectDialysisState(tk.state) }));
  } finally {
    sim.free();
  }
}
