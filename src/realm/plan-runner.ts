// M13.A — PlanRunner
//
// Walks a PlanGraph DAG and emits each step's effect through the reducer,
// honoring HITL suspension and per-role authority. Records step status
// transitions and emits an `advance-plan` audit effect on each transition.
//
// Contract: pure orchestration — never bypasses the reducer, never mutates
// entities directly. Runs are cooperative: `step()` advances at most one
// ready step per call; `runAll()` loops until no ready steps remain.

import type { PlanGraph, PlanStep } from './planner.js';
import type { AgentPresence, EmittedEffect, WorldEffect } from './types.js';

export type PlanRunOutcome =
  | { kind: 'advanced'; stepId: string; effect: EmittedEffect }
  | { kind: 'suspended'; stepId: string; approvalId: string }
  | { kind: 'blocked'; stepId: string; reason: string }
  | { kind: 'complete' }
  | { kind: 'idle' }; // nothing to advance right now

export interface PlanRunnerHooks {
  /** Find a presence to execute a step for the given owner role. */
  resolveExecutor(step: PlanStep): AgentPresence | undefined;
  /** Emit a world effect through the reducer. */
  emit(presenceId: string, effect: WorldEffect): EmittedEffect;
  /** Emit an audit-only advance-plan record. */
  audit(planId: string, stepId: string, transition: Exclude<PlanStep['status'], 'pending'>, note?: string): void;
  /** Current realm wall-time as ISO string, used for run-log timestamps. */
  nowIso(): string;
}

/** Immutable per-outcome log entry. Captured on every step transition. */
export interface PlanRunLogEntry {
  at: string;
  stepId: string;
  outcomeKind: PlanRunOutcome['kind'];
  transition?: Exclude<PlanStep['status'], 'pending'>;
  approvalId?: string;
  reason?: string;
  effectKind?: WorldEffect['kind'];
  presenceId?: string;
}

type PlanWithLog = PlanGraph & { runLog?: PlanRunLogEntry[] };

export class PlanRunner {
  constructor(private readonly hooks: PlanRunnerHooks) {}

  /** True if every step is completed. */
  isComplete(plan: PlanGraph): boolean {
    return plan.steps.every((s) => s.status === 'completed');
  }

  /** True if any step is aborted (a hard failure blocks the whole plan). */
  isAborted(plan: PlanGraph): boolean {
    return plan.steps.some((s) => s.status === 'aborted');
  }

  /** All steps whose deps are completed and status is pending. */
  readySteps(plan: PlanGraph): PlanStep[] {
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    return plan.steps.filter((s) => {
      if (s.status !== 'pending') return false;
      const deps = s.dependsOn ?? [];
      return deps.every((d) => byId.get(d)?.status === 'completed');
    });
  }

  /** Advance one ready step. Mutates the plan in place (status transitions). */
  step(plan: PlanGraph): PlanRunOutcome {
    if (this.isAborted(plan)) return { kind: 'blocked', stepId: '-', reason: 'plan-aborted' };
    if (this.isComplete(plan)) return { kind: 'complete' };
    const ready = this.readySteps(plan);
    if (ready.length === 0) return { kind: 'idle' };
    const step = ready[0]!;

    // If step has no effect hint, treat as a bookkeeping step and mark complete immediately.
    if (!step.effectHint) {
      step.status = 'completed';
      this.hooks.audit(plan.planId, step.id, 'completed', 'no-effect step');
      this.logEntry(plan, { at: this.hooks.nowIso(), stepId: step.id, outcomeKind: 'advanced', transition: 'completed', reason: 'no-effect step' });
      return this.step(plan); // tail-recurse to advance any newly-ready step
    }

    const executor = this.hooks.resolveExecutor(step);
    if (!executor) {
      step.status = 'blocked';
      this.hooks.audit(plan.planId, step.id, 'blocked', `no presence for role ${step.ownerRole}`);
      this.logEntry(plan, { at: this.hooks.nowIso(), stepId: step.id, outcomeKind: 'blocked', transition: 'blocked', reason: `no-presence-for-role:${step.ownerRole}` });
      return { kind: 'blocked', stepId: step.id, reason: `no-presence-for-role:${step.ownerRole}` };
    }

    step.status = 'started';
    this.hooks.audit(plan.planId, step.id, 'started');
    this.logEntry(plan, { at: this.hooks.nowIso(), stepId: step.id, outcomeKind: 'advanced', transition: 'started', presenceId: executor.presenceId, effectKind: step.effectHint.kind });

    const effect: WorldEffect = { kind: step.effectHint.kind, ...(step.effectHint.params ?? {}) } as WorldEffect;
    const emitted = this.hooks.emit(executor.presenceId, effect);

    if (emitted.status === 'rejected') {
      const isHitl = emitted.rejection?.startsWith('hitl-suspended:');
      if (isHitl) {
        // HITL suspension: leave step 'started' (in-flight) so it doesn't re-run
        // until the approval flows back through the ledger and the operator re-runs.
        const approvalId = emitted.rejection!.split(':awaiting-approval:')[1] ?? 'unknown';
        this.hooks.audit(plan.planId, step.id, 'started', `hitl-suspended:${approvalId}`);
        this.logEntry(plan, { at: this.hooks.nowIso(), stepId: step.id, outcomeKind: 'suspended', approvalId, presenceId: executor.presenceId, effectKind: step.effectHint.kind });
        return { kind: 'suspended', stepId: step.id, approvalId };
      }
      step.status = 'aborted';
      this.hooks.audit(plan.planId, step.id, 'aborted', emitted.rejection ?? 'unknown-rejection');
      this.logEntry(plan, { at: this.hooks.nowIso(), stepId: step.id, outcomeKind: 'blocked', transition: 'aborted', reason: emitted.rejection ?? 'rejected', presenceId: executor.presenceId, effectKind: step.effectHint.kind });
      return { kind: 'blocked', stepId: step.id, reason: emitted.rejection ?? 'rejected' };
    }

    step.status = 'completed';
    this.hooks.audit(plan.planId, step.id, 'completed');
    this.logEntry(plan, { at: this.hooks.nowIso(), stepId: step.id, outcomeKind: 'advanced', transition: 'completed', presenceId: executor.presenceId, effectKind: step.effectHint.kind });
    return { kind: 'advanced', stepId: step.id, effect: emitted };
  }

  private logEntry(plan: PlanGraph, entry: PlanRunLogEntry): void {
    const p = plan as PlanWithLog;
    if (!p.runLog) p.runLog = [];
    p.runLog.push(entry);
  }

  /** Run steps until we reach a stable point: complete, aborted, blocked, or all remaining suspended. */
  runAll(plan: PlanGraph, maxIterations: number = 100): PlanRunOutcome[] {
    const outcomes: PlanRunOutcome[] = [];
    for (let i = 0; i < maxIterations; i++) {
      const o = this.step(plan);
      outcomes.push(o);
      if (o.kind === 'complete' || o.kind === 'idle' || o.kind === 'suspended' || o.kind === 'blocked') break;
    }
    return outcomes;
  }
}
