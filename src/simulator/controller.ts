/******************************************************************************
 * Simulator — SimulatorController.
 *
 * Owns a "scenario" as a fleet of realms and exposes the control surface the
 * rest of the app drives:
 *
 *   start()  — teardown any existing scenario, build the fleet from a
 *              SimScenario (realms → AcceleratedClock + populated facility +
 *              spawned role presences + ScriptedEventGenerator), and (when
 *              autoRun) start the realm clocks so ticks/events flow.
 *   pause()  — stop every realm clock (world freezes, state preserved).
 *   resume() — restart the clocks.
 *   step(n)  — advance every realm by n ticks deterministically (no clocks).
 *   reset()  — tear down the fleet (RealmRegistry.remove stops clocks) and
 *              return to idle. Idempotent and isolated to `sim:*` realm ids.
 *
 * The controller deliberately touches ONLY RealmRegistry + realm primitives
 * (no server routes, no storage), so it is unit-testable and reusable from
 * both the HTTP layer and a boot-time demo hook.
 ******************************************************************************/

import { AcceleratedClock, populateFacility, RealmRegistry, type Realm } from '../realm/index.js';
import { RealmHypergraph } from '../realm/hypergraph-bridge.js';
import { buildHealthcareHypergraphSchema } from '../../packs/healthcare-core/hypergraph.js';
import { ScriptedEventGenerator } from './script.js';
import { listScenarios, scenarioFor } from './scenarios.js';
import type { FleetPersistState, SimPace, SimRealmDef, SimRole, SimScenario, SimulatorSnapshot, SimulatorStatus } from './types.js';

export interface SimulatorStartOptions {
  /** When true (default) realm clocks start ticking immediately. Pass false to
   *  drive the fleet purely with step() (deterministic tests / previews). */
  autoRun?: boolean;
  /** Override the scenario's default pacing. */
  pace?: Partial<SimPace>;
}

export interface SimulatorControllerOptions {
  /** Called with each freshly-created realm + its scenario def (e.g. to attach the
   *  realm→broker bridge and persist the realm spec/snapshot). */
  onRealmCreated?: (realm: Realm, def: SimRealmDef) => void;
  /** Called whenever the fleet's persisted state changes (start/pause/resume/step/reset). */
  persistFleet?: (state: FleetPersistState) => void;
}

export class SimulatorController {
  private status: SimulatorStatus = 'idle';
  private scenario: SimScenario | null = null;
  private startedAt: string | null = null;
  private tickCount = 0;
  private eventCount = 0;
  private realmIds: string[] = [];
  /** Per-realm unsubscribe fns so reset() can detach counters cleanly. */
  private readonly subs = new Map<string, { clock: () => void; ledger: () => void }>();
  private readonly opts: SimulatorControllerOptions;

  constructor(opts: SimulatorControllerOptions = {}) {
    this.opts = opts;
  }

  get scenarioId(): string | null { return this.scenario?.id ?? null; }

  /** Live fleet realm ids (used by the persistence layer for periodic snapshots). */
  fleetRealmIds(): string[] { return [...this.realmIds]; }

