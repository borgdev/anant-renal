// QAPI evidence-packet generator. CMS surveys ESRD facilities against
// 42 CFR 494.110 (QAPI). A facility must show an interdisciplinary team,
// written QAPI plan, evidence of monitoring + intervention + evaluation, and
// discoverable root-cause analyses of adverse events. This module ships the
// schema + a deterministic packet generator that composes the required
// artifacts from harness events + workflow state.

import type { DataQualityFinding } from '../../../src/healthcare-core/data-quality.js';

export interface QAPIPlan {
  readonly facilityId: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly interdisciplinaryTeam: readonly { readonly ref: string; readonly role: 'medical-director' | 'facility-administrator' | 'nurse-manager' | 'social-worker' | 'renal-dietitian' | 'patient-representative' | 'quality-lead' }[];
  readonly meetingCadence: 'monthly' | 'bi-monthly' | 'quarterly';
  readonly priorityAreas: readonly string[];
  readonly writtenPolicyDocumentId: string;
}

export interface QAPIProjectRecord {
  readonly projectId: string;
  readonly facilityId: string;
  readonly startedAt: string;
  readonly title: string;
  readonly problemStatement: string;
  readonly aim: string;
  readonly measures: readonly { readonly id: string; readonly baseline: number; readonly goal: number; readonly current?: number }[];
  readonly interventions: readonly { readonly at: string; readonly description: string; readonly ownerRef: string }[];
  readonly outcomes: readonly { readonly evaluatedAt: string; readonly summary: string }[];
  readonly status: 'active' | 'closed-sustained' | 'closed-abandoned';
}

export interface AdverseEventInvestigation {
  readonly investigationId: string;
  readonly facilityId: string;
  readonly eventOccurredAt: string;
  readonly eventKind: 'access-complication' | 'water-treatment-failure' | 'medication-error' | 'infection' | 'fall' | 'other';
  readonly rootCauses: readonly string[];
  readonly correctiveActions: readonly { readonly at: string; readonly description: string; readonly ownerRef: string; readonly completedAt?: string }[];
  readonly followUpAt: string;
}

export interface QAPIEvidencePacket {
  readonly facilityId: string;
  readonly reviewPeriod: { readonly from: string; readonly to: string };
  readonly plan: QAPIPlan;
  readonly projects: readonly QAPIProjectRecord[];
  readonly investigations: readonly AdverseEventInvestigation[];
  readonly outstandingDataQualityFindings: readonly DataQualityFinding[];
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly cmsSurveyReady: boolean;
  readonly gaps: readonly string[];
}

export function generateQAPIPacket(input: {
  facilityId: string;
  reviewFrom: string;
  reviewTo: string;
  plan: QAPIPlan;
  projects: readonly QAPIProjectRecord[];
  investigations: readonly AdverseEventInvestigation[];
  dqFindings: readonly DataQualityFinding[];
  generatedBy: string;
  now: string;
}): QAPIEvidencePacket {
  const gaps: string[] = [];
  const required = ['medical-director', 'facility-administrator', 'nurse-manager', 'social-worker', 'renal-dietitian'] as const;
  const roles = new Set(input.plan.interdisciplinaryTeam.map((m) => m.role));
  for (const r of required) if (!roles.has(r)) gaps.push(`Missing IDT role: ${r}`);
  if (input.projects.length === 0) gaps.push('No active QAPI projects');
  if (input.dqFindings.some((f) => f.severity === 'critical')) gaps.push('Critical data-quality findings unresolved');
  const investigationsWithOpenActions = input.investigations.filter((iv) => iv.correctiveActions.some((a) => !a.completedAt));
  if (investigationsWithOpenActions.length > 0) gaps.push(`${investigationsWithOpenActions.length} investigations with open corrective actions`);

  return {
    facilityId: input.facilityId,
    reviewPeriod: { from: input.reviewFrom, to: input.reviewTo },
    plan: input.plan,
    projects: input.projects,
    investigations: input.investigations,
    outstandingDataQualityFindings: input.dqFindings.filter((f) => f.severity === 'error' || f.severity === 'critical'),
    generatedAt: input.now,
    generatedBy: input.generatedBy,
    cmsSurveyReady: gaps.length === 0,
    gaps,
  };
}
