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

// M13.F — Whole-realm replay + counterfactual scoring
//
// Given a Realm builder (fresh, deterministic construction of an initial state)
// and a scripted timeline of effects, this harness produces two runs:
//   - baseline: replay the timeline as-is
//   - counterfactual: apply an intervention (preference nudges, extra intents,
//     or effect substitutions) then replay
// It returns both rollups and a scored diff so the operator can see the
// projected impact of a directive before applying it.
//
// The harness never touches the original Realm; it always constructs new ones
// via the provided builder. Callers pass a builder that seeds facility state
// deterministically.

import type { Realm } from './realm.js';
import type { WorldEffect } from './types.js';
import { TrajectoryAmbientProcess } from '../liquid/trajectory.js';

export interface TimelineEntry {
  atMs: number; // ms since realm start
  presenceRole: string; // resolve to first-matching presence in the fresh realm
  effect: WorldEffect;
}

export type Intervention =
  | { kind: 'nudge-preference'; presenceRole: string; effectKind: WorldEffect['kind']; delta: number }
  | {
      /** Persistent event-feature bias applied to patient trajectories every tick (learned
       * dynamics, Phase 5). `effect` keys are event-feature names (missed_treatment,
       * diet_phosphate_violation, abnormal_vital_reading, …). Omit `targetPatient` to bias all. */
      kind: 'event-effect';
      effect: Record<string, number>;
      targetPatient?: string;
    };

export interface CounterfactualInput {
  build: () => Realm;
  timeline: TimelineEntry[];
  interventions: Intervention[];
  advanceTicks?: number; // extra idle ticks at end for ambient/attribution to settle
}

export interface PopulationMetrics {
  patients: number;
  meanKtv: number; // primary measure proxy (dialysis adequacy, higher = better)
  meanRisk: number;
  maxRisk: number; // worst-off patient (composite risk)
  maxVitals: number; // worst-off patient vitals instability — the sleep/instability equity signal
  meanWell: number; // 1 − meanRisk
  floorWell: number; // 1 − maxRisk
}

export interface RunReport {
  cost: ReturnType<Realm['cost']['rollup']>;
  hitl: { pending: number; approved: number; rejected: number };
  effects: { total: number; accepted: number; rejected: number };
  safety: { total: number; bySeverity: Record<string, number> };
  population: PopulationMetrics;
}

export interface PromotionGates {
  /** (a) primary measure improves */
  measureImproves: boolean;
  /** (b) no equity metric regresses beyond floor */
  noEquityRegression: boolean;
  /** (c) no policy/safety violation */
  noPolicyViolation: boolean;
}