  async start(scenarioId = 'dialysis-demo', startOpts: SimulatorStartOptions = {}): Promise<SimulatorSnapshot> {
    if (this.status === 'running') throw new Error('simulator-already-running: pause or reset first');
    this.reset();
    const sc = scenarioFor(scenarioId);
    if (!sc) throw new Error(`unknown-scenario: ${scenarioId} (have ${listScenarios().map((s) => s.id).join(', ')})`);
    this.scenario = sc;

    const pace: SimPace = {
      realmHoursPerTick: startOpts.pace?.realmHoursPerTick ?? sc.pace.realmHoursPerTick,
      wallMsPerTick: startOpts.pace?.wallMsPerTick ?? sc.pace.wallMsPerTick,
    };
    const autoRun = startOpts.autoRun ?? true;

    for (const def of sc.realms) {
      const realm = RealmRegistry.create({
        id: def.id,
        mode: 'sim',
        ...(def.trajectoryEngine ? { trajectoryEngine: def.trajectoryEngine } : {}),
        clock: new AcceleratedClock({
          startAt: sc.startAt,
          msPerTick: pace.wallMsPerTick,
          realmMsPerTick: Math.round(pace.realmHoursPerTick * 3_600_000),
        }),
        hypergraph: new RealmHypergraph(buildHealthcareHypergraphSchema(), def.id),
      });
      populateFacility(realm, def.facility);
      this.spawnPresences(realm, def.presences);
      if (def.script.entries.length) {
        realm.ambient.register(new ScriptedEventGenerator({ realm, script: def.script, seed: sc.seed }));
      }
      if (autoRun) realm.start();
      this.opts.onRealmCreated?.(realm, def);
      this.realmIds.push(def.id);
      // Count ticks/events from the real clock + ledger so the counters reflect
      // auto-run mode (not just step()), and detach them on reset().
      this.subs.set(def.id, {
        clock: realm.clock.subscribe(() => { this.tickCount += 1; }),
        ledger: realm.ledger.onAppend(() => { this.eventCount += 1; }),
      });
    }

    this.status = 'running';
    this.startedAt = new Date().toISOString();
    this.opts.persistFleet?.(this.fleetState());
    return this.snapshot();
  }

  /** The controller state the persistence layer serializes for boot-resume. */
  fleetState(): FleetPersistState {
    return {
      scenarioId: this.scenario?.id ?? '',
      status: this.status,
      startedAt: this.startedAt,
      tickCount: this.tickCount,
      eventCount: this.eventCount,
      realmIds: this.realmIds,
    };
  }

  /**
   * Re-wire the controller onto an already-restored fleet (process restart /
   * `tsx watch` reload). Realms were rebuilt from persisted specs/snapshots by
   * restoreRealmsFromSpecs; this re-attaches the scripted event generator, the
   * onRealmCreated side-effects (broker bridge + persistence), and the counter
   * subscriptions, then resumes the clocks if the fleet was running.
   */
  async adopt(state: FleetPersistState): Promise<SimulatorSnapshot> {
    if (this.status !== 'idle') return this.snapshot();
    const sc = scenarioFor(state.scenarioId);
    if (!sc) {
      this.status = 'idle';
      return this.snapshot();
    }
    this.scenario = sc;
    this.startedAt = state.startedAt;
    this.tickCount = state.tickCount;
    this.eventCount = state.eventCount;

    for (const id of state.realmIds) {
      const realm = RealmRegistry.get(id);
      if (!realm) continue; // realm wasn't restored (spec missing) — skip it
      const def = sc.realms.find((r) => r.id === id);
      // Re-attach the scripted event generator if the restored realm lacks it.
      if (def && def.script.entries.length && !realm.ambient.list().some((p) => p.id === 'sim.scripted-events')) {
        realm.ambient.register(new ScriptedEventGenerator({ realm, script: def.script, seed: sc.seed }));
      }
      // Re-attach the broker bridge + persistence side-effects (only when we know
      // the real scenario def — restored realms are already persisted).
      if (def) this.opts.onRealmCreated?.(realm, def);
      this.realmIds.push(id);
      this.subs.set(id, {
        clock: realm.clock.subscribe(() => { this.tickCount += 1; }),
        ledger: realm.ledger.onAppend(() => { this.eventCount += 1; }),
      });
    }

    this.status = state.status === 'running' ? 'running' : 'paused';
    if (this.status === 'running') {
      for (const id of this.realmIds) RealmRegistry.get(id)?.start();
    }
    this.opts.persistFleet?.(this.fleetState());
    return this.snapshot();
  }

  pause(): SimulatorSnapshot {
    if (this.status === 'idle') throw new Error('simulator-not-started');
    if (this.status === 'paused') return this.snapshot();
    for (const id of this.realmIds) RealmRegistry.get(id)?.stop();
    this.status = 'paused';
    this.opts.persistFleet?.(this.fleetState());
    return this.snapshot();
  }

