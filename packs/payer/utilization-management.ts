// Utilization management (UM) — a payer's core operational function: deciding
// whether requested services are medically necessary and covered before they
// are rendered. UM decisions consume prior-auth requests + clinical criteria
// and emit approve / deny / pend / peer-review outcomes. Every decision must
// cite the applied criteria document and preserve independent-review basis.

export type UMOutcome = 'approved' | 'denied' | 'pended' | 'partially-approved' | 'peer-review-requested';

export interface UMDecision {
  readonly caseId: string;
  readonly outcome: UMOutcome;
  readonly reasonCode: string;
  readonly appliedCriteria: {
    readonly documentId: string;
    readonly version: string;
    readonly section?: string;
  };
  readonly reviewer: { readonly ref: string; readonly role: 'nurse' | 'md' | 'automated-rule' };
  readonly decidedAt: string;
  readonly slaHours?: number; // CMS-0057-F expedited=72h, standard=7d starting 2026
  readonly independentReviewBasis: readonly string[]; // FDA non-device-CDS transparency
  readonly nextStep: 'notify-provider' | 'notify-member' | 'schedule-peer' | 'process-appeal';
}

export const CMS_0057_F_TIMEFRAMES = {
  standardDecisionMaxHours: 7 * 24, // 7 calendar days
  expeditedDecisionMaxHours: 72,
  submitPriorAuthDecisionApi: 'FHIR Prior Authorization API',
  effectiveFrom: '2027-01-01',
} as const;

export interface UMCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly serviceCode: string;
  readonly requestedAt: string;
  readonly urgency: 'standard' | 'expedited';
  readonly submittedBy: string;
  readonly clinicalDocumentIds: readonly string[];
}

/**
 * Deterministically decide a UM case given a criteria evaluator. The criteria
 * evaluator is injected: real deployments plug in InterQual / MCG / plan-
 * specific rules. The harness only enforces the *decision envelope* — SLA,
 * criteria citation, independent-review basis capture.
 */
export function decideUMCase(
  input: UMCase,
  now: string,
  evaluate: (c: UMCase) => { outcome: UMOutcome; reasonCode: string; basis: readonly string[]; criteriaDocumentId: string; criteriaVersion: string; criteriaSection?: string },
  reviewer: { ref: string; role: 'nurse' | 'md' | 'automated-rule' },
): UMDecision {
  const r = evaluate(input);
  const slaHours = input.urgency === 'expedited' ? CMS_0057_F_TIMEFRAMES.expeditedDecisionMaxHours : CMS_0057_F_TIMEFRAMES.standardDecisionMaxHours;
  const nextStep: UMDecision['nextStep'] =
    r.outcome === 'denied' ? 'notify-member' :
    r.outcome === 'peer-review-requested' ? 'schedule-peer' :
    r.outcome === 'pended' ? 'notify-provider' :
    'notify-provider';
  return {
    caseId: input.caseId,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
    appliedCriteria: {
      documentId: r.criteriaDocumentId,
      version: r.criteriaVersion,
      ...(r.criteriaSection ? { section: r.criteriaSection } : {}),
    },
    reviewer,
    decidedAt: now,
    slaHours,
    independentReviewBasis: r.basis,
    nextStep,
  };
}
