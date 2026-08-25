/******************************************************************************
 * Simulator — ScriptedEventGenerator.
 *
 * An `AmbientProcess` that turns a declarative `SimScript` into real
 * `WorldEffect`s on a realm-time schedule. Effects are emitted through real
 * realm presences (so authority + HITL gates actually run) and flow through
 * the normal write path: EffectReducer → ledger → hypergraph → rules →
 * experiences → perception, and (via the realm-event bridge) → canonical
 * events → outbox/broker/webhooks → the exec console's event feed.
 *
 * Scheduling is realm-time based and deterministic:
 *   • atHour      — fire once after the realm clock passes that realm-hour.
 *   • everyHours  — fire every N realm-hours (accumulating; never skipped).
 * Both use the scenario-seeded RNG, so a scenario replays identically.
 ******************************************************************************/

import type { AmbientContext, AmbientProcess } from '../realm/ambient.js';
import type { AgentPresence } from '../realm/types.js';
import { mulberry32 } from './rng.js';
import type { SimRole, SimScript, ScriptEmitInput } from './types.js';

export interface ScriptedEventGeneratorOptions {
  realm: import('../realm/realm.js').Realm;
  script: SimScript;
  seed?: number;
}

export class ScriptedEventGenerator implements AmbientProcess {
  id = 'sim.scripted-events';
  description = 'Emits scripted WorldEffects on a realm-time schedule (labs, vitals, assessments, claims, safety flags, follow-ups).';

  private readonly realm: import('../realm/realm.js').Realm;
  private readonly script: SimScript;
  private readonly rng: () => number;
  private readonly startMs: number;
  private readonly lastFired = new Map<string, number>();
  private readonly firedOnce = new Set<string>();
  private readonly presences = new Map<string, AgentPresence | null>();
  /** Counters for observability (per entry). */
  private readonly firedCount = new Map<string, number>();
  private readonly rejectedCount = new Map<string, number>();

  constructor(opts: ScriptedEventGeneratorOptions) {
    this.realm = opts.realm;
    this.script = opts.script;
    this.rng = mulberry32(opts.seed ?? 1);
    this.startMs = opts.realm.clock.realmAt.getTime();
  }

  /** Per-entry fire counts — used by tests/status to prove the script ran. */
  get counts(): Record<string, { fired: number; rejected: number }> {
    const out: Record<string, { fired: number; rejected: number }> = {};
    for (const e of this.script.entries) {
      out[e.id] = { fired: this.firedCount.get(e.id) ?? 0, rejected: this.rejectedCount.get(e.id) ?? 0 };
    }
    return out;
  }

  onTick(ctx: AmbientContext): void {
    const realm = this.realm;
    const elapsedHours = (ctx.clock.realmAt.getTime() - this.startMs) / 3_600_000;
    const patientIds = realm.graph.listKind('patient').map((p) => p.id);

    for (const entry of this.script.entries) {
      if (!this.shouldFire(entry, elapsedHours)) continue;
      let effects;
      try {
        effects = entry.emit({ realm, patientIds, rng: this.rng, realmAt: ctx.clock.realmAt, seq: ctx.clock.seq, elapsedHours });
      } catch {
        this.rejectedCount.set(entry.id, (this.rejectedCount.get(entry.id) ?? 0) + 1);
        continue;
      }
      if (!effects || effects.length === 0) continue;
      this.firedCount.set(entry.id, (this.firedCount.get(entry.id) ?? 0) + 1);
      for (const effect of effects) this.#emitVia(realm, entry.viaRole, effect);
    }
  }

  private shouldFire(entry: SimScript['entries'][number], elapsedHours: number): boolean {
    if (entry.atHour !== undefined) {
      if (this.firedOnce.has(entry.id)) return false;
      if (elapsedHours >= entry.atHour) {
        this.firedOnce.add(entry.id);
        return true;
      }
      return false;
    }
    if (entry.everyHours !== undefined) {
      const last = this.lastFired.get(entry.id) ?? 0; // 0 = scenario start hour
      if (elapsedHours - last >= entry.everyHours - 1e-9) {
        this.lastFired.set(entry.id, elapsedHours);
        return true;
      }
    }
    return false;
  }

  #emitVia(realm: import('../realm/realm.js').Realm, role: SimRole, effect: import('../realm/types.js').WorldEffect): void {
    let presence = this.presences.get(role);
    if (presence === undefined) {
      presence = realm.presences.list().find((p) => p.role === role) ?? null;
      this.presences.set(role, presence);
    }
    if (!presence) return;
    try {
      realm.emit(presence.presenceId, effect);
    } catch {
      // Authority/HITL may reject a specific effect (e.g. an unbound kind in twin
      // mode). The demo is resilient: count it and keep the schedule moving.
      const entry = this.script.entries.find((e) => e.viaRole === role);
      if (entry) this.rejectedCount.set(entry.id, (this.rejectedCount.get(entry.id) ?? 0) + 1);
    }
  }
}
