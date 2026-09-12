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
import { EffectReducer, DEFAULT_AUTHORITY, type EffectAuthorityMap, type EmitOpts } from './effect-reducer.js';
import type { RealmHypergraph } from './hypergraph-bridge.js';
import { AmbientProcessRegistry, type AmbientContext, type AmbientProcess, LabMaturationProcess, PatientTrajectoryProcess, InsuranceClockProcess } from './ambient.js';
import { EpisodeStore } from './episode.js';
import { SelfModelRegistry } from './self-model.js';
import { createDefaultEngine, RulesEngine } from './rules.js';
import { ConsequenceAttributor } from './attribution.js';
import { HITLRegistry, DEFAULT_GATES, type HITLGate } from './hitl.js';
import { CostLedger } from './cost-ledger.js';
import { Planner, type Intent, type PlanGraph, type PlanStep } from './planner.js';
import { PlanRunner, type PlanRunOutcome } from './plan-runner.js';
import { PolicyRuntime } from './policy.js';
import { OperatorSeat } from './operator-seat.js';
import { loadOrgPack, OrgGraphQuery, DIALYSIS_CLINIC_ORG_PACK, type OrgPack } from './org-graph.js';
import type { AgentPresence, EmittedEffect, EntityUrn, RealmId, RealmMode, WorldEffect } from './types.js';
import { TrajectoryAmbientProcess } from '../liquid/trajectory.js';
import { makeRegimeRule } from '../liquid/regime.js';
import type { TrajectoryEngine } from '../liquid/types.js';

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
  /** Patient-trajectory engine: `legacy` (hand-authored physiology, default) or `liquid` (learned CfC/LTC via WASM). */
  trajectoryEngine?: TrajectoryEngine;
  /** Optional live hypergraph bridge (Phase 1b) — populated by every emitted effect. */
  hypergraph?: RealmHypergraph;
}

export class Realm {
  readonly id: RealmId;
  readonly mode: RealmMode;
  readonly trajectoryEngine: TrajectoryEngine | undefined;
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
  readonly planRunner: PlanRunner;
  readonly policy: PolicyRuntime;
  readonly operatorSeat: OperatorSeat;
  readonly orgQuery: OrgGraphQuery;
  /** Live hypergraph projection. Mutable so a realm can be populated first and
   *  projected once (see Realm.attachHypergraph). */
  hypergraph: RealmHypergraph | undefined;
  private clockSub: (() => void) | undefined;
  private effectSub: (() => void) | undefined;
  // Intent → plan bookkeeping (planId -> PlanGraph)
  private plans = new Map<string, PlanGraph>();
  private intents = new Map<string, Intent>();

