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

// Emitter: CanonicalEntity + archetype -> AgentSpec objects.
// Every emitted spec is validated with validateAgentSpec() by the caller.

import type { AgentSpec, PlanNode } from '../agents/index.js';
import type { CanonicalEntity, Archetype } from './types.js';

interface EmitCtx {
  packId: string;
}

function pkField(e: CanonicalEntity): string {
  const pk = e.fields.find((f) => f.primaryKey);
  if (pk) return pk.name;
  // Common patterns
  const named = e.fields.find((f) => /^(id|_?id|patient_id|encounter_id|order_id)$/i.test(f.name));
  return named?.name ?? 'id';
}

function baseGovernance(e: CanonicalEntity, hitl = false, breakGlass = false): AgentSpec['governance'] {
  const isPhi = e.hints.phi ?? e.fields.some((f) => f.phi);
  return {
    phiHandling: isPhi ? 'read-write' : 'read',
    purposeOfUse: e.hints.purposeOfUse ?? (isPhi ? ['treatment'] : ['operations']),
    clearanceRequired: isPhi ? 'phi' : 'internal',
    hitlGates: hitl ? [{ afterStepId: 'step-2', role: 'md', slaMinutes: 30 }] : [],
    breakGlassAllowed: breakGlass,
    evidenceRequired: [],
  };
}

function baseBilling(): AgentSpec['billing'] {
  return {
    baseFeeUsd: 0.05,
    meteredUnits: [
      { unit: 'llm.tokens.input', priceUsdPerUnit: 0.000003 },
      { unit: 'llm.tokens.output', priceUsdPerUnit: 0.000015 },
      { unit: 'tool.call', priceUsdPerUnit: 0.002 },
    ],
    budgetCapMonthlyUsd: 200,
  };
}

function sequencePlan(stepIds: string[]): PlanNode {
  return {
    type: 'sequence',
    children: stepIds.map((id) => ({
      type: 'step',
      step: {
        id, skill: id.startsWith('llm') ? 'llm.call' : id.startsWith('sql') ? 'sql.query' : 'http.call',
        inputs: {}, retry: { maxAttempts: 3, backoffMs: 500 },
      },
    })),
  };
}

function ioForEntity(e: CanonicalEntity): { inputs: AgentSpec['inputs']; outputs: AgentSpec['outputs'] } {
  const pk = pkField(e);
  return {
    inputs: { [pk]: { type: 'string', required: true, description: `${e.name} identifier` } },
    outputs: { resultRef: { type: 'string', description: 'Result artifact ref' } },
  };
}

