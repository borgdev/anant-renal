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

// Replay is the trust primitive of the harness. Any workflow, any policy, any
// generated app has to be runnable against historical events and produce a
// deterministic outcome list. This is what turns "AI wrote code" into
// "we can prove what the code would have done last quarter."

import type { CanonicalEvent, EventBatch } from './events.js';
import { orderEvents } from './events.js';
import type { DataQualityEngine, DataQualityFinding } from './data-quality.js';

export interface ReplayOutcome<S> {
  event: CanonicalEvent;
  state: S;
  emitted: readonly unknown[];
  findings: readonly DataQualityFinding[];
}

export interface ReplayReport<S> {
  batchId: string;
  window: { from: string; to: string };
  outcomes: readonly ReplayOutcome<S>[];
  finalState: S;
  eventCount: number;
  emittedCount: number;
  findingCount: number;
  worstSeverity: string | null;
}

export interface WorkflowReducer<S> {
  initial(): S;
  reduce(state: S, event: CanonicalEvent): { state: S; emitted: readonly unknown[] };
}

export function replay<S>(
  batch: EventBatch,
  reducer: WorkflowReducer<S>,
  dq: DataQualityEngine<CanonicalEvent>,
): ReplayReport<S> {
  const ordered = orderEvents(batch.events);
  const outcomes: ReplayOutcome<S>[] = [];
  let state = reducer.initial();
  let emittedCount = 0;
  let findingCount = 0;
  let worst: string | null = null;

  for (const event of ordered) {
    const findings = dq.evaluate(event);
    findingCount += findings.length;
    const w = dq.worst(findings);
    if (w) worst = worst && rank(worst) > rank(w) ? worst : w;

    const gate = dq.gateExecution(findings);
    if (!gate.proceed) {
      outcomes.push({ event, state, emitted: [], findings });
      continue;
    }
    const next = reducer.reduce(state, event);
    state = next.state;
    emittedCount += next.emitted.length;
    outcomes.push({ event, state, emitted: next.emitted, findings });
  }

  return {
    batchId: batch.id,
    window: batch.window,
    outcomes,
    finalState: state,
    eventCount: ordered.length,
    emittedCount,
    findingCount,
    worstSeverity: worst,
  };
}

function rank(s: string): number {
  return { info: 0, warning: 1, error: 2, critical: 3 }[s] ?? 0;
}
