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

// AgentSpec — the declarative contract for a governed agent.
//
// An agent is a plan graph of Skill invocations, triggered by canonical
// events / cron / manual invocations, scoped by RBAC/ABAC, replayable via
// the hypergraph ledger, and metered per skill invocation. Specs live as
// YAML in packs (`packs/<pack>/agents/<id>.yaml`) and are mirrored to
// Postgres for the Studio editor. Zod validation runs on both paths so an
// invalid spec never reaches the runtime.

import { z } from 'zod';

// ---- Triggers ----
export const EventTriggerSchema = z.object({
  kind: z.literal('event'),
  eventType: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export const CronTriggerSchema = z.object({
  kind: z.literal('cron'),
  expression: z.string().min(1),
  timezone: z.string().default('UTC'),
});
export const WebhookTriggerSchema = z.object({
  kind: z.literal('webhook'),
  path: z.string().startsWith('/'),
});
export const ManualTriggerSchema = z.object({ kind: z.literal('manual') });
export const TriggerSchema = z.discriminatedUnion('kind', [EventTriggerSchema, CronTriggerSchema, WebhookTriggerSchema, ManualTriggerSchema]);

// ---- Governance ----
export const GovernanceSchema = z.object({
  phiHandling: z.enum(['none', 'read', 'read-write']),
  purposeOfUse: z.array(z.enum(['treatment', 'operations', 'compliance', 'research', 'break-glass'])).min(1),
  clearanceRequired: z.enum(['public', 'internal', 'confidential', 'phi', 'restricted-phi']),
  hitlGates: z.array(z.object({
    afterStepId: z.string(),
    role: z.string(),
    slaMinutes: z.number().int().positive(),
  })).default([]),
  breakGlassAllowed: z.boolean().default(false),
  evidenceRequired: z.array(z.string()).default([]),
});

// ---- Billing meter ----
export const BillingMeterSchema = z.object({
  baseFeeUsd: z.number().nonnegative().default(0),
  meteredUnits: z.array(z.object({
    unit: z.enum(['llm.tokens.input', 'llm.tokens.output', 'tool.call', 'hitl.minutes', 'storage.mb', 'x12.claim', 'hl7.message', 'sql.query']),
    priceUsdPerUnit: z.number().nonnegative(),
  })).default([]),
  outcomeTier: z.object({
    outcomeType: z.string(),
    payoutUsd: z.number().nonnegative(),
    oracleSkillId: z.string(),
  }).optional(),
  budgetCapMonthlyUsd: z.number().nonnegative().optional(),
});

// ---- Skill invocations (plan steps) ----
export const SkillStepSchema = z.object({
  id: z.string().min(1),
  skill: z.string().min(1), // registered skill id (e.g. 'llm.call', 'sql.query', 'x12.build.837')
  inputs: z.record(z.string(), z.unknown()).default({}),
  outputBinding: z.string().optional(), // variable name results are bound to
  when: z.string().optional(), // JSONata / simple expression, e.g. "state.result.ok === true"
  retry: z.object({ maxAttempts: z.number().int().positive().default(3), backoffMs: z.number().int().nonnegative().default(500) }).default({ maxAttempts: 3, backoffMs: 500 }),
  timeout: z.object({ ms: z.number().int().positive() }).optional(),
});

// Using z.ZodType<PlanNode> loses the discriminatedUnion narrowing but keeps the recursive type stable.
export const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() => z.union([
  z.object({ type: z.literal('step'), step: SkillStepSchema }),
  z.object({ type: z.literal('parallel'), children: z.array(PlanNodeSchema) }),
  z.object({ type: z.literal('sequence'), children: z.array(PlanNodeSchema) }),
  z.object({ type: z.literal('conditional'), when: z.string(), then: PlanNodeSchema, otherwise: PlanNodeSchema.optional() }),
  z.object({ type: z.literal('loop'), whileExpr: z.string(), body: PlanNodeSchema, maxIterations: z.number().int().positive().default(100) }),
]) as unknown as z.ZodType<PlanNode>);
export type PlanNode =
  | { type: 'step'; step: z.infer<typeof SkillStepSchema> }
  | { type: 'parallel'; children: PlanNode[] }
  | { type: 'sequence'; children: PlanNode[] }
  | { type: 'conditional'; when: string; then: PlanNode; otherwise?: PlanNode }
  | { type: 'loop'; whileExpr: string; body: PlanNode; maxIterations: number };

// ---- Full AgentSpec ----
export const AgentSpecSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  packId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(''),
  scope: z.enum(['org', 'region', 'facility', 'patient']),
  trigger: TriggerSchema,
  inputs: z.record(z.string(), z.object({ type: z.enum(['string', 'number', 'boolean', 'object', 'array']), required: z.boolean().default(true), description: z.string().default('') })).default({}),
  outputs: z.record(z.string(), z.object({ type: z.enum(['string', 'number', 'boolean', 'object', 'array']), description: z.string().default('') })).default({}),
  plan: PlanNodeSchema,
  governance: GovernanceSchema,
  billing: BillingMeterSchema,
  slas: z.object({
    p95LatencyMs: z.number().int().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    availability: z.number().min(0).max(1).optional(),
  }).default({}),
  labels: z.record(z.string(), z.string()).default({}),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type Governance = z.infer<typeof GovernanceSchema>;
export type BillingMeter = z.infer<typeof BillingMeterSchema>;
export type SkillStep = z.infer<typeof SkillStepSchema>;

export class AgentSpecError extends Error {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super(message);
    this.name = 'AgentSpecError';
    if (issues) this.issues = issues;
  }
}

export function validateAgentSpec(raw: unknown): AgentSpec {
  const r = AgentSpecSchema.safeParse(raw);
  if (!r.success) throw new AgentSpecError('AgentSpec validation failed', r.error.issues);
  return r.data;
}
