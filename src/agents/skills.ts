// Skill primitives + skill registry.
//
// A Skill is one metered execution unit. The Runtime resolves `step.skill` via
// the SkillRegistry and calls `handle(inputs, ctx)`. Skills report their metered
// units back via `ctx.emitMeter(...)`; the Runtime aggregates them into
// MeteringEvent rows.

import type { BillingMeter } from './spec.js';

export interface SkillContext {
  readonly runId: string;
  readonly stepUid: string;
  readonly stepId: string;
  readonly scopeId: string;
  readonly facilityId?: string;
  readonly actorRef: string;
  readonly traceId: string;
  emitMeter(unit: BillingMeter['meteredUnits'][number]['unit'], quantity: number, attrs?: Record<string, unknown>): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, attrs?: Record<string, unknown>): void;
  spawnChild(agentId: string, inputs: Record<string, unknown>): Promise<{ runId: string; outputs: Record<string, unknown> }>;
  requestHitl(role: string, slaMinutes: number, payload: Record<string, unknown>): Promise<{ decision: string; rationale: string }>;
}

export interface Skill<Inputs = unknown, Outputs = unknown> {
  readonly id: string;
  readonly description: string;
  handle(inputs: Inputs, ctx: SkillContext): Promise<Outputs>;
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  register(skill: Skill): void { this.skills.set(skill.id, skill as Skill); }
  get(id: string): Skill | undefined { return this.skills.get(id); }
  list(): readonly Skill[] { return Array.from(this.skills.values()); }
}

// ---- Built-in skills ----

/** llm.call — meters input+output tokens. Handler is injected so we don't hard-depend on any provider. */
export function llmCallSkill(invoke: (prompt: string, opts?: Record<string, unknown>) => Promise<{ text: string; inputTokens: number; outputTokens: number }>): Skill<{ prompt: string; opts?: Record<string, unknown> }, { text: string }> {
  return {
    id: 'llm.call',
    description: 'Invoke an LLM with a prompt; metered per token in and out.',
    handle: async (inputs, ctx) => {
      const r = await invoke(inputs.prompt, inputs.opts ?? {});
      ctx.emitMeter('llm.tokens.input', r.inputTokens);
      ctx.emitMeter('llm.tokens.output', r.outputTokens);
      return { text: r.text };
    },
  };
}

/** sql.query — meters per query. Executor is injected. */
export function sqlQuerySkill(exec: (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>): Skill<{ sql: string; params?: readonly unknown[] }, { rows: Record<string, unknown>[] }> {
  return {
    id: 'sql.query',
    description: 'Execute a scoped SQL query. Metered per query.',
    handle: async (inputs, ctx) => {
      const rows = await exec(inputs.sql, inputs.params ?? []);
      ctx.emitMeter('sql.query', 1);
      return { rows };
    },
  };
}

/** http.call — meters per outbound call. */
export function httpCallSkill(fetchImpl: typeof fetch = fetch): Skill<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }, { status: number; body: unknown }> {
  return {
    id: 'http.call',
    description: 'Make an outbound HTTP call. Metered per call.',
    handle: async (inputs, ctx) => {
      const res = await fetchImpl(inputs.url, {
        method: inputs.method ?? 'GET',
        ...(inputs.headers ? { headers: inputs.headers } : {}),
        ...(inputs.body !== undefined ? { body: typeof inputs.body === 'string' ? inputs.body : JSON.stringify(inputs.body) } : {}),
      });
      ctx.emitMeter('tool.call', 1);
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep raw */ }
      return { status: res.status, body };
    },
  };
}

/** x12.build.837 — placeholder builder metered per claim. Actual generator lives in packs/payer/x12. */
export function x12Build837Skill(build: (claim: unknown) => Promise<string>): Skill<{ claim: unknown }, { edi: string }> {
  return {
    id: 'x12.build.837',
    description: 'Build an X12 837P/I claim envelope. Metered per claim.',
    handle: async (inputs, ctx) => {
      const edi = await build(inputs.claim);
      ctx.emitMeter('x12.claim', 1);
      return { edi };
    },
  };
}

/** hl7.send — metered per message. */
export function hl7SendSkill(send: (msg: string, dest: string) => Promise<{ ack: string }>): Skill<{ message: string; destination: string }, { ack: string }> {
  return {
    id: 'hl7.send',
    description: 'Send an HL7 v2 message to a destination MLLP endpoint.',
    handle: async (inputs, ctx) => {
      const r = await send(inputs.message, inputs.destination);
      ctx.emitMeter('hl7.message', 1);
      return r;
    },
  };
}

/** hitl.approve — opens a gate, awaits resolution, meters HITL minutes. */
export const hitlApproveSkill: Skill<{ role: string; slaMinutes: number; payload: Record<string, unknown> }, { decision: string; rationale: string; minutes: number }> = {
  id: 'hitl.approve',
  description: 'Open a HITL gate and wait for a human decision.',
  handle: async (inputs, ctx) => {
    const startedAt = Date.now();
    const r = await ctx.requestHitl(inputs.role, inputs.slaMinutes, inputs.payload);
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    ctx.emitMeter('hitl.minutes', minutes);
    return { ...r, minutes };
  },
};

/** agent.invoke — spawns a sub-agent, returns its outputs. */
export const subAgentSkill: Skill<{ agentId: string; inputs: Record<string, unknown> }, { runId: string; outputs: Record<string, unknown> }> = {
  id: 'agent.invoke',
  description: 'Invoke a sub-agent; boundary + scope checks apply.',
  handle: async (inputs, ctx) => {
    const r = await ctx.spawnChild(inputs.agentId, inputs.inputs);
    ctx.emitMeter('tool.call', 1);
    return r;
  },
};

/** outcome.oracle.attest — writes an outcome attestation to the ledger. Metered by outcome tier at billing time. */
export function outcomeOracleSkill(attest: (outcome: { type: string; runId: string; evidence: unknown }) => Promise<{ ok: boolean; attestationId: string }>): Skill<{ type: string; evidence: unknown }, { ok: boolean; attestationId: string }> {
  return {
    id: 'outcome.oracle.attest',
    description: 'Attest that a run achieved a declared outcome. Enables outcome-tier billing.',
    handle: async (inputs, ctx) => {
      const r = await attest({ type: inputs.type, runId: ctx.runId, evidence: inputs.evidence });
      return r;
    },
  };
}

/** Ready-to-register bundle of default skills using pure/mock implementations for tests. */
export function defaultTestSkills(): SkillRegistry {
  const reg = new SkillRegistry();
  reg.register(llmCallSkill(async (prompt) => ({ text: `echo:${prompt}`, inputTokens: prompt.length, outputTokens: prompt.length + 10 })));
  reg.register(sqlQuerySkill(async () => []));
  reg.register(httpCallSkill(async () => new Response('{}', { status: 200 })));
  reg.register(x12Build837Skill(async () => 'ISA*00*...*IEA*1*000000001~'));
  reg.register(hl7SendSkill(async () => ({ ack: 'AA' })));
  reg.register(hitlApproveSkill);
  reg.register(subAgentSkill);
  reg.register(outcomeOracleSkill(async () => ({ ok: true, attestationId: 'att-1' })));
  return reg;
}
