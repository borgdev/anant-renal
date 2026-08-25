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

// TrajectoryAmbientProcess — replaces the hand-authored patient physiology
// (`src/realm/ambient.ts::PatientTrajectoryProcess` / `LabMaturationProcess.draw()`).
//
// Each realm tick, for every patient entity, it:
//   1. builds an event-feature vector from the realm's recent effects + patient state
//      (missed treatments, abnormal labs/vitals, access complications, phosphate adherence),
//   2. advances the patient's own CfC/LTC liquid model one step via the WASM engine
//      (`stepWithEvents`) — `ΔX = ΔX_baseline + α·R_θ`,
//   3. projects the learned 0..1 dialysis state onto the clinical lab/vitals fields the rest
//      of the harness already understands (K, HGB, URR, PHOS, HR, SpO2, trajectory, risk),
//      and patches the entity graph — so everything downstream (agents, CQL measures,
//      counterfactuals) sees a *learned* trajectory, ledgered as a normal ambient effect.
//
// The learned residual is a small perturbation (α = 0.15) until Phase 6 trains real weights;
// with no promoted model the WASM engine still runs the hand-authored baseline ODE, so
// trajectories are plausible from day one.

import type { AmbientContext, AmbientProcess } from '../realm/ambient.js';
import type { EmittedEffect, EntityUrn, WorldEffect } from '../realm/types.js';
import { ensureWasmSimulation, tryGetWasmSimulation } from './wasm.js';
import { LiquidModelStore } from './model-store.js';
import type { DialysisLabs, DialysisState, LiquidSimulation, StepResult } from './types.js';
import { projectDialysisState } from './project.js';
import { computeEffectiveTau, tauDtFactor } from './regime.js';

export interface LiquidTrajectoryOptions {
  /** Domain the wasm binds — default `dialysis`. */
  domainId?: string;
  /** Model family — default `cfc`. */
  modelKind?: 'cfc' | 'ltc';
  /** Explicit SafeTensors weights; default: store's active model for the domain, else random-init. */
  weights?: Uint8Array;
  /** Optional store to load the active model's weights from. */
  store?: LiquidModelStore;
}

interface PatientPulse {
  missed: number;
  access: number;
  lab: number;
}

interface PatientStateLike {
  trajectory?: string;
  problemList?: string[];
  lastVitals?: { hr?: number; spo2?: number };
  labs?: DialysisLabs;
  accessIssue?: boolean;
  phosBinderAdherence?: string;
}

type SimulationCtor = new (domainId: string, modelKind: string, weights: Uint8Array, seed: number) => LiquidSimulation;

const EVENT_ORDER = ['missed_treatment', 'access_complication', 'lab_marker_elevated', 'abnormal_vital_reading', 'diet_phosphate_violation'] as const;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Deterministic FNV-1a seed from a string id, so a patient's model is reproducible. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Which patient an effect belongs to (result-lab resolves patient via the order entity). */
function patientOf(e: WorldEffect, ctx: AmbientContext): string | undefined {
  switch (e.kind) {
    case 'result-lab': {
      const order = ctx.graph.get(ctx.graph.urnFor('order', e.orderId));
      return (order?.state as { patientId?: string } | undefined)?.patientId;
    }
    default:
      if ('patientId' in e && typeof (e as { patientId?: unknown }).patientId === 'string') {
        return (e as { patientId: string }).patientId;
      }
      return undefined;
  }
}

export class TrajectoryAmbientProcess implements AmbientProcess {
  id = 'trajectory.liquid';
  description =
    'Patient trajectories evolve under the learned CfC/LTC residual, driven by realm effects (missed treatments, abnormal labs/vitals, access, phosphate).';

