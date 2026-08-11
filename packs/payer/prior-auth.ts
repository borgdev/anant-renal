import type { PriorAuthorization, PriorAuthStatus, CriteriaRule } from './ontology.js';

// Prior-auth state machine + a small deterministic auto-adjudicator that
// applies criteria rules. This is intentionally rule-based — the LLM never
// approves or denies on its own in the harness.

const TRANSITIONS: Record<PriorAuthStatus, readonly PriorAuthStatus[]> = {
  received: ['in-review', 'withdrawn'],
  'in-review': ['approved', 'partial-approval', 'denied', 'pended-info'],
  'pended-info': ['in-review', 'withdrawn'],
  approved: [],
  'partial-approval': ['appealed'],
  denied: ['appealed'],
  withdrawn: [],
  appealed: ['appeal-upheld', 'appeal-overturned'],
  'appeal-upheld': [],
  'appeal-overturned': ['approved', 'partial-approval'],
};

export function canAdvancePriorAuth(from: PriorAuthStatus, to: PriorAuthStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function advancePriorAuth(pa: PriorAuthorization, to: PriorAuthStatus, now: string): PriorAuthorization {
  if (!canAdvancePriorAuth(pa.status, to)) {
    throw new Error(`Illegal prior-auth transition ${pa.status} -> ${to}`);
  }
  return Object.freeze({ ...pa, status: to, updatedAt: now });
}

export interface EvidenceBundle {
  attachments: readonly string[];
}

export interface AutoAdjudicationResult {
  decision: 'approved' | 'partial-approval' | 'denied' | 'pended-info';
  matchedRuleIds: string[];
  missingEvidence: string[];
  reason: string;
}

export function autoAdjudicate(pa: PriorAuthorization, evidence: EvidenceBundle, rules: readonly CriteriaRule[]): AutoAdjudicationResult {
  const applicable = rules.filter((r) => r.criteriaSetId === pa.criteriaSetId && r.version === pa.criteriaSetVersion);
  if (applicable.length === 0) {
    return { decision: 'pended-info', matchedRuleIds: [], missingEvidence: [], reason: 'No applicable criteria rules — human review required' };
  }
  const matched: string[] = [];
  const missing: string[] = [];
  for (const rule of applicable) {
    const missingForRule = rule.requiredEvidence.filter((need) => !evidence.attachments.includes(need));
    if (missingForRule.length === 0) matched.push(rule.id);
    else missing.push(...missingForRule);
  }
  if (missing.length > 0 && matched.length === 0) {
    return { decision: 'pended-info', matchedRuleIds: [], missingEvidence: unique(missing), reason: 'Missing required evidence' };
  }
  if (matched.length === applicable.length) {
    return { decision: 'approved', matchedRuleIds: matched, missingEvidence: [], reason: 'All criteria satisfied' };
  }
  if (matched.length > 0) {
    return { decision: 'partial-approval', matchedRuleIds: matched, missingEvidence: unique(missing), reason: 'Some criteria satisfied' };
  }
  return { decision: 'denied', matchedRuleIds: [], missingEvidence: unique(missing), reason: 'No criteria satisfied' };
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
