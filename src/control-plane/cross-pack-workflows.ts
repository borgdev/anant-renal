/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// Cross-pack workflows. A workflow that spans two or more packs — e.g.
// provider hospitalization notification must open a payer prior-auth
// re-review, or a denied prior-auth must trigger provider rescheduling +
// appeals workflow. These orchestrations are first-class and declarative so
// the harness can enforce policy at each hand-off.

export type CrossPackAction =
  | { readonly kind: 'notify-pack'; readonly packId: string; readonly workflowId: string; readonly payload: Record<string, unknown> }
  | { readonly kind: 'open-case'; readonly packId: string; readonly caseKind: string; readonly payload: Record<string, unknown> }
  | { readonly kind: 'audit'; readonly action: string; readonly payload: Record<string, unknown> };

export interface CrossPackWorkflow {
  readonly id: string;
  readonly trigger: {
    readonly eventType: string;
    readonly sourcePackId: string;
  };
  readonly requiredScopes: readonly string[];
  readonly actions: readonly CrossPackAction[];
  readonly slaHours?: number;
  readonly citation?: string;
}

export const HOSPITALIZATION_TO_PAYER_AUTH: CrossPackWorkflow = Object.freeze({
  id: 'x:hospitalization->payer-auth',
  trigger: { eventType: 'hospitalization.admitted', sourcePackId: 'dialysis-provider' },
  requiredScopes: ['patient.encounter', 'payer.utilization-management'],
  actions: [
    { kind: 'audit' as const, action: 'hospitalization-recorded', payload: {} },
    { kind: 'notify-pack' as const, packId: 'payer', workflowId: 'utilization-management.re-review', payload: { reason: 'hospitalization' } },
    { kind: 'open-case' as const, packId: 'care-management', caseKind: 'transitions-of-care', payload: {} },
  ],
  slaHours: 24,
});

export const DENIED_AUTH_TO_RESCHEDULE_AND_APPEAL: CrossPackWorkflow = Object.freeze({
  id: 'x:denied-auth->reschedule+appeal',
  trigger: { eventType: 'prior-auth.denied', sourcePackId: 'payer' },
  requiredScopes: ['provider.scheduling', 'payer.appeals'],
  actions: [
    { kind: 'audit' as const, action: 'auth-denial-recorded', payload: {} },
    { kind: 'notify-pack' as const, packId: 'dialysis-provider', workflowId: 'scheduling.recovery', payload: { reason: 'auth-denied' } },
    { kind: 'open-case' as const, packId: 'payer', caseKind: 'appeals-internal-first', payload: {} },
  ],
  slaHours: 72,
});

export const ONCOLOGY_PLAN_TO_PRIOR_AUTH: CrossPackWorkflow = Object.freeze({
  id: 'x:oncology-plan->prior-auth',
  trigger: { eventType: 'oncology.plan-approved', sourcePackId: 'oncology-provider' },
  requiredScopes: ['provider.treatment-plan', 'payer.prior-authorization'],
  actions: [
    { kind: 'audit' as const, action: 'plan-approved', payload: {} },
    { kind: 'notify-pack' as const, packId: 'payer', workflowId: 'prior-auth.submit', payload: { serviceType: 'chemotherapy-regimen' } },
  ],
  slaHours: 72,
});

export const seedCrossPackWorkflows: readonly CrossPackWorkflow[] = Object.freeze([
  HOSPITALIZATION_TO_PAYER_AUTH,
  DENIED_AUTH_TO_RESCHEDULE_AND_APPEAL,
  ONCOLOGY_PLAN_TO_PRIOR_AUTH,
]);

export class CrossPackRouter {
  private readonly workflows = new Map<string, CrossPackWorkflow>();
  constructor(seed: readonly CrossPackWorkflow[] = seedCrossPackWorkflows) {
    for (const w of seed) this.workflows.set(w.id, w);
  }
  register(w: CrossPackWorkflow): void { this.workflows.set(w.id, w); }
  routeEvent(eventType: string, sourcePackId: string): readonly CrossPackWorkflow[] {
    return Array.from(this.workflows.values()).filter((w) => w.trigger.eventType === eventType && w.trigger.sourcePackId === sourcePackId);
  }
  all(): readonly CrossPackWorkflow[] { return Array.from(this.workflows.values()); }
}

/* ======================================================================
 * G3 — the workflow does not own the declaration; the PACKS do.
 * ====================================================================== */

/**
 * One pack's participation in a cross-pack workflow, as its manifest declares it.
 *
 * The manifest carries no trigger and no actions — those are code, and they live
 * in `seedCrossPackWorkflows`. What the manifest carries is the fact that the
 * packs involved AGREE the hand-off exists, which is the thing that was missing:
 * `pack-resources.ts` has always refused a workflow declared by one side only,
 * but no manifest declared any of these three, so the check passed over an EMPTY
 * set. It enforced a rule over a set disjoint from the one the router served.
 */
