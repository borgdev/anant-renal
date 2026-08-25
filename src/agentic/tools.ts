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

// Tool registry — every tool call from the harness passes through here, gets
// access-checked, audited, and executed. Tools declare a JSON-shaped input
// schema and a resource type so the access evaluator can reason about them.

import type { AccessEvaluator, AccessRequest } from '../control-plane/access.js';
import type { AuditLedger } from '../control-plane/audit.js';

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  resourceType: string;
  inputSchema: Readonly<Record<string, unknown>>;
  invoke(input: Input, ctx: ToolContext): Promise<Output>;
}

export interface ToolContext {
  traceId: string;
  actorId: string;
  scopeId: string;
}

export interface ToolInvocation<Input = unknown> {
  toolName: string;
  input: Input;
  request: AccessRequest;
  ctx: ToolContext;
}

export interface ToolResult<Output = unknown> {
  ok: boolean;
  output?: Output;
  errorCode?: string;
  reason?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly access: AccessEvaluator,
    private readonly audit: AuditLedger,
  ) {}

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async invoke<Input, Output>(invocation: ToolInvocation<Input>): Promise<ToolResult<Output>> {
    const tool = this.tools.get(invocation.toolName) as ToolDefinition<Input, Output> | undefined;
    if (!tool) {
      const denied = { ok: false as const, errorCode: 'tool.unknown', reason: `Unknown tool: ${invocation.toolName}` };
      this.audit.append({
        id: `audit:${invocation.ctx.traceId}:${invocation.toolName}`,
        occurredAt: new Date().toISOString(),
        actorId: invocation.ctx.actorId,
        scopeId: invocation.ctx.scopeId,
        action: `tool.invoke:${invocation.toolName}`,
        traceId: invocation.ctx.traceId,
        payload: { input: invocation.input as unknown, result: denied },
      });
      return denied;
    }

    const decision = this.access.evaluate(invocation.request);
    this.audit.append({
      id: `audit:${invocation.ctx.traceId}:${invocation.toolName}:decision`,
      occurredAt: new Date().toISOString(),
      actorId: invocation.ctx.actorId,
      scopeId: invocation.ctx.scopeId,
      action: `tool.access-check:${invocation.toolName}`,
      traceId: invocation.ctx.traceId,
      decision: decision.decision,
      policyVersion: decision.policyVersion,
      payload: { reasons: decision.reasons, matchedRules: decision.matchedRules },
    });
    if (decision.decision !== 'allow') {
      return { ok: false, errorCode: `access.${decision.decision}`, reason: decision.reasons.join('; ') };
    }

    try {
      const output = await tool.invoke(invocation.input, invocation.ctx);
      this.audit.append({
        id: `audit:${invocation.ctx.traceId}:${invocation.toolName}:ok`,
        occurredAt: new Date().toISOString(),
        actorId: invocation.ctx.actorId,
        scopeId: invocation.ctx.scopeId,
        action: `tool.invoke:${invocation.toolName}`,
        traceId: invocation.ctx.traceId,
        payload: { input: invocation.input as unknown, ok: true },
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.append({
        id: `audit:${invocation.ctx.traceId}:${invocation.toolName}:fail`,
        occurredAt: new Date().toISOString(),
        actorId: invocation.ctx.actorId,
        scopeId: invocation.ctx.scopeId,
        action: `tool.invoke:${invocation.toolName}`,
        traceId: invocation.ctx.traceId,
        payload: { input: invocation.input as unknown, ok: false, error: message },
      });
      return { ok: false, errorCode: 'tool.error', reason: message };
    }
  }
}