  constructor(opts: RealmOpts) {
    this.id = opts.id;
    this.mode = opts.mode;
    this.trajectoryEngine = opts.trajectoryEngine;
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
    // Liquid hypergraph mechanic (Phase 8): when the realm runs the liquid engine, watch each
    // patient's dynamical regime and surface transitions as Experiences agents can perceive.
    if (opts.trajectoryEngine === 'liquid') this.rules.registerTs(makeRegimeRule());
    this.attribution = new ConsequenceAttributor(this.ledger, this.episodes, this.selfModel);
    this.hitl = new HITLRegistry(this.graph, this.ledger);
    for (const g of opts.hitlGates ?? DEFAULT_GATES) this.hitl.registerGate(g);
    this.cost = new CostLedger(this.episodes, this.ledger);
    this.planner = new Planner();
    this.policy = new PolicyRuntime(this.selfModel);
    this.planRunner = new PlanRunner({
      resolveExecutor: (step: PlanStep) => this.presences.list().find((p) => p.role === step.ownerRole),
      emit: (presenceId, effect) => this.emit(presenceId, effect),
      nowIso: () => this.clock.realmAt.toISOString(),
      audit: (planId, stepId, outcome, note) => {
        // Use the first admin presence as the audit emitter; fall back to any presence.
        const admin = this.presences.list().find((p) => p.role === 'admin') ?? this.presences.list()[0];
        if (!admin) return;
        this.reducer.emit(admin, { kind: 'advance-plan', planId, stepId, outcome, ...(note ? { note } : {}) });
      },
    });
    // Load org pack.
    loadOrgPack(this.graph, opts.orgPack ?? DIALYSIS_CLINIC_ORG_PACK);
    this.orgQuery = new OrgGraphQuery(this.graph);
    // Operator seat is constructed at the end after everything is wired.
    const bound = new Set(opts.boundEffects ?? []);
    this.hypergraph = opts.hypergraph;
    this.reducer = new EffectReducer(this.graph, this.ledger, this.perception, this.clock, {
      mode: this.mode,
      boundEffects: bound,
      ...(opts.authority ? { authority: opts.authority } : {}),
      ...(opts.hypergraph ? { hypergraph: opts.hypergraph } : {}),
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

    for (const p of opts.ambientProcesses ?? this.defaultAmbient(opts.trajectoryEngine)) this.ambient.register(p);

    this.arm();
    // Feed effects into the rules engine to produce Experiences.
    // Route Experiences into perception so agents can react to them.
    this.rules.subscribe((exp) => {
      this.perception.broadcast({ kind: `experience.${exp.kind}`, payload: exp as unknown as Record<string, unknown>, ...(exp.subjectUrn ? { entityUrn: exp.subjectUrn as EntityUrn } : {}), realmAt: exp.producedAt });
    });
    // Expose realmId on graph for ambient processes to reference (used by lab maturation).
    (this.graph as unknown as { realmId: string }).realmId = this.id;
  }

  /**
   * Arm the clock→ambient/rules pipeline and the ledger→rules feed.
   *
   * Idempotent, and deliberately called from BOTH the constructor and `start()`.
   *
   * `stop()` tears these down (so a removed realm's subscriptions do not pin it in
   * memory), but `start()` used to restart only the clock — so a single
   * pause/resume cycle left the clock ticking with nothing consuming it. The realm
   * looked alive: the tick counter climbed, while every ambient process (lab
   * maturation, patient trajectory, the insurance clock) and `rules.onTick` were
   * permanently dead. A resumed simulator therefore produced no clinical data at
   * all, and every page derived from it silently froze.
   */
  private arm(): void {
    if (this.clockSub) return;
    this.clockSub = this.clock.subscribe((tick) => {
      this.ambient.tick(this.ambientContext(), tick);
      this.rules.onTick(this.graph);
      this.perception.broadcast({ kind: 'clock.tick', payload: { seq: tick.seq, realmAt: tick.realmAt, deltaMs: tick.deltaMs }, realmAt: tick.realmAt });
    });
    this.effectSub = this.ledger.onAppend((emitted) => {
      this.rules.onEffect(emitted, this.graph);
    });
  }

  private defaultAmbient(engine: TrajectoryEngine = 'legacy'): AmbientProcess[] {
    const trajectory = engine === 'liquid' ? new TrajectoryAmbientProcess() : new PatientTrajectoryProcess();
    return [new LabMaturationProcess(), trajectory, new InsuranceClockProcess()];
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

  emit(presenceId: string, effect: WorldEffect, opts: EmitOpts = {}): EmittedEffect {
    const presence = this.presences.get(presenceId);
    if (!presence) throw new Error(`presence-not-found: ${presenceId}`);
    return this.reducer.emit(presence, effect, opts);
  }

  subscribe(presenceId: string, cb: (evt: import('./types.js').PerceivedEvent) => void): () => void {
    return this.perception.subscribe(presenceId, cb);
  }

  /**
   * Start the clock AND re-arm the pipelines that consume it.
   *
   * The re-arm is the point: `stop()` cancels both subscriptions, so a bare
   * `clock.start()` here would leave a ticking clock with no ambient processes and
   * no rules — see `arm()`.
   */
  start(): void { this.clock.start(); this.arm(); }

  /** Stop the clock and detach its subscriptions (a stopped realm holds no timers). */
  stop(): void { this.clock.stop(); if (this.clockSub) { this.clockSub(); this.clockSub = undefined; } if (this.effectSub) { this.effectSub(); this.effectSub = undefined; } }

  /**
   * Attach the live hypergraph projection and bring the EXISTING entity graph
   * into it. Realm creation populates patients, replays their longitudinal
   * history, and only then attaches the projection: projecting every historical
   * effect is ~140x the cost of syncing the finished graph once, and the
   * projection is a materialised view either way.
   */
  attachHypergraph(hypergraph: RealmHypergraph): { nodes: number; edges: number } {
    this.hypergraph = hypergraph;
    this.reducer.attachHypergraph(hypergraph);
    return hypergraph.syncEntityGraph(this.graph);
  }

  snapshot() {
    return {
      id: this.id,
      mode: this.mode,
      trajectoryEngine: this.trajectoryEngine,
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

  /** Execute a plan (M13.A). Advances all steps whose deps are satisfied until the plan
   * is complete, aborted, blocked, or all remaining steps are suspended in HITL. */
  runPlan(planId: string): PlanRunOutcome[] {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`plan-not-found:${planId}`);
    return this.planRunner.runAll(plan);
  }

  /** Step a plan by one ready action — useful for turn-by-turn execution in tests/UIs. */
  stepPlan(planId: string): PlanRunOutcome {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`plan-not-found:${planId}`);
    return this.planRunner.step(plan);
  }
}