export interface CrossPackParticipation {
  readonly workflowId: string;
  /** pack id → the partners that pack named for this workflow */
  readonly declaredBy: ReadonlyMap<string, readonly string[]>;
}

export interface CrossPackSeedIssue {
  readonly workflowId: string;
  readonly code: 'undeclared' | 'partial-participation' | 'no-definition';
  readonly detail: string;
}

export interface CrossPackSeedResult {
  readonly router: CrossPackRouter;
  /** Workflow ids that every participating pack mutually declared. */
  readonly running: readonly string[];
  /** Declarations that did NOT become a running workflow, each with its reason. */
  readonly notRunning: readonly CrossPackSeedIssue[];
}

/** Every pack a workflow's definition involves: the source, plus every target. */
function participantsOf(workflow: CrossPackWorkflow): string[] {
  const out = new Set<string>([workflow.trigger.sourcePackId]);
  for (const action of workflow.actions) {
    if (action.kind === 'notify-pack' || action.kind === 'open-case') out.add(action.packId);
  }
  return [...out].sort();
}

/**
 * Read the cross-pack workflow declarations out of a manifest set.
 *
 * Pure, so it can be asserted directly, and so the caller cannot accidentally
 * hand the router a set that the contract never saw.
 */
export function crossPackParticipations(
  manifests: readonly { readonly id: string; readonly specialty: { readonly workflows?: readonly { readonly id: string; readonly crossPackWith?: readonly string[] }[] } }[],
): readonly CrossPackParticipation[] {
  const byWorkflow = new Map<string, Map<string, readonly string[]>>();
  for (const manifest of manifests) {
    for (const workflow of manifest.specialty.workflows ?? []) {
      if (!workflow.crossPackWith?.length) continue;
      const owners = byWorkflow.get(workflow.id) ?? new Map<string, readonly string[]>();
      owners.set(manifest.id, workflow.crossPackWith);
      byWorkflow.set(workflow.id, owners);
    }
  }
  return [...byWorkflow.entries()].map(([workflowId, declaredBy]) => ({ workflowId, declaredBy }));
}

/**
 * Build the router from the DECLARED set, not from the seed.
 *
 * A definition whose participants did not all declare it does not run. That is a
 * real behaviour change and the whole point: before this the router carried
 * `seedCrossPackWorkflows` unconditionally, so a hand-off no pack had agreed to
 * would fire anyway — and the third one did exactly that, triggering on
 * `oncology.plan-approved`, which is not a canonical event type in
 * `src/healthcare-core/events.ts` and is declared by no pack.
 *
 * `notRunning` is returned rather than only logged, because "a declared hand-off
 * that does not run" and "a hand-off nobody declared" are different problems and
 * an operator needs to be told which one they have.
 */
export function crossPackRouterFromManifests(
  manifests: Parameters<typeof crossPackParticipations>[0],
  definitions: readonly CrossPackWorkflow[] = seedCrossPackWorkflows,
): CrossPackSeedResult {
  const declared = new Map(
    crossPackParticipations(manifests).map((p) => [p.workflowId, p.declaredBy]),
  );
  const running: CrossPackWorkflow[] = [];
  const notRunning: CrossPackSeedIssue[] = [];

  for (const workflow of definitions) {
    const owners = declared.get(workflow.id);
    if (!owners || owners.size === 0) {
      notRunning.push({
        workflowId: workflow.id,
        code: 'undeclared',
        detail: `no pack declares "${workflow.id}", so the hand-off exists only in platform code — it would fire without any pack having agreed it exists`,
      });
      continue;
    }
    const participants = participantsOf(workflow);
    const silent = participants.filter((packId) => !owners.has(packId));
    const notNaming = participants.filter((packId) => {
      const named = owners.get(packId);
      if (!named) return false;
      // A pack that declares the workflow but names nobody has still declared it;
      // `pack-resources` owns the one-sided verdict. Requiring the names here too
      // would be a second, subtly different rule for the same fact.
      return named.length > 0 && !participants.some((other) => other !== packId && named.includes(other));
    });
    if (silent.length > 0 || notNaming.length > 0) {
      notRunning.push({
        workflowId: workflow.id,
        code: 'partial-participation',
        detail: `${workflow.id} is declared by ${[...owners.keys()].join(', ')} but its definition also involves ${participants.join(', ')} — not every participant agreed`,
      });
      continue;
    }
    running.push(workflow);
  }

  for (const workflowId of declared.keys()) {
    if (definitions.some((d) => d.id === workflowId)) continue;
    notRunning.push({
      workflowId,
      code: 'no-definition',
      detail: `packs declare "${workflowId}" but the platform has no definition for it, so the declaration routes nowhere`,
    });
  }

  return { router: new CrossPackRouter(running), running: running.map((w) => w.id), notRunning };
}

