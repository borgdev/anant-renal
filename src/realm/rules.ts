// World Rules — the physics/policy layer of a realm. Rules watch the
// world and produce Experiences: typed, structured events that agents
// perceive as opportunities to act (and that the world itself uses to
// mutate entities without any agent's involvement).
//
// Two flavors, same contract (hybrid, as authored):
//   1. YAML rules — declarative when/then over entity attributes and
//      effect events. Deterministic, auditable.
//   2. TS module rules — code the runtime hot-registers. Any physics.
//
// Both emit `Experience` events to a bus. The runtime attaches them to
// the perception stream and (optionally) to a new episode.

import type { EmittedEffect, PerceivedEvent, WorldEffect } from './types.js';
import type { EntityGraph } from './entity-graph.js';

export type Experience = {
  experienceId: string;
  ruleId: string;
  ruleSource: 'yaml' | 'ts';
  kind: string; // e.g. 'hyperkalemia-detected', 'insurance-expiring'
  severity: 'info' | 'notice' | 'warning' | 'critical';
  subjectUrn?: string;
  facilityId?: string;
  unitId?: string;
  payload: Record<string, unknown>;
  producedAt: string;
};

// A YAML rule is a compact declarative object.
export interface YamlRuleSpec {
  id: string;
  description: string;
  on: 'effect' | 'attribute-change' | 'tick';
  when: {
    effectKind?: string;
    attrPath?: string; // e.g. 'K'
    compare?: { op: '>' | '<' | '=' | '>=' | '<='; value: number | string };
    entityKind?: string;
  };
  then: {
    experienceKind: string;
    severity: Experience['severity'];
    include?: Record<string, string>; // maps output field -> source expression like 'effect.value' or 'entity.state.K'
  };
}

// A TS rule is a function the runtime invokes with typed context.
export interface TsRule {
  id: string;
  description: string;
  onEffect?: (effect: EmittedEffect, ctx: RuleContext) => Experience[] | void;
  onTick?: (ctx: RuleContext) => Experience[] | void;
}

export interface RuleContext {
  graph: EntityGraph;
  now: string;
  emitExperience: (e: Experience) => void;
}

export class RulesEngine {
  private yaml: YamlRuleSpec[] = [];
  private ts: TsRule[] = [];
  private experiences: Experience[] = [];
  private subs: Array<(e: Experience) => void> = [];

  registerYaml(spec: YamlRuleSpec): void { this.yaml.push(spec); }
  registerTs(rule: TsRule): void { this.ts.push(rule); }

  subscribe(cb: (e: Experience) => void): () => void {
    this.subs.push(cb);
    return () => { this.subs = this.subs.filter((s) => s !== cb); };
  }

  list(): { yaml: readonly YamlRuleSpec[]; ts: Array<{ id: string; description: string }> } {
    return { yaml: this.yaml, ts: this.ts.map(({ id, description }) => ({ id, description })) };
  }

  history(): readonly Experience[] { return this.experiences; }

  onEffect(emitted: EmittedEffect, graph: EntityGraph): void {
    const ctx: RuleContext = { graph, now: new Date().toISOString(), emitExperience: (e) => this.publish(e) };
    // YAML rules over effects
    for (const r of this.yaml) {
      if (r.on !== 'effect') continue;
      if (r.when.effectKind && r.when.effectKind !== emitted.effect.kind) continue;
      if (r.when.compare && r.when.attrPath) {
        const raw = (emitted.effect as unknown as Record<string, unknown>)[r.when.attrPath];
        if (!matches(raw, r.when.compare)) continue;
      }
      const payload: Record<string, unknown> = {};
      for (const [k, expr] of Object.entries(r.then.include ?? {})) {
        payload[k] = resolveExpr(expr, { effect: emitted.effect });
      }
      this.publish({
        experienceId: `${r.id}-${emitted.effectId}`,
        ruleId: r.id,
        ruleSource: 'yaml',
        kind: r.then.experienceKind,
        severity: r.then.severity,
        payload,
        producedAt: ctx.now,
      });
    }
    // TS rules
    for (const r of this.ts) {
      if (!r.onEffect) continue;
      try {
        const out = r.onEffect(emitted, ctx);
        if (Array.isArray(out)) for (const e of out) this.publish(e);
      } catch { /* rule fault does not kill runtime */ }
    }
  }

  onTick(graph: EntityGraph): void {
    const ctx: RuleContext = { graph, now: new Date().toISOString(), emitExperience: (e) => this.publish(e) };
    for (const r of this.ts) {
      if (!r.onTick) continue;
      try {
        const out = r.onTick(ctx);
        if (Array.isArray(out)) for (const e of out) this.publish(e);
      } catch { /* ignore */ }
    }
  }

