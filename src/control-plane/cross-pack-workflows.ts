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