/* ---------- firing ---------- */

/** What one action actually did. `executed: false` carries the reason. */
export interface CrossPackActionOutcome {
  readonly kind: CrossPackAction['kind'];
  readonly detail: string;
  readonly executed: boolean;
}

export interface CrossPackFiring {
  readonly workflowId: string;
  readonly eventType: string;
  readonly at: string;
  readonly eventId?: string;
  readonly outcomes: readonly CrossPackActionOutcome[];
}

export interface CrossPackHandlers {
  /** Record the audit trail for a triggered hand-off. */
  readonly onAudit?: (action: Extract<CrossPackAction, { kind: 'audit' }>, workflow: CrossPackWorkflow) => void;
  /** Hand the target pack a workflow to run. */
  readonly onNotify?: (action: Extract<CrossPackAction, { kind: 'notify-pack' }>, workflow: CrossPackWorkflow) => void;
  /** Open a durable case. Absent ⇒ reported as not executed, never as done. */
  readonly onOpenCase?: (action: Extract<CrossPackAction, { kind: 'open-case' }>, workflow: CrossPackWorkflow) => void;
}

const FIRING_LOG_LIMIT = 50;

/**
 * Firings, most recent last, bounded.
 *
 * Kept in-process and bounded on purpose: this is an observability surface for
 * "is the hand-off actually running", not a durable record. The durable record is
 * the audit trail the `audit` action writes, which is why that action is the one
 * that must never be skipped.
 */
const firings: CrossPackFiring[] = [];

export function recentCrossPackFirings(): readonly CrossPackFiring[] {
  return [...firings];
}

export function resetCrossPackFirings(): void {
  firings.length = 0;
}

/**
 * Route one canonical event through the declared workflows.
 *
 * Every action reports what it did. An action with no handler is recorded as
 * `executed: false` WITH the reason, rather than quietly omitted — the defect this
 * whole gap is about is a hand-off that looks wired and does nothing, and a log
 * that only records successes would reproduce it in the observability layer.
 */
export function handleCrossPackEvent(
  router: CrossPackRouter,
  event: { readonly type: string; readonly id?: string; readonly sourcePackId?: string },
  handlers: CrossPackHandlers = {},
): readonly CrossPackFiring[] {
  const fired: CrossPackFiring[] = [];
  // A canonical event carries no pack id, so the trigger's `sourcePackId` is the
  // declaration of who publishes it. Matching on it is what keeps a hand-off from
  // firing on someone else's event of the same name — the two are different facts
  // and only the declaration knows the second one.
  const matched = router.all().filter((w) => w.trigger.eventType === event.type);
  for (const workflow of matched) {
    if (event.sourcePackId && workflow.trigger.sourcePackId !== event.sourcePackId) continue;
    const outcomes: CrossPackActionOutcome[] = workflow.actions.map((action) => {
      switch (action.kind) {
        case 'audit':
          if (!handlers.onAudit) return { kind: action.kind, detail: action.action, executed: false };
          handlers.onAudit(action, workflow);
          return { kind: action.kind, detail: action.action, executed: true };
        case 'notify-pack':
          if (!handlers.onNotify) {
            return { kind: action.kind, detail: `${action.packId} ← ${action.workflowId}`, executed: false };
          }
          handlers.onNotify(action, workflow);
          return { kind: action.kind, detail: `${action.packId} ← ${action.workflowId}`, executed: true };
        case 'open-case':
          if (!handlers.onOpenCase) {
            return { kind: action.kind, detail: `${action.packId}: ${action.caseKind}`, executed: false };
          }
          handlers.onOpenCase(action, workflow);
          return { kind: action.kind, detail: `${action.packId}: ${action.caseKind}`, executed: true };
      }
    });
    const firing: CrossPackFiring = {
      workflowId: workflow.id,
      eventType: event.type,
      at: new Date().toISOString(),
      ...(event.id ? { eventId: event.id } : {}),
      outcomes,
    };
    // BOTH: the log is the observability surface, the return value is what the
    // caller acts on. Recording only in the log made `handleCrossPackEvent` always
    // return an empty array — a function that looks like it reports what happened
    // and never does, which is the defect this module is fixing, one layer in.
    firings.push(firing);
    fired.push(firing);
  }
  while (firings.length > FIRING_LOG_LIMIT) firings.shift();
  return fired;
}

/* ---------- the process-wide instance ---------- */

let active: { router: CrossPackRouter; running: readonly string[]; notRunning: readonly CrossPackSeedIssue[] } | undefined;

/** Install the router built from the installed pack set. Called at registration. */
export function setCrossPackRouter(seed: CrossPackSeedResult): void {
  active = { router: seed.router, running: seed.running, notRunning: seed.notRunning };
}

export function crossPackRouterState(): typeof active {
  return active;
}