  private publish(e: Experience): void {
    this.experiences.push(e);
    for (const cb of this.subs) { try { cb(e); } catch { /* ignore */ } }
  }
}

function matches(raw: unknown, cmp: NonNullable<YamlRuleSpec['when']['compare']>): boolean {
  if (typeof raw === 'number' && typeof cmp.value === 'number') {
    switch (cmp.op) {
      case '>': return raw > cmp.value; case '<': return raw < cmp.value;
      case '>=': return raw >= cmp.value; case '<=': return raw <= cmp.value;
      case '=': return raw === cmp.value;
    }
  }
  if (typeof raw === 'string' && typeof cmp.value === 'string' && cmp.op === '=') return raw === cmp.value;
  return false;
}

function resolveExpr(expr: string, scope: Record<string, unknown>): unknown {
  // supports simple dotted paths like 'effect.value'
  const parts = expr.split('.');
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

// A tiny built-in rule pack so new realms have interesting physics
// immediately. Users can add YAML rules via API or Studio.
export const DEFAULT_YAML_RULES: YamlRuleSpec[] = [
  {
    id: 'hyperkalemia-critical',
    description: 'K+ > 6.5 raises a critical hyperkalemia experience',
    on: 'effect',
    when: { effectKind: 'result-lab', attrPath: 'code', compare: { op: '=', value: 'K' } },
    then: { experienceKind: 'hyperkalemia-suspected', severity: 'critical', include: { code: 'effect.code', value: 'effect.value' } },
  },
  {
    id: 'discharge-triggers-billing',
    description: 'Discharge produces a billing experience for the coder',
    on: 'effect',
    when: { effectKind: 'discharge-patient' },
    then: { experienceKind: 'ready-to-bill', severity: 'notice', include: { patientId: 'effect.patientId' } },
  },
];

export const DEFAULT_TS_RULES: TsRule[] = [
  {
    id: 'presence-acted',
    description: 'Broadcast a summarized coordination experience when any presence emits a hold-med, order-med, submit-claim, or flag-safety-event so peer agents can react without parsing raw effects.',
    onEffect: (emitted, ctx) => {
      const relevant = ['hold-med', 'order-med', 'flag-safety-event', 'submit-claim', 'transfer-patient', 'discharge-patient'];
      const k = emitted.effect.kind;
      if (!relevant.includes(k)) return;
      const patientId = (emitted.effect as { patientId?: string }).patientId;
      const subjectUrn = patientId ? ctx.graph.urnFor('patient', patientId) : undefined;
      return [{
        experienceId: `presence-acted-${emitted.effectId}`,
        ruleId: 'presence-acted',
        ruleSource: 'ts',
        kind: 'presence-acted',
        severity: k === 'flag-safety-event' ? 'critical' : 'notice',
        ...(subjectUrn ? { subjectUrn } : {}),
        payload: { effectId: emitted.effectId, actorPresenceId: emitted.presenceId, actorSpecId: emitted.agentSpecId, actionKind: k, patientId },
        producedAt: emitted.realmAt,
      }];
    },
  },
  {
    id: 'insurance-expiring',
    description: 'Insurance policies with expiresAt within 5 days emit a warning on tick',
    onTick: (ctx) => {
      const soon = Date.now() + 5 * 24 * 60 * 60 * 1000;
      const out: Experience[] = [];
      for (const rec of ctx.graph.listKind('insurance')) {
        const st = rec.state as { expiresAt?: string; patientId?: string };
        if (!st.expiresAt) continue;
        const t = Date.parse(st.expiresAt);
        if (t <= soon) out.push({ experienceId: `insurance-exp-${rec.id}-${Date.now()}`, ruleId: 'insurance-expiring', ruleSource: 'ts', kind: 'insurance-expiring', severity: 'warning', subjectUrn: ctx.graph.urnFor('insurance', rec.id), payload: { patientId: st.patientId, expiresAt: st.expiresAt }, producedAt: ctx.now });
      }
      return out;
    },
  },
];

export function createDefaultEngine(): RulesEngine {
  const e = new RulesEngine();
  for (const r of DEFAULT_YAML_RULES) e.registerYaml(r);
  for (const r of DEFAULT_TS_RULES) e.registerTs(r);
  return e;
}

// Type re-exports used by the runtime bridge
export type { PerceivedEvent, WorldEffect };
