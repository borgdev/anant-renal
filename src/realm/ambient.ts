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

// AmbientProcessRegistry — the reason the world feels alive.
//
// Between agent turns, ambient processes tick and mutate the world:
// labs mature, meds metabolize, patients drift along trajectories,
// insurance clocks count down. These processes fire off the Realm clock.

import type { EntityGraph } from './entity-graph.js';
import type { EffectLedger } from './effect-ledger.js';
import type { PerceptionRouter } from './perception.js';
import type { Clock } from './clock.js';
import type { AgentPresence, ClockTick, EmittedEffect, EntityUrn, WorldEffect } from './types.js';

export interface AmbientProcess {
  id: string;
  description: string;
  onTick(ctx: AmbientContext): void;
  onEffect?(effect: EmittedEffect, ctx: AmbientContext): void;
}

export interface AmbientContext {
  clock: Clock;
  graph: EntityGraph;
  ledger: EffectLedger;
  router: PerceptionRouter;
  applySystemEffect(effect: WorldEffect, presence: AgentPresence): EmittedEffect;
}

export class AmbientProcessRegistry {
  private processes = new Map<string, AmbientProcess>();

  register(p: AmbientProcess): void { this.processes.set(p.id, p); }
  unregister(id: string): void { this.processes.delete(id); }
  list(): AmbientProcess[] { return [...this.processes.values()]; }

  tick(ctx: AmbientContext, _tick: ClockTick): void {
    for (const p of this.processes.values()) {
      try { p.onTick(ctx); } catch (err) { /* swallow — process failure shouldn't halt realm */ }
    }
  }

  onEffect(effect: EmittedEffect, ctx: AmbientContext): void {
    for (const p of this.processes.values()) {
      if (!p.onEffect) continue;
      try { p.onEffect(effect, ctx); } catch (err) { /* swallow */ }
    }
  }
}

// ---------- Concrete ambient processes ----------

// Lab maturation — when an order-lab effect is emitted, schedule a result
// after the priority-appropriate turnaround. Values are drawn from a
// simple physiological model tied to the patient's trajectory state.
export class LabMaturationProcess implements AmbientProcess {
  id = 'lab.maturation';
  description = 'Ordered labs mature into results after realistic turnaround, driven by the patient trajectory.';
  private queue: Array<{ dueAtSeq: number; orderId: string; code: string; patientId: string; systemPresence: AgentPresence }> = [];

  onEffect(effect: EmittedEffect, ctx: AmbientContext): void {
    if (effect.effect.kind !== 'order-lab') return;
    const e = effect.effect;
    const ticksToMature = e.priority === 'stat' ? 1 : e.priority === 'routine' ? 4 : 24;
    const dueAtSeq = ctx.clock.seq + ticksToMature;
    // Reuse the presence that emitted the order as the "system" presence for the ambient result
    // In practice this would be a system-level presence; here we mint a synthetic one.
    const systemPresence: AgentPresence = {
      presenceId: `system-lab-${effect.effectId}`,
      realmId: 'system', agentSpecId: 'system.lab-maturation', runId: 'system',
      role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: (ctx.graph.get(`urn:realm:${(ctx.graph as unknown as { realmId: string }).realmId ?? 'sys'}:patient:${e.patientId}` as EntityUrn)?.state as { facilityId?: string })?.facilityId ?? 'unknown' },
      perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] }, attention: 'active', spawnedAt: new Date().toISOString(),
    };
    // Derive orderId as reducer does
    const orderId = `${e.patientId}-${e.code}-${effect.realmAt.length}`; // best-effort id
    // Simpler: look up the freshly-created order via graph mutations
    const mut = effect.mutations?.[0];
    const realOrderId = mut ? (mut.urn.split(':').pop() ?? orderId) : orderId;
    this.queue.push({ dueAtSeq, orderId: realOrderId, code: e.code, patientId: e.patientId, systemPresence });
  }

  onTick(ctx: AmbientContext): void {
    const ready = this.queue.filter((q) => q.dueAtSeq <= ctx.clock.seq);
    this.queue = this.queue.filter((q) => q.dueAtSeq > ctx.clock.seq);
    for (const item of ready) {
      const patientUrn = `urn:realm:${(ctx.graph as unknown as { realmId: string }).realmId}:patient:${item.patientId}` as EntityUrn;
      const patient = ctx.graph.get(patientUrn);
      const trajectory = (patient?.state as { trajectory?: string })?.trajectory ?? 'stable';
      const { value, unit, abnormal } = draw(item.code, trajectory);
      ctx.applySystemEffect(
        { kind: 'result-lab', orderId: item.orderId, code: item.code, value, unit, ...(abnormal ? { abnormal } : {}) } as WorldEffect,
        item.systemPresence,
      );
    }
  }
}

