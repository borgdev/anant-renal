// A minimal, deterministic planner. It maps the caller's intent onto a fixed
// set of "recipes" — sequences of tool calls that the harness knows are safe.
// Extending the harness with an LLM-driven planner is a matter of swapping
// this class; the tool registry is the constraint that keeps it honest.

import type { AgentHarness, HarnessPlan, HarnessTurn, ToolCall, ToolExecution } from '../control-plane/harness.js';
import type { ToolRegistry } from './tools.js';
import type { ModelRouter } from './model-router.js';
import type { AccessRequest } from '../control-plane/access.js';

export interface RecipeContext {
  turn: HarnessTurn;
  now: string;
  models: ModelRouter;
}

export interface Recipe {
  id: string;
  matches(turn: HarnessTurn): boolean;
  plan(ctx: RecipeContext): Promise<{ toolCalls: ToolCall[]; output: string; reasoning?: string }>;
}

export interface HarnessRuntimeConfig {
  id: string;
  registry: ToolRegistry;
  models: ModelRouter;
  recipes: readonly Recipe[];
  buildAccessRequest(call: ToolCall, turn: HarnessTurn): AccessRequest;
}

export class HarnessRuntime implements AgentHarness {
  readonly id: string;
  constructor(private readonly cfg: HarnessRuntimeConfig) {
    this.id = cfg.id;
  }

  async plan(turn: HarnessTurn): Promise<HarnessPlan> {
    const now = new Date().toISOString();
    for (const recipe of this.cfg.recipes) {
      if (recipe.matches(turn)) {
        const out = await recipe.plan({ turn, now, models: this.cfg.models });
        return {
          output: out.output,
          toolCalls: out.toolCalls,
          traceId: `trace:${now}:${recipe.id}`,
          ...(out.reasoning !== undefined ? { reasoning: out.reasoning } : {}),
        };
      }
    }
    return { output: 'no recipe matched', toolCalls: [], traceId: `trace:${now}:noop` };
  }

  async executeTool(call: ToolCall, turn: HarnessTurn): Promise<ToolExecution> {
    const request = this.cfg.buildAccessRequest(call, turn);
    const result = await this.cfg.registry.invoke({
      toolName: call.name,
      input: call.input,
      request,
      ctx: { traceId: `trace:${turn.actorId}:${call.name}`, actorId: turn.actorId, scopeId: turn.scopeId },
    });
    if (result.ok) return { ok: true, output: result.output, decision: 'allow' };
    const exec: ToolExecution = { ok: false, output: result.reason ?? '' };
    if (result.errorCode) exec.errorCode = result.errorCode;
    if (result.errorCode?.startsWith('access.')) {
      const decision = result.errorCode.split('.')[1] as ToolExecution['decision'];
      if (decision) exec.decision = decision;
    }
    return exec;
  }
}