  resume(): SimulatorSnapshot {
    if (this.status === 'idle') throw new Error('simulator-not-started');
    if (this.status === 'running') return this.snapshot();
    for (const id of this.realmIds) RealmRegistry.get(id)?.start();
    this.status = 'running';
    this.opts.persistFleet?.(this.fleetState());
    return this.snapshot();
  }

  /** Advance every realm by `ticks` realm-hours deterministically (no clocks needed). */
  step(ticks = 1): { tick: number; events: number; status: SimulatorStatus; snapshot: SimulatorSnapshot } {
    const realmHours = this.scenario?.pace.realmHoursPerTick ?? 1;
    const realmMs = Math.round(realmHours * 3_600_000);
    const realms = this.realmIds.map((id) => RealmRegistry.get(id)).filter((r): r is Realm => Boolean(r));
    const before = realms.reduce((n, r) => n + r.ledger.listAll().length, 0);
    for (let i = 0; i < ticks; i += 1) {
      for (const r of realms) r.clock.advanceBy(realmMs);
    }
    const after = realms.reduce((n, r) => n + r.ledger.listAll().length, 0);
    const events = Math.max(0, after - before);
    this.opts.persistFleet?.(this.fleetState());
    return { tick: this.tickCount, events, status: this.status, snapshot: this.snapshot() };
  }

  /** Tear the fleet down and return to idle. Idempotent. */
  reset(): void {
    for (const id of this.realmIds) {
      const sub = this.subs.get(id);
      if (sub) { sub.clock(); sub.ledger(); }
      this.subs.delete(id);
      const realm = RealmRegistry.get(id);
      if (realm) RealmRegistry.remove(id); // stops the clock + unsubscribes
    }
    this.realmIds = [];
    this.status = 'idle';
    this.scenario = null;
    this.startedAt = null;
    this.tickCount = 0;
    this.eventCount = 0;
    this.opts.persistFleet?.(this.fleetState());
  }

  snapshot(): SimulatorSnapshot {
    const realms = this.realmIds
      .map((id) => RealmRegistry.get(id))
      .filter((r): r is Realm => Boolean(r))
      .map((r) => {
        const s = r.snapshot();
        return {
          id: s.id,
          mode: s.mode,
          trajectoryEngine: r.trajectoryEngine,
          seq: s.seq,
          realmAt: s.realmAt,
          patients: s.counts.patient ?? 0,
          presences: s.presences,
          effects: s.effects,
          pendingApprovals: s.hitl?.pending ?? 0,
        };
      });
    return {
      status: this.status,
      scenario: this.scenario?.id ?? null,
      scenarioLabel: this.scenario?.label ?? null,
      pace: this.scenario ? { realmHoursPerTick: this.scenario.pace.realmHoursPerTick, wallMsPerTick: this.scenario.pace.wallMsPerTick } : null,
      startedAt: this.startedAt,
      tickCount: this.tickCount,
      eventCount: this.eventCount,
      totals: {
        realms: realms.length,
        patients: realms.reduce((n, r) => n + r.patients, 0),
        presences: realms.reduce((n, r) => n + r.presences, 0),
        effects: realms.reduce((n, r) => n + r.effects, 0),
      },
      realms,
    };
  }

  private spawnPresences(realm: Realm, roles: SimRole[]): void {
    const facility = realm.graph.listKind('facility')[0];
    const unit = realm.graph.listKind('unit')[0];
    const location: { facilityId: string; unitId?: string } = { facilityId: facility?.id ?? 'unknown' };
    if (unit) location.unitId = unit.id;
    for (const role of roles) {
      realm.presences.spawn({
        realmId: realm.id,
        agentSpecId: `sim.${role}`,
        runId: `sim.${role}`,
        role,
        clearance: 'restricted-phi',
        purposeOfUse: ['treatment'],
        location,
        perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
      });
    }
  }
}