function emitRecordSteward(e: CanonicalEntity, ctx: EmitCtx): AgentSpec[] {
  const io = ioForEntity(e);
  return [
    {
      id: `${e.id}-intake`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Intake`,
      description: `Ingest a ${e.name} record with governance and PHI handling.`,
      scope: 'facility',
      trigger: { kind: 'event', eventType: `${e.id}.received` },
      inputs: io.inputs, outputs: io.outputs,
      plan: sequencePlan(['step-1', 'step-2', 'step-3']),
      governance: baseGovernance(e), billing: baseBilling(),
      slas: { p95LatencyMs: 30000, maxCostUsd: 0.75 },
      labels: { archetype: 'record-steward', 'source-entity': e.id },
    },
    {
      id: `${e.id}-reconcile`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Reconcile`,
      description: `Reconcile ${e.name} records across sources of truth.`,
      scope: 'facility',
      trigger: { kind: 'cron', expression: '0 */6 * * *', timezone: 'UTC' },
      inputs: {}, outputs: io.outputs,
      plan: sequencePlan(['step-1', 'step-2']),
      governance: baseGovernance(e), billing: baseBilling(),
      slas: {}, labels: { archetype: 'record-steward', 'source-entity': e.id },
    },
    {
      id: `${e.id}-audit-report`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Audit Report`,
      description: `Compile ${e.name} audit report for compliance review.`,
      scope: 'org',
      trigger: { kind: 'cron', expression: '0 0 1 * *', timezone: 'UTC' },
      inputs: {}, outputs: io.outputs,
      plan: sequencePlan(['step-1', 'step-2', 'step-3']),
      governance: { ...baseGovernance(e), purposeOfUse: ['compliance'] },
      billing: baseBilling(),
      slas: {}, labels: { archetype: 'record-steward', 'source-entity': e.id },
    },
  ];
}

function emitCatalogManager(e: CanonicalEntity, ctx: EmitCtx): AgentSpec[] {
  const io = ioForEntity(e);
  return [
    {
      id: `${e.id}-sync`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Catalog Sync`,
      description: `Sync ${e.name} catalog with upstream source.`,
      scope: 'org',
      trigger: { kind: 'cron', expression: '0 3 * * *', timezone: 'UTC' },
      inputs: {}, outputs: io.outputs,
      plan: sequencePlan(['step-1', 'step-2']),
      governance: baseGovernance(e), billing: baseBilling(),
      slas: {}, labels: { archetype: 'catalog-manager', 'source-entity': e.id },
    },
    {
      id: `${e.id}-drift-check`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Drift Check`,
      description: `Detect drift in ${e.name} catalog values.`,
      scope: 'org',
      trigger: { kind: 'cron', expression: '0 */12 * * *', timezone: 'UTC' },
      inputs: {}, outputs: io.outputs,
      plan: sequencePlan(['step-1']),
      governance: baseGovernance(e), billing: baseBilling(),
      slas: {}, labels: { archetype: 'catalog-manager', 'source-entity': e.id },
    },
  ];
}

function emitProcedureRunner(e: CanonicalEntity, ctx: EmitCtx): AgentSpec[] {
  const io = ioForEntity(e);
  const steps = (e.workflow ?? []).map((w) => w.id);
  const hitl = (e.workflow ?? []).some((w) => w.requiresHitl) || (e.hints.hitl ?? false);
  const gates = hitl
    ? (e.workflow ?? []).filter((w) => w.requiresHitl).map((w) => ({ afterStepId: w.id, role: w.role ?? 'md', slaMinutes: 30 }))
    : [];
  return [
    {
      id: `${e.id}-orchestrator`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Orchestrator`,
      description: e.description ?? `Runs the ${e.name} procedure end-to-end.`,
      scope: 'facility',
      trigger: { kind: 'manual' },
      inputs: io.inputs, outputs: io.outputs,
      plan: sequencePlan(steps.length ? steps : ['step-1', 'step-2']),
      governance: { ...baseGovernance(e, hitl), ...(gates.length ? { hitlGates: gates } : {}) },
      billing: baseBilling(),
      slas: { p95LatencyMs: 60000 },
      labels: { archetype: 'procedure-runner', 'source-entity': e.id, ...(hitl ? { hitl: 'true' } : {}) },
    },
  ];
}

function emitAssessor(e: CanonicalEntity, ctx: EmitCtx): AgentSpec[] {
  const io = ioForEntity(e);
  return [
    {
      id: `${e.id}-detector`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Detector`,
      description: `Detects presence/severity of ${e.name}.`,
      scope: 'patient',
      trigger: { kind: 'event', eventType: 'patient.arrived' },
      inputs: io.inputs, outputs: io.outputs,
      plan: sequencePlan(['step-1', 'step-2']),
      governance: baseGovernance(e), billing: baseBilling(),
      slas: { p95LatencyMs: 15000 },
      labels: { archetype: 'assessor', 'source-entity': e.id },
    },
    {
      id: `${e.id}-tracker`, version: '1.0.0', packId: ctx.packId,
      displayName: `${e.name} Tracker`,
      description: `Longitudinal tracker for ${e.name}.`,
      scope: 'patient',
      trigger: { kind: 'cron', expression: '0 6 * * *', timezone: 'UTC' },
      inputs: {}, outputs: io.outputs,
      plan: sequencePlan(['step-1', 'step-2']),
      governance: baseGovernance(e), billing: baseBilling(),
      slas: {}, labels: { archetype: 'assessor', 'source-entity': e.id },
    },
  ];
}

export function emitAgents(e: CanonicalEntity, archetype: Archetype, ctx: EmitCtx): AgentSpec[] {
  switch (archetype) {
    case 'record-steward': return emitRecordSteward(e, ctx);
    case 'catalog-manager': return emitCatalogManager(e, ctx);
    case 'procedure-runner': return emitProcedureRunner(e, ctx);
    case 'assessor': return emitAssessor(e, ctx);
    case 'reference-only': return [];
  }
}
