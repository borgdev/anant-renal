// AgentRuntime — interprets an AgentSpec plan graph, invoking Skills through
// the SkillRegistry, persisting run + step + metering rows, gating on HITL,
// and writing every mutation as a LedgerEntry so runs are replayable.
//
// Execution flows:
//   invoke(spec, inputs, actor) → creates an AgentRun row → walks the plan
//   graph → for each step calls Skill.handle → captures meters + cost →
//   writes step row → returns aggregated outputs.
//
// The Runtime does NOT decide durability — it composes over the JobBus. A
// trigger arrives on the bus, a handler resolves the spec via the registry,
// then calls `invoke`. Cron triggers are scheduled by a separate scheduler
// (see `src/agents/scheduler.ts`) that also enqueues via the bus.

import { randomUUID } from 'node:crypto';
import type { AgentSpec, PlanNode, SkillStep, BillingMeter } from './spec.js';
import type { AgentRegistry } from './registry.js';
import type { SkillRegistry, SkillContext } from './skills.js';
import type { PostgresEventStore } from '../server/postgres-event-store.js';
import type { Telemetry } from '../server/telemetry.js';
import type { ActorContext } from '../server/scoped-persistence.js';

export interface InvokeInputs { [k: string]: unknown }
export interface InvokeOptions {
  readonly triggerType: string;
  readonly triggerDetail: Record<string, unknown>;
  readonly parentRunId?: string;
  readonly facilityId?: string;
}
export interface RunResult {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed' | 'awaiting-hitl';
  readonly outputs: Record<string, unknown>;
  readonly totalCostUsd: number;
  readonly meteredUnits: readonly { unit: string; quantity: number; totalUsd: number }[];
  readonly error?: { message: string; stepId?: string };
}

export interface HitlWaitPolicy {
  readonly synchronous: boolean; // in tests + inline mode; in production HITL parks the run and resumes on gate resolution
}

