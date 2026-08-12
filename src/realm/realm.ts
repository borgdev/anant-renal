// Realm — a running, tickable world.
//
// Composes clock, entity graph, ledger, presence registry, perception router,
// effect reducer, and ambient process registry into one addressable instance.

import { randomUUID } from 'node:crypto';
import { AcceleratedClock, WallClock, type Clock } from './clock.js';
import { EntityGraph } from './entity-graph.js';
import { EffectLedger } from './effect-ledger.js';
import { PresenceRegistry, type PresenceInit } from './presence.js';
import { PerceptionRouter } from './perception.js';
import { EffectReducer, DEFAULT_AUTHORITY, type EffectAuthorityMap } from './effect-reducer.js';
import { AmbientProcessRegistry, type AmbientContext, type AmbientProcess, LabMaturationProcess, PatientTrajectoryProcess, InsuranceClockProcess } from './ambient.js';
import { EpisodeStore } from './episode.js';
import { SelfModelRegistry } from './self-model.js';
import { createDefaultEngine, RulesEngine } from './rules.js';
import type { AgentPresence, EmittedEffect, EntityUrn, RealmId, RealmMode, WorldEffect } from './types.js';

export interface RealmOpts {
  id: RealmId;
  mode: RealmMode;
  clock?: Clock;
  authority?: EffectAuthorityMap;
  boundEffects?: Array<WorldEffect['kind']>;
  ambientProcesses?: AmbientProcess[];
  rules?: RulesEngine;
}

export class Realm {
  readonly id: RealmId;
  readonly mode: RealmMode;
  readonly clock: Clock;
  readonly graph: EntityGraph;
  readonly ledger: EffectLedger;
  readonly presences: PresenceRegistry;
  readonly perception: PerceptionRouter;
  readonly reducer: EffectReducer;
  readonly ambient: AmbientProcessRegistry;
  readonly episodes: EpisodeStore;
  readonly selfModel: SelfModelRegistry;
  readonly rules: RulesEngine;
  private clockSub: (() => void) | undefined;
  private effectSub: (() => void) | undefined;

  constructor(opts: RealmOpts) {
    this.id = opts.id;
    this.mode = opts.mode;
    this.clock = opts.clock ?? (opts.mode === 'sim'
      ? new AcceleratedClock({ msPerTick: 50, realmMsPerTick: 60 * 60 * 1000 }) // 1 hour of realm per 50ms
      : new WallClock({ intervalMs: 1000 }));
    this.graph = new EntityGraph(this.id);
    this.ledger = new EffectLedger();
    this.presences = new PresenceRegistry();
    this.perception = new PerceptionRouter(this.presences);
    this.ambient = new AmbientProcessRegistry();
    this.episodes = new EpisodeStore();
    this.selfModel = new SelfModelRegistry();
    this.rules = opts.rules ?? createDefaultEngine();
    const bound = new Set(opts.boundEffects ?? []);
    this.reducer = new EffectReducer(this.graph, this.ledger, this.perception, this.clock, {
      mode: this.mode,
      boundEffects: bound,
      ...(opts.authority ? { authority: opts.authority } : {}),
      onEffectScheduled: (emitted) => this.ambient.onEffect(emitted, this.ambientContext()),
    });

    for (const p of opts.ambientProcesses ?? this.defaultAmbient()) this.ambient.register(p);

    this.clockSub = this.clock.subscribe((tick) => {
      this.ambient.tick(this.ambientContext(), tick);
      this.rules.onTick(this.graph);
      this.perception.broadcast({ kind: 'clock.tick', payload: { seq: tick.seq, realmAt: tick.realmAt, deltaMs: tick.deltaMs }, realmAt: tick.realmAt });
    });
    // Feed effects into the rules engine to produce Experiences.
    this.effectSub = this.ledger.onAppend((emitted) => {
      this.rules.onEffect(emitted, this.graph);
    });
    // Route Experiences into perception so agents can react to them.
    this.rules.subscribe((exp) => {
      this.perception.broadcast({ kind: `experience.${exp.kind}`, payload: exp as unknown as Record<string, unknown>, ...(exp.subjectUrn ? { entityUrn: exp.subjectUrn as EntityUrn } : {}), realmAt: exp.producedAt });
    });
    // Expose realmId on graph for ambient processes to reference (used by lab maturation).
    (this.graph as unknown as { realmId: string }).realmId = this.id;
  }

  private defaultAmbient(): AmbientProcess[] {
    return [new LabMaturationProcess(), new PatientTrajectoryProcess(), new InsuranceClockProcess()];
  }

  private ambientContext(): AmbientContext {
    return {
      clock: this.clock,
      graph: this.graph,
      ledger: this.ledger,
      router: this.perception,
      applySystemEffect: (effect: WorldEffect, presence: AgentPresence) => this.reducer.emit(presence, effect),
    };
  }

  spawnPresence(init: PresenceInit): AgentPresence { return this.presences.spawn({ ...init, realmId: this.id }); }
  movePresence(presenceId: string, location: Partial<AgentPresence['location']>): AgentPresence { return this.presences.move(presenceId, location); }
  retirePresence(presenceId: string): void { this.presences.retire(presenceId); }

  emit(presenceId: string, effect: WorldEffect): EmittedEffect {
    const presence = this.presences.get(presenceId);
    if (!presence) throw new Error(`presence-not-found: ${presenceId}`);
    return this.reducer.emit(presence, effect);
  }

  subscribe(presenceId: string, cb: (evt: import('./types.js').PerceivedEvent) => void): () => void {
    return this.perception.subscribe(presenceId, cb);
  }

  start(): void { this.clock.start(); }
  stop(): void { this.clock.stop(); if (this.clockSub) { this.clockSub(); this.clockSub = undefined; } if (this.effectSub) { this.effectSub(); this.effectSub = undefined; } }

  snapshot() {
    return {
      id: this.id,
      mode: this.mode,
      seq: this.clock.seq,
      realmAt: this.clock.realmAt.toISOString(),
      counts: this.graph.snapshot().countsByKind,
      presences: this.presences.list().length,
      effects: this.ledger.listAll().length,
      recentEffects: this.ledger.listAll().slice(-25),
      recentPerception: this.perception.recentLog(50),
      episodes: this.episodes.stats(),
      experiences: this.rules.history().slice(-25),
      rules: this.rules.list(),
    };
  }
}