function draw(code: string, trajectory: string): { value: number; unit: string; abnormal?: 'H' | 'L' | 'HH' | 'LL' | 'A' } {
  // Tiny physiological model — enough to be interesting, honest about being illustrative.
  const jitter = (base: number, spread: number) => base + (Math.random() - 0.5) * spread * 2;
  switch (code) {
    case 'K': {
      const base = trajectory === 'decompensating' ? 5.8 : 4.2;
      const v = Number(jitter(base, 0.4).toFixed(1));
      return { value: v, unit: 'mmol/L', ...(v > 5.5 ? { abnormal: 'H' as const } : v < 3.5 ? { abnormal: 'L' as const } : {}) };
    }
    case 'HGB': {
      const base = trajectory === 'anemic-worsening' ? 8.5 : trajectory === 'anemic-recovering' ? 10.5 : 11.5;
      const v = Number(jitter(base, 0.4).toFixed(1));
      return { value: v, unit: 'g/dL', ...(v < 10 ? { abnormal: 'L' as const } : {}) };
    }
    case 'URR': {
      const base = trajectory === 'underdialyzed' ? 62 : 70;
      const v = Math.round(jitter(base, 3));
      return { value: v, unit: '%', ...(v < 65 ? { abnormal: 'L' as const } : {}) };
    }
    case 'PHOS': {
      const base = trajectory === 'hyperphosphatemia' ? 6.5 : 4.8;
      const v = Number(jitter(base, 0.6).toFixed(1));
      return { value: v, unit: 'mg/dL', ...(v > 5.5 ? { abnormal: 'H' as const } : {}) };
    }
    default: {
      const v = Number(jitter(50, 20).toFixed(1));
      return { value: v, unit: 'unit' };
    }
  }
}

// Patient trajectory — drifts vitals over time based on trajectory state.
export class PatientTrajectoryProcess implements AmbientProcess {
  id = 'patient.trajectory';
  description = 'Patient vitals drift toward the underlying trajectory over realm time.';
  private tickCounter = 0;

  onTick(ctx: AmbientContext): void {
    this.tickCounter += 1;
    if (this.tickCounter % 4 !== 0) return; // every 4th tick to keep noise down
    const patients = ctx.graph.listKind('patient');
    for (const p of patients) {
      const st = p.state as { trajectory?: string; lastVitals?: { hr?: number; spo2?: number; bp?: string } };
      if (!st.trajectory || st.trajectory === 'stable') continue;
      const nextHr = (st.lastVitals?.hr ?? 78) + (st.trajectory === 'decompensating' ? 3 : st.trajectory === 'recovering' ? -1 : 0);
      const nextSpO2 = Math.max(80, Math.min(100, (st.lastVitals?.spo2 ?? 97) + (st.trajectory === 'decompensating' ? -1 : 0)));
      ctx.graph.patch(p.urn, { lastVitals: { ...(st.lastVitals ?? {}), hr: nextHr, spo2: nextSpO2, at: ctx.clock.realmAt.toISOString() } }, 'ambient:trajectory');
      const facilityId = (st as { facilityId?: string }).facilityId;
      ctx.router.broadcast({
        kind: 'ambient.vitals-drift',
        entityUrn: p.urn, entityKind: 'patient', entityId: p.id,
        ...(facilityId ? { facilityId } : {}),
        payload: { hr: nextHr, spo2: nextSpO2, trajectory: st.trajectory },
        realmAt: ctx.clock.realmAt.toISOString(),
      });
    }
  }
}

// Insurance clock — decrements days-remaining on prior-auth and claim entities;
// emits threshold events at 5d, 1d, 0d.
export class InsuranceClockProcess implements AmbientProcess {
  id = 'insurance.clock';
  description = 'Prior-auth and claim deadlines tick down; threshold events radiate at 5d, 1d, 0d.';
  private ticksPerDay = 24; // assumes hourly ticks in sim; adjust as needed

  onTick(ctx: AmbientContext): void {
    if (ctx.clock.seq % this.ticksPerDay !== 0) return;
    const items = ctx.graph.listKind('insurance');
    for (const item of items) {
      const st = item.state as { kind?: string; status?: string; daysRemaining?: number };
      if (!['prior-auth', 'claim'].includes(st.kind ?? '')) continue;
      if (st.status === 'approved' || st.status === 'paid' || st.status === 'denied') continue;
      const current = st.daysRemaining ?? (st.kind === 'prior-auth' ? 14 : 90);
      const next = current - 1;
      ctx.graph.patch(item.urn, { daysRemaining: next }, 'ambient:insurance-clock');
      if ([5, 1, 0].includes(next)) {
        ctx.router.broadcast({
          kind: 'ambient.insurance-deadline',
          entityUrn: item.urn, entityKind: 'insurance', entityId: item.id,
          payload: { daysRemaining: next, kind: st.kind },
          realmAt: ctx.clock.realmAt.toISOString(),
        });
      }
    }
  }
}