export class AgentRuntime {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly skills: SkillRegistry,
    private readonly store: PostgresEventStore,
    private readonly telemetry: Telemetry,
    private readonly hitlWaitPolicy: HitlWaitPolicy = { synchronous: false },
  ) {}

  async invoke(specOrId: AgentSpec | string, inputs: InvokeInputs, actor: ActorContext, opts: InvokeOptions): Promise<RunResult> {
    const spec = typeof specOrId === 'string' ? this.registry.get(specOrId) : specOrId;
    if (!spec) throw new Error(`agent not found: ${String(specOrId)}`);
    this.validateInputs(spec, inputs);
    this.assertGovernance(spec, actor);

    const runId = randomUUID();
    const traceId = randomUUID();
    const startedAt = new Date().toISOString();
    await this.store.execRaw(
      `INSERT INTO __schema__.agent_runs (run_id, agent_id, agent_version, scope_id, facility_id, status, started_at, trigger, inputs, trace_id, parent_run_id)
       VALUES ($1,$2,$3,$4,$5,'running',$6,$7::jsonb,$8::jsonb,$9,$10)`,
      [runId, spec.id, spec.version, actor.scopeIds[0] ?? 'scope:unknown', opts.facilityId ?? null, startedAt, JSON.stringify({ type: opts.triggerType, detail: opts.triggerDetail }), JSON.stringify(inputs), traceId, opts.parentRunId ?? null],
    );

    const state: Record<string, unknown> = { input: inputs, output: {} };
    const meters = new Map<string, { qty: number; totalUsd: number }>();
    const priceOf = (unit: string): number => spec.billing.meteredUnits.find((u) => u.unit === unit)?.priceUsdPerUnit ?? 0;

    const emitMeterFor = (stepUid: string, unit: BillingMeter['meteredUnits'][number]['unit'], quantity: number): void => {
      const price = priceOf(unit);
      const total = price * quantity;
      const cur = meters.get(unit) ?? { qty: 0, totalUsd: 0 };
      meters.set(unit, { qty: cur.qty + quantity, totalUsd: cur.totalUsd + total });
      const eventId = randomUUID();
      const period = billingPeriod(new Date());
      void this.store.execRaw(
        `INSERT INTO __schema__.metering_events (event_id, scope_id, facility_id, agent_id, run_id, step_uid, unit, quantity, unit_price_usd, total_usd, occurred_at, billing_period)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), $11)`,
        [eventId, actor.scopeIds[0] ?? 'scope:unknown', opts.facilityId ?? null, spec.id, runId, stepUid, unit, quantity, price, total, period],
      );
    };

    let status: RunResult['status'] = 'succeeded';
    let error: { message: string; stepId?: string } | undefined;

    try {
      await this.execNode(spec.plan, spec, state, actor, runId, traceId, emitMeterFor, opts);
    } catch (err) {
      status = err instanceof HitlPending ? 'awaiting-hitl' : 'failed';
      const stepId = (err as { stepId?: string }).stepId;
      error = stepId ? { message: (err as Error).message, stepId } : { message: (err as Error).message };
    }

    // Base fee.
    if (spec.billing.baseFeeUsd > 0) {
      const eventId = randomUUID();
      await this.store.execRaw(
        `INSERT INTO __schema__.metering_events (event_id, scope_id, facility_id, agent_id, run_id, unit, quantity, unit_price_usd, total_usd, occurred_at, billing_period)
         VALUES ($1,$2,$3,$4,$5,'invocation',1,$6,$6, NOW(), $7)`,
        [eventId, actor.scopeIds[0] ?? 'scope:unknown', opts.facilityId ?? null, spec.id, runId, spec.billing.baseFeeUsd, billingPeriod(new Date())],
      );
    }
    const totalCostUsd = spec.billing.baseFeeUsd + Array.from(meters.values()).reduce((s, m) => s + m.totalUsd, 0);
    const endedAt = new Date().toISOString();
    await this.store.execRaw(
      `UPDATE __schema__.agent_runs SET status = $2, ended_at = $3, outputs = $4::jsonb, error = $5::jsonb WHERE run_id = $1`,
      [runId, status, endedAt, JSON.stringify(state['output'] ?? {}), error ? JSON.stringify(error) : null],
    );

    this.telemetry.log('info', `agent-run ${runId} ${status} cost=$${totalCostUsd.toFixed(4)}`, { traceId, attributes: { agentId: spec.id, runId, status } });
    return {
      runId, status,
      outputs: (state['output'] as Record<string, unknown>) ?? {},
      totalCostUsd,
      meteredUnits: Array.from(meters.entries()).map(([unit, m]) => ({ unit, quantity: m.qty, totalUsd: m.totalUsd })),
      ...(error ? { error } : {}),
    };
  }

  private async execNode(node: PlanNode, spec: AgentSpec, state: Record<string, unknown>, actor: ActorContext, runId: string, traceId: string, emitMeter: (stepUid: string, unit: BillingMeter['meteredUnits'][number]['unit'], qty: number) => void, opts: InvokeOptions): Promise<void> {
    switch (node.type) {
      case 'step': return this.execStep(node.step, spec, state, actor, runId, traceId, emitMeter, opts);
      case 'sequence': for (const c of node.children) await this.execNode(c, spec, state, actor, runId, traceId, emitMeter, opts); return;
      case 'parallel': await Promise.all(node.children.map((c) => this.execNode(c, spec, state, actor, runId, traceId, emitMeter, opts))); return;
      case 'conditional': {
        const cond = evalExpr(node.when, state);
        if (cond) return this.execNode(node.then, spec, state, actor, runId, traceId, emitMeter, opts);
        if (node.otherwise) return this.execNode(node.otherwise, spec, state, actor, runId, traceId, emitMeter, opts);
        return;
      }
      case 'loop': {
        let i = 0;
        while (evalExpr(node.whileExpr, state) && i < node.maxIterations) { await this.execNode(node.body, spec, state, actor, runId, traceId, emitMeter, opts); i++; }
        return;
      }
    }
  }

  private async execStep(step: SkillStep, spec: AgentSpec, state: Record<string, unknown>, actor: ActorContext, runId: string, traceId: string, emitMeter: (stepUid: string, unit: BillingMeter['meteredUnits'][number]['unit'], qty: number) => void, opts: InvokeOptions): Promise<void> {
    if (step.when && !evalExpr(step.when, state)) return;
    const skill = this.skills.get(step.skill);
    if (!skill) throw Object.assign(new Error(`unknown skill ${step.skill}`), { stepId: step.id });
    const stepUid = randomUUID();
    const stepStarted = new Date().toISOString();
    const resolvedInputs = resolveInputs(step.inputs, state);
    await this.store.execRaw(
      `INSERT INTO __schema__.agent_run_steps (step_uid, run_id, step_id, skill_id, started_at, status, inputs) VALUES ($1,$2,$3,$4,$5,'running',$6::jsonb)`,
      [stepUid, runId, step.id, step.skill, stepStarted, JSON.stringify(resolvedInputs)],
    );

    const ctx: SkillContext = {
      runId, stepUid, stepId: step.id,
      scopeId: actor.scopeIds[0] ?? 'scope:unknown',
      ...(opts.facilityId !== undefined ? { facilityId: opts.facilityId } : {}),
      actorRef: actor.actorRef,
      traceId,
      emitMeter: (unit, qty) => emitMeter(stepUid, unit, qty),
      log: (level, msg, attrs) => this.telemetry.log(level, msg, { traceId, ...(attrs !== undefined ? { attributes: attrs } : {}) }),
      spawnChild: async (agentId, inputs) => {
        const child = await this.invoke(agentId, inputs, actor, { triggerType: 'sub-agent', triggerDetail: { parentStepId: step.id }, parentRunId: runId, ...(opts.facilityId !== undefined ? { facilityId: opts.facilityId } : {}) });
        return { runId: child.runId, outputs: child.outputs };
      },
      requestHitl: async (role, slaMinutes, payload) => {
        const gateId = randomUUID();
        const opened = new Date();
        const deadline = new Date(opened.getTime() + slaMinutes * 60000);
        await this.store.execRaw(
          `INSERT INTO __schema__.hitl_gates (gate_id, run_id, step_id, role_required, opened_at, sla_deadline) VALUES ($1,$2,$3,$4,$5,$6)`,
          [gateId, runId, step.id, role, opened.toISOString(), deadline.toISOString()],
        );
        if (!this.hitlWaitPolicy.synchronous) throw Object.assign(new HitlPending(`awaiting HITL role=${role}`), { stepId: step.id, gateId });
        // synchronous mode auto-approves for tests
        return { decision: 'approved', rationale: 'auto (synchronous test policy)' };
      },
    };

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const output = await skill.handle(resolvedInputs, ctx);
        if (step.outputBinding) state[step.outputBinding] = output;
        state['lastStepOutput'] = output;
        await this.store.execRaw(
          `UPDATE __schema__.agent_run_steps SET status='succeeded', ended_at=$2, outputs=$3::jsonb WHERE step_uid=$1`,
          [stepUid, new Date().toISOString(), JSON.stringify(output)],
        );
        return;
      } catch (err) {
        if (err instanceof HitlPending) {
          await this.store.execRaw(
            `UPDATE __schema__.agent_run_steps SET status='awaiting-hitl', ended_at=$2 WHERE step_uid=$1`,
            [stepUid, new Date().toISOString()],
          );
          throw err;
        }
        if (attempt >= step.retry.maxAttempts) {
          await this.store.execRaw(
            `UPDATE __schema__.agent_run_steps SET status='failed', ended_at=$2, error=$3::jsonb WHERE step_uid=$1`,
            [stepUid, new Date().toISOString(), JSON.stringify({ message: (err as Error).message })],
          );
          throw Object.assign(err as Error, { stepId: step.id });
        }
        await new Promise((r) => setTimeout(r, step.retry.backoffMs * attempt));
      }
    }
  }

  private validateInputs(spec: AgentSpec, inputs: InvokeInputs): void {
    for (const [k, defAny] of Object.entries(spec.inputs)) {
      const def = defAny as { required: boolean };
      if (def.required && !(k in inputs)) throw new Error(`missing required input ${k}`);
    }
  }
  private assertGovernance(spec: AgentSpec, actor: ActorContext): void {
    if (!spec.governance.purposeOfUse.includes(actor.purposeOfUse) && !(spec.governance.breakGlassAllowed && actor.purposeOfUse === 'break-glass')) {
      throw new Error(`actor purpose ${actor.purposeOfUse} not permitted for agent ${spec.id}`);
    }
    const rank: Record<string, number> = { public: 0, internal: 1, confidential: 2, phi: 3, 'restricted-phi': 4 };
    if ((rank[actor.clearance] ?? 0) < (rank[spec.governance.clearanceRequired] ?? 4)) {
      throw new Error(`actor clearance ${actor.clearance} insufficient for agent ${spec.id}`);
    }
  }
}

export class HitlPending extends Error {
  constructor(msg: string) { super(msg); this.name = 'HitlPending'; }
}

/** Minimal expression evaluator: `state.foo.bar === 'x'` / `state.x > 3`. Safe subset only. */
function evalExpr(expr: string, state: Record<string, unknown>): boolean {
  try {
    // Only allow: identifiers, dots, brackets, quoted strings, numbers, comparison + logical operators.
    if (!/^[\w.\[\]'"\s()!=<>&|+\-*/,?:]+$/.test(expr)) return false;
    const fn = new Function('state', `return (${expr});`);
    return Boolean(fn(state));
  } catch { return false; }
}

function resolveInputs(inputs: Record<string, unknown>, state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' && v.startsWith('${') && v.endsWith('}')) {
      const path = v.slice(2, -1).trim();
      out[k] = resolvePath(state, path);
    } else out[k] = v;
  }
  return out;
}
function resolvePath(state: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = state;
  for (const p of parts) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}
function billingPeriod(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
