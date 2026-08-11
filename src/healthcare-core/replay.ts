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
