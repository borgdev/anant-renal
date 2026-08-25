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