export interface CounterfactualReport {
  baseline: RunReport;
  counterfactual: RunReport;
  delta: {
    dollars: number;
    clinicianMin: number;
    safetyRisk: number;
    patientSatisfaction: number;
    throughput: number;
    hitlPending: number;
    safetyTotal: number;
  };
  interpretation: string;
  /** M24 promotion gates — a variant is promotable only if all three pass. */
  gates: PromotionGates;
  promotable: boolean;
  gateReasons: string[];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / Math.max(xs.length, 1);

/** Risk proxy for a patient entity: prefer the liquid process's `risk`, else derive from trajectory. */
function patientRisk(state: Record<string, unknown>): number {
  if (typeof state.risk === 'number') return state.risk;
  switch (state.trajectory) {
    case 'decompensating': return 0.8;
    case 'underdialyzed': return 0.65;
    case 'hyperphosphatemia': return 0.55;
    case 'anemic-worsening': return 0.5;
    case 'recovering': return 0.3;
    case 'stable': return 0.15;
    default: return 0.5;
  }
}

/** Kt/V proxy for a patient: prefer the liquid state, else derive from URR (URR = 55 + 30·ktv). */
function patientKtv(state: Record<string, unknown>): number {
  const liquid = state.liquid as { state?: Record<string, number> } | undefined;
  if (typeof liquid?.state?.ktv_adequacy === 'number') return liquid.state.ktv_adequacy;
  const labs = state.labs as { URR?: number } | undefined;
  if (typeof labs?.URR === 'number') return clamp01((labs.URR - 55) / 30);
  return 0.5;
}

/** Vitals instability (sleep/autonomic disruption) proxy — prefer the liquid state. */
function patientVitals(state: Record<string, unknown>): number {
  const liquid = state.liquid as { state?: Record<string, number> } | undefined;
  if (typeof liquid?.state?.vitals_instability === 'number') return liquid.state.vitals_instability;
  return 0.2;
}

function populationOf(realm: Realm): PopulationMetrics {
  const risks: number[] = [];
  const ktvs: number[] = [];
  const vitals: number[] = [];
  for (const p of realm.graph.listKind('patient')) {
    const st = (p.state ?? {}) as Record<string, unknown>;
    risks.push(patientRisk(st));
    ktvs.push(patientKtv(st));
    vitals.push(patientVitals(st));
  }
  const patients = risks.length;
  if (patients === 0) return { patients: 0, meanKtv: 0, meanRisk: 0, maxRisk: 0, maxVitals: 0, meanWell: 0, floorWell: 0 };
  const meanRisk = mean(risks);
  const maxRisk = Math.max(...risks);
  return {
    patients,
    meanKtv: mean(ktvs),
    meanRisk,
    maxRisk,
    maxVitals: Math.max(...vitals),
    meanWell: 1 - meanRisk,
    floorWell: 1 - maxRisk,
  };
}

function summarize(realm: Realm): RunReport {
  const all = realm.hitl.all();
  const effects = realm.ledger.listAll();
  const safety = effects.filter((e) => e.effect.kind === 'flag-safety-event' && e.status !== 'rejected');
  const bySeverity: Record<string, number> = {};
  for (const e of safety) {
    const sev = (e.effect as { severity?: string }).severity ?? 'unknown';
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  return {
    cost: realm.cost.rollup(),
    hitl: {
      pending: all.filter((a) => a.status === 'pending').length,
      approved: all.filter((a) => a.status === 'approved').length,
      rejected: all.filter((a) => a.status === 'rejected').length,
    },
    effects: {
      total: effects.length,
      accepted: effects.filter((e) => e.status !== 'rejected').length,
      rejected: effects.filter((e) => e.status === 'rejected').length,
    },
    safety: { total: safety.length, bySeverity },
    population: populationOf(realm),
  };
}

function applyTimeline(realm: Realm, timeline: TimelineEntry[]): void {
  const startMs = realm.clock.realmAt.getTime();
  const sorted = [...timeline].sort((a, b) => a.atMs - b.atMs);
  let lastAt = 0;
  for (const entry of sorted) {
    // Advance clock to the entry's time
    const advance = entry.atMs - lastAt;
    if (advance > 0) realm.clock.advanceBy(advance);
    lastAt = entry.atMs;
    // Find a presence matching the role
    const presence = realm.presences.list().find((p) => p.role === entry.presenceRole);
    if (!presence) continue;
    try { realm.emit(presence.presenceId, entry.effect); } catch { /* swallow — timeline replay is best-effort */ }
    void startMs;
  }
}

function applyInterventions(realm: Realm, interventions: Intervention[]): void {
  for (const iv of interventions) {
    if (iv.kind === 'nudge-preference') {
      const targets = realm.presences.list().filter((p) => p.role === iv.presenceRole);
      for (const t of targets) {
        realm.selfModel.nudgePreference(t.presenceId, iv.effectKind, iv.delta, 'counterfactual-intervention');
      }
    } else if (iv.kind === 'event-effect') {
      // Learned-dynamics nudge: bias the liquid trajectory's event features for the target
      // patients (all by default). Requires the realm to run the liquid trajectory process.
      const proc = realm.ambient.list().find((p) => p.id === 'trajectory.liquid');
      if (!proc || !(proc instanceof TrajectoryAmbientProcess)) continue;
      const targets = iv.targetPatient ? [iv.targetPatient] : realm.graph.listKind('patient').map((p) => p.id);
      for (const pid of targets) proc.biasPatient(pid, iv.effect);
    }
  }
}

export function runCounterfactual(input: CounterfactualInput): CounterfactualReport {
  // Baseline
  const b = input.build();
  applyTimeline(b, input.timeline);
  for (let i = 0; i < (input.advanceTicks ?? 4); i++) b.clock.advanceBy(60 * 60 * 1000);
  const baseline = summarize(b);
  b.stop();

  // Counterfactual
  const c = input.build();
  applyInterventions(c, input.interventions);
  applyTimeline(c, input.timeline);
  for (let i = 0; i < (input.advanceTicks ?? 4); i++) c.clock.advanceBy(60 * 60 * 1000);
  const cf = summarize(c);
  c.stop();

  const delta = {
    dollars: cf.cost.totals.dollars - baseline.cost.totals.dollars,
    clinicianMin: cf.cost.totals.clinicianMin - baseline.cost.totals.clinicianMin,
    safetyRisk: cf.cost.totals.safetyRisk - baseline.cost.totals.safetyRisk,
    patientSatisfaction: cf.cost.totals.patientSatisfaction - baseline.cost.totals.patientSatisfaction,
    throughput: cf.cost.totals.throughput - baseline.cost.totals.throughput,
    hitlPending: cf.hitl.pending - baseline.hitl.pending,
    safetyTotal: cf.safety.total - baseline.safety.total,
  };

  // Simple heuristic interpretation
  const bits: string[] = [];
  if (delta.dollars !== 0) bits.push(`dollars ${delta.dollars > 0 ? '+' : ''}$${delta.dollars.toFixed(0)}`);
  if (delta.safetyRisk !== 0) bits.push(`safety risk ${delta.safetyRisk > 0 ? '+' : ''}${delta.safetyRisk.toFixed(2)}`);
  if (delta.safetyTotal !== 0) bits.push(`safety events ${delta.safetyTotal > 0 ? '+' : ''}${delta.safetyTotal}`);
  if (delta.patientSatisfaction !== 0) bits.push(`satisfaction ${delta.patientSatisfaction > 0 ? '+' : ''}${delta.patientSatisfaction.toFixed(2)}`);
  if (delta.throughput !== 0) bits.push(`throughput ${delta.throughput > 0 ? '+' : ''}${delta.throughput}`);
  const interpretation = bits.length === 0 ? 'no measurable difference' : bits.join(' \u00b7 ');

  // M24 promotion gates — all three must pass for a variant to be promotable.
  const gates: PromotionGates = {
    measureImproves: cf.population.meanKtv > baseline.population.meanKtv,
    noEquityRegression: cf.population.maxVitals <= baseline.population.maxVitals + 0.05,
    noPolicyViolation: cf.safety.total <= baseline.safety.total,
  };
  const gateReasons: string[] = [];
  if (!gates.measureImproves) gateReasons.push('primary measure (mean Kt/V) did not improve');
  if (!gates.noEquityRegression) gateReasons.push('equity regression: sleep/vitals instability rose beyond floor');
  if (!gates.noPolicyViolation) gateReasons.push('policy violation: safety events increased');
  const promotable = gates.measureImproves && gates.noEquityRegression && gates.noPolicyViolation;

  return { baseline, counterfactual: cf, delta, interpretation, gates, promotable, gateReasons };
}
