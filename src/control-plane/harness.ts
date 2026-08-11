import type { AccessDecision } from './access.js';

// The agent harness contract keeps the reasoning model at arm's length. The
// harness is what plans, calls tools, and produces traces; the model is a
// swappable implementation detail behind `plan`.

export interface ToolCall {
  name: string;
  input: Readonly<Record<string, unknown>>;
}

export interface HarnessTurn {
  scopeId: string;
  actorId: string;
  input: string;
  context: Readonly<Record<string, unknown>>;
}

export interface HarnessPlan {
  output: string;
  toolCalls: readonly ToolCall[];
  traceId: string;
  reasoning?: string;
}

export interface ToolExecution {
  ok: boolean;
  output: unknown;
  decision?: AccessDecision;
  errorCode?: string;
}

export interface AgentHarness {
  id: string;
  plan(turn: HarnessTurn): Promise<HarnessPlan>;
  executeTool(call: ToolCall, turn: HarnessTurn): Promise<ToolExecution>;
}
