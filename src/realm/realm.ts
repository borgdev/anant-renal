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
import { ConsequenceAttributor } from './attribution.js';
import { HITLRegistry, DEFAULT_GATES, type HITLGate } from './hitl.js';
import { CostLedger } from './cost-ledger.js';
import { Planner, type Intent, type PlanGraph } from './planner.js';
import { OperatorSeat } from './operator-seat.js';
import { loadOrgPack, OrgGraphQuery, DIALYSIS_CLINIC_ORG_PACK, type OrgPack } from './org-graph.js';
import type { AgentPresence, EmittedEffect, EntityUrn, RealmId, RealmMode, WorldEffect } from './types.js';

export interface RealmOpts {
  id: RealmId;
  mode: RealmMode;
  clock?: Clock;
  authority?: EffectAuthorityMap;
  boundEffects?: Array<WorldEffect['kind']>;
  ambientProcesses?: AmbientProcess[];
  rules?: RulesEngine;
  hitlGates?: HITLGate[];
  orgPack?: OrgPack;
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
  readonly attribution: ConsequenceAttributor;
  readonly hitl: HITLRegistry;
  readonly cost: CostLedger;
  readonly planner: Planner;
  readonly operatorSeat: OperatorSeat;
  readonly orgQuery: OrgGraphQuery;
  private clockSub: (() => void) | undefined;
  private effectSub: (() => void) | undefined;
  // Intent → plan bookkeeping (planId -> PlanGraph)
  private plans = new Map<string, PlanGraph>();
  private intents = new Map<string, Intent>();

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
    this.attribution = new ConsequenceAttributor(this.ledger, this.episodes, this.selfModel);
    this.hitl = new HITLRegistry(this.graph, this.ledger);
    for (const g of opts.hitlGates ?? DEFAULT_GATES) this.hitl.registerGate(g);
    this.cost = new CostLedger(this.episodes, this.ledger);
    this.planner = new Planner();
    // Load org pack.
    loadOrgPack(this.graph, opts.orgPack ?? DIALYSIS_CLINIC_ORG_PACK);
    this.orgQuery = new OrgGraphQuery(this.graph);
    // Operator seat is constructed at the end after everything is wired.
    const bound = new Set(opts.boundEffects ?? []);
    this.reducer = new EffectReducer(this.graph, this.ledger, this.perception, this.clock, {
      mode: this.mode,
      boundEffects: bound,
      ...(opts.authority ? { authority: opts.authority } : {}),
      onEffectScheduled: (emitted) => this.ambient.onEffect(emitted, this.ambientContext()),
      hitl: {
        match: (p, e) => {
          const g = this.hitl.match(p, e);
          return g ? { id: g.id, reason: g.reason } : undefined;
        },
        suspend: (p, e, g) => {
          const gate = this.hitl.listGates().find((x) => x.id === g.id);
          if (!gate) throw new Error(`gate-not-found: ${g.id}`);
          const rec = this.hitl.suspend(p, e, gate);
          return { approvalId: rec.approvalId };
        },
      },
    });
    this.operatorSeat = new OperatorSeat(this);
    // When an approval is decided approved, re-emit the effect through the reducer
    // (this time HITL will skip it because the queue entry is no longer pending).
    this.hitl.onDecision((rec) => {
      if (rec.status !== 'approved') return;
      const presence = this.presences.get(rec.presenceId);
      if (!presence) return;
      // Temporarily bypass HITL for this exact re-emission.
      const original = this.reducer['opts'].hitl;
      (this.reducer['opts'] as { hitl?: unknown }).hitl = undefined;
      try { this.reducer.emit(presence, rec.effect); }
      finally { (this.reducer['opts'] as { hitl?: unknown }).hitl = original; }
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

  spawnPresence(init: Omit<PresenceInit, 'realmId'> & { realmId?: RealmId }): AgentPresence { return this.presences.spawn({ ...init, realmId: this.id }); }
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
      attribution: this.attribution.stats(),
      hitl: {
        gates: this.hitl.listGates().map((g) => ({ id: g.id, reason: g.reason })),
        pending: this.hitl.pending().length,
        all: this.hitl.all().length,
      },
      cost: this.cost.rollup(),
      plans: [...this.plans.values()].length,
      intents: [...this.intents.values()].length,
    };
  }

  /** Submit an intent and materialize a plan for it. Returns both. */
  async submitIntent(input: { intentKind: string; subjectRef?: string; description: string; priority: 'low' | 'normal' | 'high' | 'critical'; by: string }): Promise<{ intent: Intent; plan: PlanGraph }> {
    const intentId = `intent-${this.clock.seq}-${Math.random().toString(36).slice(2, 6)}`;
    const at = this.clock.realmAt.toISOString();
    const intent: Intent = {
      intentId,
      intentKind: input.intentKind,
      ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
      description: input.description,
      priority: input.priority,
      submittedAt: at,
      submittedBy: input.by,
    };
    this.intents.set(intentId, intent);
    // Persist as entity.
    this.graph.create('intent', intentId, { ...intent });
    const plan = await this.planner.plan(intent, this.graph);
    this.plans.set(plan.planId, plan);
    this.graph.create('plan', plan.planId, { ...plan });
    // link intent -> plan
    this.graph.addRelation(this.graph.urnFor('intent', intentId), 'has-plan', this.graph.urnFor('plan', plan.planId));
    return { intent, plan };
  }

  listIntents(): Intent[] { return [...this.intents.values()]; }
  listPlans(): PlanGraph[] { return [...this.plans.values()]; }
  getPlan(planId: string): PlanGraph | undefined { return this.plans.get(planId); }
}
