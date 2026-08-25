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

// Liquid hypergraph mechanic — dynamical-regime observables per patient.
//
// liquid-ai.md's deeper vision, made concrete: instead of only static threshold crossings,
// detect when an entity's *dynamical regime* changes — time-constant collapse (high
// reactivity), critical slowing down (a bad condition has stopped recovering — a precursor to
// a critical transition), and divergence (the learned residual is leaving the baseline). These
// become realm Experiences agents can perceive and react to.
//
// Integration: `makeRegimeRule()` is a realm `TsRule` (onTick) that reads each patient's
// learned `liquid.state` + `residualMagnitude` from the graph and emits an Experience on a
// regime transition. `RegimeDetector` is the pure, unit-testable core.

import type { Experience, TsRule } from '../realm/rules.js';
import { DIALYSIS_DIMENSIONS, type DialysisDim, type DialysisState } from './types.js';

export type Regime = 'stable' | 'high-reactivity' | 'critical-slowing-down' | 'divergence';

export interface RegimeSignal {
  patientId: string;
  regime: Regime;
  /** Effective time constant (realm-hours, 1 tick ≈ 1 realm-hour in sim) — min across dims. */
  tau: number;
  /** Max |Δstate|/Δt across dims (per realm-hour). */
  velocity: number;
  /** α-scaled residual magnitude (divergence from baseline). */
  divergence: number;
  at: string;
}

export interface RegimeDetectorOptions {
  /** History window in observations (default 8). */
  window?: number;
  /** Effective τ below this AND velocity above `velocityFloor` → high-reactivity (default 1.0 h). */
  tauCollapseBelow?: number;
  /** Active-bad dim with τ above this → critical slowing down (default 12 h). */
  slowDownAbove?: number;
  /** Residual magnitude above this → divergence (default 0.15). */
  divergenceAbove?: number;
  /** Velocity floor for high-reactivity (per realm-hour, default 0.05). */
  velocityFloor?: number;
}

const EPS = 1e-6;

/** A dimension is "active-bad" when it sits in the concerning region of its range. */
const ACTIVE_BAD: Record<DialysisDim, (v: number) => boolean> = {
  ktv_adequacy: (v) => v < 0.4, // low = bad
  phosphate: (v) => v > 0.6, // high = bad
  anemia_severity: (v) => v > 0.6, // high = bad
  vitals_instability: (v) => v > 0.5, // high = bad
  deterioration_risk: (v) => v > 0.5, // high = bad
};

export class RegimeDetector {
  private readonly history = new Map<string, Array<{ t: number; state: DialysisState; divergence: number }>>();
  private readonly ticks = new Map<string, number>();
  private readonly last = new Map<string, Regime>();
  private readonly opts: Required<RegimeDetectorOptions>;

  constructor(opts: RegimeDetectorOptions = {}) {
    this.opts = {
      window: opts.window ?? 8,
      tauCollapseBelow: opts.tauCollapseBelow ?? 1.0,
      slowDownAbove: opts.slowDownAbove ?? 12,
      divergenceAbove: opts.divergenceAbove ?? 0.15,
      velocityFloor: opts.velocityFloor ?? 0.05,
    };
  }

  /**
   * Feed one tick's observation for a patient. Returns a `RegimeSignal` **only when the
   * regime changes** (edge-triggered), else undefined. `t` is a per-patient tick counter —
   * realm sim ticks are 1 realm-hour apart, so "per tick" ≈ "per realm-hour".
   */
  observe(patientId: string, state: DialysisState, divergence: number, at: string): RegimeSignal | undefined {
    const t = (this.ticks.get(patientId) ?? 0) + 1;
    this.ticks.set(patientId, t);
    const h = this.history.get(patientId) ?? [];
    h.push({ t, state, divergence });
    while (h.length > this.opts.window) h.shift();
    this.history.set(patientId, h);

    const regime = this.classify(h);
    const prev = this.last.get(patientId) ?? 'stable';
    this.last.set(patientId, regime);
    if (regime === prev) return undefined;

    const { velocity, tau } = this.metrics(h);
    return { patientId, regime, tau, velocity, divergence, at };
  }

  private classify(h: Array<{ t: number; state: DialysisState; divergence: number }>): Regime {
    const last = h[h.length - 1]!;
    // Divergence dominates: the learned dynamics have left the baseline manifold.
    if (last.divergence > this.opts.divergenceAbove) return 'divergence';
    const { velocity, tau, badTau } = this.metrics(h);
    // Critical slowing down: an active-bad dim's recovery timescale has blown up ("stuck at
    // bad" — the system stopped recovering, a precursor to a critical transition).
    if (badTau > this.opts.slowDownAbove) return 'critical-slowing-down';
    // Time-constant collapse: tiny effective τ + high reactivity.
    if (tau < this.opts.tauCollapseBelow && velocity > this.opts.velocityFloor) return 'high-reactivity';
    return 'stable';
  }