  private readonly domainId: string;
  private readonly modelKind: 'cfc' | 'ltc';
  private readonly weights: Uint8Array | undefined;
  private model: SimulationCtor | null = null;
  private readonly sims = new Map<string, LiquidSimulation>();
  private readonly pulses = new Map<string, PatientPulse>();
  private readonly biases = new Map<string, Record<string, number>>();
  /** Per-vertex adaptive time constant (realm-hours) from the previous tick, for dt feedback. */
  private readonly lastTau = new Map<string, { state: DialysisState; tau: number }>();
  private prevRealmAtMs: number | undefined;
  private readonly readyPromise: Promise<void>;

  constructor(opts: LiquidTrajectoryOptions = {}) {
    this.domainId = opts.domainId ?? 'dialysis';
    this.modelKind = opts.modelKind ?? 'cfc';
    this.store = opts.store;
    this.weights = opts.weights ?? this.store?.weightsFor(this.domainId);
    this.readyPromise = this.#init();
  }

  private readonly store: LiquidModelStore | undefined;

  async #init(): Promise<void> {
    // If the wasm is already loaded (pre-await elsewhere, e.g. a counterfactual harness), grab
    // it synchronously so a synchronous realm tick sees the model immediately.
    const sync = tryGetWasmSimulation();
    if (sync) {
      this.model = sync as unknown as SimulationCtor;
      return;
    }
    const ctor = await ensureWasmSimulation();
    this.model = ctor as unknown as SimulationCtor;
  }

  /** Resolves once the WASM engine is loaded; await before ticking in tests for determinism. */
  async whenReady(): Promise<void> {
    await this.readyPromise;
  }

  /**
   * Persist an event-feature bias for a patient — a counterfactual nudge that changes the
   * behavior signals feeding the liquid model every tick (e.g. fewer phosphate violations,
   * more sleep-disruption events). Deltas accumulate across calls. Applied in `#eventVector`.
   */
  biasPatient(patientId: string, eventDeltas: Record<string, number>): void {
    const cur = this.biases.get(patientId) ?? {};
    for (const [k, v] of Object.entries(eventDeltas)) {
      cur[k] = (cur[k] ?? 0) + v;
    }
    this.biases.set(patientId, cur);
  }

  onTick(ctx: AmbientContext): void {
    if (!this.model) return; // wasm still loading — skip this tick
    const nowMs = ctx.clock.realmAt.getTime();
    const prevMs = this.prevRealmAtMs ?? nowMs;
    this.prevRealmAtMs = nowMs;
    const dtHours = Math.max((nowMs - prevMs) / 3_600_000, 1e-6);

    // Decay pulses from prior ticks so a single effect isn't an infinite event.
    for (const [pid, p] of this.pulses) {
      p.missed *= 0.9;
      p.access *= 0.9;
      p.lab *= 0.9;
      if (p.missed < 0.01 && p.access < 0.01 && p.lab < 0.01) this.pulses.delete(pid);
    }

    for (const p of ctx.graph.listKind('patient')) {
      const st = (p.state ?? {}) as PatientStateLike;
      const sim = this.#simFor(p.id);
      if (!sim) continue;
      const prev = this.lastTau.get(p.id);
      // Adaptive per-vertex time constant: the previous tick's τ scales this tick's evolution
      // (high-reactivity vertices advance faster, sluggish ones slower).
      const dtFactor = prev ? tauDtFactor(prev.tau) : 1;
      const event = this.#eventVector(p.id, st);
      const raw = sim.stepWithEvents(JSON.stringify(event), dtHours * dtFactor);
      const out = JSON.parse(raw) as StepResult;
      const tau = prev ? computeEffectiveTau(prev.state, out.state) : 0;
      this.lastTau.set(p.id, { state: out.state, tau });
      this.#apply(ctx, p.urn, p.id, out.state, out.residual_magnitude, tau, dtFactor);
    }
  }

  onEffect(emitted: EmittedEffect, ctx: AmbientContext): void {
    const pid = patientOf(emitted.effect, ctx);
    if (!pid) return;
    const pulse = this.pulses.get(pid) ?? { missed: 0, access: 0, lab: 0 };
    const e = emitted.effect;
    if (e.kind === 'flag-safety-event') {
      const k = e.safetyKind.toLowerCase();
      if (/(missed|no.?show|skip|absent)/.test(k)) pulse.missed = Math.max(pulse.missed, 1);
      if (/access|fistula|graft|catheter/.test(k)) pulse.access = Math.max(pulse.access, 1);
      if (/lab|elevat|abnormal|hyperk|anemia/.test(k)) pulse.lab = Math.max(pulse.lab, 1);
    }
    if (e.kind === 'result-lab' && e.abnormal) pulse.lab = Math.max(pulse.lab, 1);
    this.pulses.set(pid, pulse);
  }

  #simFor(patientId: string): LiquidSimulation | undefined {
    if (!this.model) return undefined;
    let sim = this.sims.get(patientId);
    if (!sim) {
      sim = new this.model(this.domainId, this.modelKind, this.weights ?? new Uint8Array(0), hashSeed(patientId));
      // Until trained weights are promoted, run the deterministic baseline ODE (α = 0) so
      // trajectories converge instead of being dominated by a random untrained residual.
      if (!this.weights) sim.setResidualAlpha(0);
      this.sims.set(patientId, sim);
    }
    return sim;
  }

  /** Event-feature vector in event-feature-schema order: [missed, access, lab, vitals, phos]. */
  #eventVector(patientId: string, st: PatientStateLike): number[] {
    const pulse = this.pulses.get(patientId) ?? { missed: 0, access: 0, lab: 0 };
    const v = st.lastVitals ?? {};
    const hr = v.hr ?? 72;
    const spo2 = v.spo2 ?? 97;
    const abnormalVitals = hr > 110 || hr < 50 || spo2 < 92 ? 1 : 0;
    const underdialyzed = st.trajectory === 'underdialyzed' || (st.problemList ?? []).includes('Underdialysis');
    const labs = st.labs;
    const abnormalLabs = labs ? labs.K > 5.5 || labs.URR < 65 || labs.PHOS > 5.5 || labs.HGB < 10 : false;
    const poorPhos = st.phosBinderAdherence === 'poor' || (st.problemList ?? []).includes('CKD-MBD');
    const base: number[] = [
      Math.max(pulse.missed, underdialyzed ? 0.5 : 0),
      Math.max(pulse.access, st.accessIssue ? 1 : 0),
      Math.max(pulse.lab, abnormalLabs ? 0.5 : 0),
      abnormalVitals,
      poorPhos ? 0.5 : 0,
    ];
    const bias = this.biases.get(patientId);
    if (!bias) return base;
    return EVENT_ORDER.map((name, i) => clamp01(base[i]! + (bias[name] ?? 0)));
  }

  /** Project the learned 0..1 dialysis state onto the harness's clinical fields and patch the graph. */
  #apply(ctx: AmbientContext, urn: EntityUrn, patientId: string, state: DialysisState, residualMagnitude?: number, tau?: number, tauFactor?: number): void {
    const projected = projectDialysisState(state);
    const { labs, hr, spo2, risk, trajectory } = projected;

    ctx.graph.patch(urn, {
      trajectory,
      risk,
      lastVitals: { hr, spo2, at: ctx.clock.realmAt.toISOString() },
      labs,
      liquid: {
        state,
        ...(residualMagnitude !== undefined ? { residualMagnitude } : {}),
        ...(tau !== undefined ? { tau } : {}),
        ...(tauFactor !== undefined ? { tauFactor } : {}),
        at: ctx.clock.realmAt.toISOString(),
      },
    }, 'ambient:liquid-trajectory');

    ctx.router.broadcast({
      kind: 'ambient.liquid-trajectory',
      entityUrn: urn,
      entityKind: 'patient',
      entityId: patientId,
      payload: { labs, risk, trajectory, hr, spo2 },
      realmAt: ctx.clock.realmAt.toISOString(),
    });
  }
}
