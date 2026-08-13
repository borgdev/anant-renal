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

export interface TimelineEntry {
  atMs: number; // ms since realm start
  presenceRole: string; // resolve to first-matching presence in the fresh realm
  effect: WorldEffect;
}

export interface Intervention {
  kind: 'nudge-preference';
  presenceRole: string; // apply to all presences with this role in the fresh realm
  effectKind: WorldEffect['kind'];
  delta: number;
}

export interface CounterfactualInput {
  build: () => Realm;
  timeline: TimelineEntry[];
  interventions: Intervention[];
  advanceTicks?: number; // extra idle ticks at end for ambient/attribution to settle
}

export interface RunReport {
  cost: ReturnType<Realm['cost']['rollup']>;
  hitl: { pending: number; approved: number; rejected: number };
  effects: { total: number; accepted: number; rejected: number };
  safety: { total: number; bySeverity: Record<string, number> };
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
    if (iv.kind !== 'nudge-preference') continue;
    const targets = realm.presences.list().filter((p) => p.role === iv.presenceRole);
    for (const t of targets) {
      realm.selfModel.nudgePreference(t.presenceId, iv.effectKind, iv.delta, 'counterfactual-intervention');
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

  return { baseline, counterfactual: cf, delta, interpretation };
}