  private metrics(h: Array<{ t: number; state: DialysisState; divergence: number }>): { velocity: number; tau: number; badTau: number } {
    let velocity = 0;
    let tau = Infinity;
    const last = h[h.length - 1]!;
    for (let k = 1; k < h.length; k++) {
      const prev = h[k - 1]!;
      const cur = h[k]!;
      const dt = Math.max(cur.t - prev.t, EPS);
      for (const dim of DIALYSIS_DIMENSIONS) {
        const dx = cur.state[dim] - prev.state[dim];
        const rate = Math.abs(dx) / dt;
        velocity = Math.max(velocity, rate);
        if (rate > EPS) {
          const tauDim = Math.abs(cur.state[dim]) / rate;
          if (tauDim < tau) tau = tauDim;
        }
      }
    }
    // Critical-slowing signal: the recovery timescale of an ACTIVE-BAD dim at the CURRENT step
    // (not the window min — a fast early move shouldn't mask a present stall).
    let badTau = Infinity;
    if (h.length >= 2) {
      const prev = h[h.length - 2]!;
      const dt = Math.max(last.t - prev.t, EPS);
      for (const dim of DIALYSIS_DIMENSIONS) {
        const rate = Math.abs(last.state[dim] - prev.state[dim]) / dt;
        if (rate > EPS && ACTIVE_BAD[dim](last.state[dim])) {
          const tauDim = Math.abs(last.state[dim]) / rate;
          if (tauDim < badTau) badTau = tauDim;
        }
      }
    }
    if (!isFinite(tau)) tau = this.opts.slowDownAbove * 10;
    if (!isFinite(badTau)) badTau = 0; // no active-bad dim moving → not critical-slowing
    return { velocity, tau, badTau };
  }
}

/**
 * Realm TsRule: watch every patient's learned liquid state and emit an Experience when a
 * dynamical-regime transition occurs. Register it when a realm runs the liquid engine.
 */
export function makeRegimeRule(): TsRule {
  const detector = new RegimeDetector();
  return {
    id: 'liquid.regime-change',
    description: 'Emit an Experience when a patient dynamical regime transitions (tau collapse, critical slowing down, divergence).',
    onTick(ctx) {
      const out: Experience[] = [];
      for (const p of ctx.graph.listKind('patient')) {
        const st = p.state as { liquid?: { state?: DialysisState; residualMagnitude?: number } };
        const liquid = st.liquid;
        if (!liquid?.state) continue;
        const signal = detector.observe(p.id, liquid.state, liquid.residualMagnitude ?? 0, ctx.now);
        if (!signal || signal.regime === 'stable') continue;
        out.push({
          experienceId: `liquid-regime-${p.id}-${ctx.now}`,
          ruleId: 'liquid.regime-change',
          ruleSource: 'ts',
          kind: 'liquid.regime-change',
          severity: signal.regime === 'critical-slowing-down' || signal.regime === 'divergence' ? 'critical' : 'warning',
          subjectUrn: p.urn,
          payload: {
            patientId: p.id,
            regime: signal.regime,
            tau: round2(signal.tau),
            velocity: round3(signal.velocity),
            divergence: round3(signal.divergence),
          },
          producedAt: ctx.now,
        });
      }
      return out;
    },
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Per-tick effective time constant: min over dims of |x| / |Δx| (realm-hours per unit state).
 * Small τ ⇒ the state moves a large fraction of its magnitude per tick (high reactivity);
 * large τ ⇒ sluggish. `0` when nothing moved.
 */
export function computeEffectiveTau(prev: DialysisState, cur: DialysisState): number {
  let tau = Infinity;
  for (const dim of DIALYSIS_DIMENSIONS) {
    const rate = Math.abs(cur[dim] - prev[dim]);
    if (rate > 1e-6) {
      const t = Math.abs(cur[dim]) / rate;
      if (t < tau) tau = t;
    }
  }
  return isFinite(tau) ? tau : 0;
}

/**
 * Adaptive per-vertex time-constant feedback: how much to scale the next tick's evolution.
 * A high-reactivity vertex (tiny τ) advances faster; a sluggish/critical vertex (huge τ)
 * advances slower — the liquid-ai.md "τ becomes learned/adaptive" mechanic.
 */
export function tauDtFactor(tau: number): number {
  if (tau <= 0) return 0.7; // stalled → evolve slower
  if (tau < 2) return 1.5; // high reactivity → evolve faster
  if (tau > 24) return 0.7; // sluggish → evolve slower
  return 1;
}
