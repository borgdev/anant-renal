/******************************************************************************
 * Payer proof pack (port plan Phase 5 / Epic 7).
 *
 * The docs require a SECOND pack that closes a payer journey through the SAME
 * platform primitives — no runtime fork. This module supplies the payer lens:
 *
 *   • PAYER_CELLS — bounded payer cells (care gap, utilization, authorization,
 *     network access, payment integrity, member assessment) using the exact
 *     CellManifest contract as the 12 renal cells.
 *   • PAYER_ORG — a payer operating-model organization (enterprise → line of
 *     business → market → plan → network → cohort).
 *   • buildPayerDemo — a deterministic payer reference boundary (proposals,
 *     insights, NBAs) mirroring the renal demo.
 *   • seedPayerEpisodes — durable payer outcome episodes on the SHARED
 *     PersistentOutcomeCoordinator, so they flow into My Work (/api/work) and
 *     the exec console exactly like renal episodes. Idempotent.
 *   • dropPayerEpisodes — targeted reset (removes only payer episodes).
 *
 * Safety boundary (spec §16.4): no autonomous denial; authorization/utilization
 * and appeal outcomes require authorized human review; payment-integrity cells
 * prepare evidence and review tasks, never payment holds.
 ******************************************************************************/

import type { CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import { OutcomeEpisodeCoordinator, type OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef, ScopeType } from './types.js';
import type { PlatformOrganization } from './workspace.js';
import type { SwarmWorkspaceStore } from './workspace.js';

/** Payer bounded cells — the same CellManifest contract as the renal cells. */
export const PAYER_CELLS: CellManifest[] = [
  {
    id: 'care-gap-closure', version: '1.0.0', displayName: 'Care-gap closure',
    domain: 'quality', owner: 'Quality / Stars',
    consumes: ['care-gap.opened', 'care-gap.closed', 'claim.submitted', 'assessment.response'],
    produces: ['care-gap.signal', 'care-gap.proposal'],
    allowedActions: ['schedule-followup', 'notify-staff', 'open-ticket'],
    approvalClass: 'B', evalGate: 0.92, killSwitch: false, rollback: true,
    observerRef: 'packs/payer/care-management.ts + packs/payer/network-and-benefits.ts',
  },
  {
    id: 'utilization-review', version: '1.0.0', displayName: 'Utilization review',
    domain: 'quality', owner: 'Utilization Management',
    consumes: ['claim.submitted', 'authorization.requested', 'utilization.flag'],
    produces: ['utilization.signal', 'utilization.proposal'],
    allowedActions: ['open-ticket', 'notify-staff', 'submit-intent', 'flag-safety-event'],
    approvalClass: 'C', evalGate: 0.94, killSwitch: false, rollback: true,
    observerRef: 'packs/payer/utilization-management.ts',
  },
  {
    id: 'authorization-um', version: '1.0.0', displayName: 'Authorization / UM',
    domain: 'quality', owner: 'Medical Director',
    consumes: ['prior-auth.received', 'authorization.requested', 'criteria.matched'],
    produces: ['authorization.recommendation', 'authorization.proposal'],
    allowedActions: ['request-prior-auth', 'submit-intent', 'open-ticket'],
    approvalClass: 'C', evalGate: 0.96, killSwitch: false, rollback: true,
    observerRef: 'packs/payer/prior-auth.ts autoAdjudicate',
  },
  {
    id: 'network-access', version: '1.0.0', displayName: 'Network access',
    domain: 'operations', owner: 'Network Operations',
    consumes: ['appointment.access', 'network.adequacy', 'provider.schedule'],
    produces: ['access.signal', 'network.proposal'],
    allowedActions: ['schedule-followup', 'open-ticket', 'submit-intent'],
    approvalClass: 'B', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'packs/payer/network-and-benefits.ts',
  },
  {
    id: 'payment-integrity', version: '1.0.0', displayName: 'Payment integrity',
    domain: 'business', owner: 'Payment Integrity',
    consumes: ['claim.submitted', 'claim.adjudicated', 'claim.denied', 'remittance'],
    produces: ['anomaly.signal', 'payment.proposal'],
    allowedActions: ['submit-intent', 'open-ticket', 'notify-staff'],
    approvalClass: 'B', evalGate: 0.93, killSwitch: false, rollback: true,
    observerRef: 'packs/payer/claims-operations.ts',
  },
  {
    id: 'member-assessment', version: '1.0.0', displayName: 'Member assessment',
    domain: 'quality', owner: 'Member Experience',
    consumes: ['assessment.response', 'sdoh.signal', 'contact.attempted'],
    produces: ['barrier.signal', 'member.proposal'],
    allowedActions: ['schedule-followup', 'notify-staff', 'open-ticket'],
    approvalClass: 'B', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'packs/payer/care-management.ts',
  },
];

/** Consumers per payer signal kind — which payer cells observe which signals. */
export const PAYER_CONSUMED_BY: Record<string, string[]> = {
  'care-gap.proposal': ['care-gap-closure', 'member-assessment'],
  'authorization.proposal': ['authorization-um', 'utilization-review', 'payment-integrity'],
  'network.proposal': ['network-access', 'care-gap-closure'],
  'utilization.proposal': ['utilization-review', 'payment-integrity'],
  'payment.proposal': ['payment-integrity', 'utilization-review'],
  'member.proposal': ['member-assessment', 'care-gap-closure'],
};

/** Payer episode kinds — used to scope payer work and reset. */
export const PAYER_EPISODE_KINDS = ['care-gap.closure', 'authorization.review', 'network.access', 'utilization.review'] as const;

/** Payer operating-model organization seed (enterprise → LOB → market → plan → network → cohort). */
export const PAYER_ORG: Omit<PlatformOrganization, 'id' | 'createdAt' | 'updatedAt'> = {
  operatingModel: 'payer',
  displayName: 'Riverbend Health Plan',
  region: 'us-south',
  timezone: 'America/Chicago',
  retentionDays: 365,
  scopePath: [
    { id: 'ent', level: 'enterprise', label: 'Enterprise' },
    { id: 'lob', level: 'division', label: 'Medicare Advantage LOB' },
    { id: 'market', level: 'market', label: 'Tennessee Market' },
    { id: 'plan', level: 'plan', label: 'MA HMO 2026' },
    { id: 'network', level: 'network', label: 'Nashville Network' },
    { id: 'cohort', level: 'cohort', label: 'Diabetes Cohort' },
  ],
  synthetic: true,
};

export interface PayerDemoState {
  source: 'payer';
  cells: CellManifest[];
  org: Omit<PlatformOrganization, 'id' | 'createdAt' | 'updatedAt'>;
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  episodes: OutcomeEpisode[];
  kpis: { careGaps: number; reviewsRequired: number; networkAccess: number; valueAtRisk: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

/** Deterministic payer reference boundary — proposals, insights, ranked NBAs. */
export function buildPayerDemo(now: () => string = NOW): Omit<PayerDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    // 1 · HEDIS diabetes care gap — two cells converge on outreach + lab order.
    makeProposal({ cellId: 'care-gap-closure', kind: 'care-gap.proposal', subject: 'member:m-1042', scopeType: 'patient', option: 'evidence-based outreach + lab order', recommendation: 'Member has an open HEDIS diabetes HbA1c care gap; evidence-based outreach and a standing lab order would close it this quarter.', allowed: true, evidence: [ev('care-gap.opened', 'fact'), ev('claim.submitted', 'event')], producedAt: now(), payload: { gap: 'HEDIS · diabetes HbA1c', outreach: 'text + live agent' } }),
    makeProposal({ cellId: 'member-assessment', kind: 'care-gap.proposal', subject: 'member:m-1042', scopeType: 'patient', option: 'evidence-based outreach + lab order', recommendation: 'Member consent and language preference support a text-first outreach; no clinical inference is made.', allowed: true, evidence: [ev('assessment.response', 'fact'), ev('contact.attempted', 'signal')], producedAt: now(), payload: { channel: 'text' } }),
    // 2 · Pended MRI authorization — UM + authorization converge; payment dissents (retained conflict).
    makeProposal({ cellId: 'authorization-um', kind: 'authorization.proposal', subject: 'prior-auth:PA-8821', scopeType: 'patient', option: 'evidence-complete human review', recommendation: 'MRI authorization is pended for a missing neurology note; medical policy supports an evidence-complete human review.', allowed: true, evidence: [ev('prior-auth.received', 'event'), ev('criteria.matched', 'fact')], producedAt: now(), payload: { serviceCode: 'MRI', criteriaSet: 'c-neuro-2026.1' } }),
    makeProposal({ cellId: 'utilization-review', kind: 'authorization.proposal', subject: 'prior-auth:PA-8821', scopeType: 'patient', option: 'evidence-complete human review', recommendation: 'Utilization pattern is within norms; route to medical director with the pended evidence.', allowed: true, evidence: [ev('utilization.flag', 'signal')], producedAt: now(), payload: {} }),
    makeProposal({ cellId: 'payment-integrity', kind: 'authorization.proposal', subject: 'prior-auth:PA-8821', scopeType: 'patient', option: 'defer to medical policy', recommendation: 'No payment anomaly; defer to the medical policy outcome.', allowed: true, evidence: [ev('claim.adjudicated', 'event')], producedAt: now(), payload: {} }),
    // 3 · Network access shortfall — network + care-gap converge on steering.
    makeProposal({ cellId: 'network-access', kind: 'network.proposal', subject: 'network:nashville', scopeType: 'market', option: 'steer to in-network capacity', recommendation: 'New specialist referrals wait > 14 days; steering to in-network capacity restores appointment access within 7.', allowed: true, evidence: [ev('appointment.access', 'signal'), ev('network.adequacy', 'fact')], producedAt: now(), payload: { waitDays: 14, targetDays: 7 } }),
    makeProposal({ cellId: 'care-gap-closure', kind: 'network.proposal', subject: 'network:nashville', scopeType: 'market', option: 'steer to in-network capacity', recommendation: 'Timely access also supports care-gap closure for the diabetes cohort.', allowed: true, evidence: [ev('care-gap.opened', 'fact')], producedAt: now(), payload: { cohort: 'diabetes' } }),
    // 4 · Payment integrity — duplicate service anomaly → evidence review task.
    makeProposal({ cellId: 'payment-integrity', kind: 'payment.proposal', subject: 'claim:C-55231', scopeType: 'division', option: 'review duplicate service evidence', recommendation: 'A duplicate service indicator warrants an evidence review task — not an automatic payment hold.', allowed: true, evidence: [ev('claim.submitted', 'event'), ev('remittance', 'event')], producedAt: now(), payload: { valueUsd: 12400 } }),
    makeProposal({ cellId: 'utilization-review', kind: 'payment.proposal', subject: 'claim:C-55231', scopeType: 'division', option: 'review duplicate service evidence', recommendation: 'Utilization history supports a review task before any payment action.', allowed: true, evidence: [ev('utilization.flag', 'signal')], producedAt: now(), payload: {} }),
  ];

  const insights = aggregateSwarmInsights({ proposals, consumedBy: PAYER_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;

  const candidates: NbaCandidate[] = [
    { title: 'Close diabetes care-gap for 214 members', cells: ['care gap', 'member'], scopeType: 'patient', subject: 'member:m-1042', owner: 'Case Manager', due: 'This quarter', evidence: Array.from({ length: 12 }, (_, i) => ev(`ev:${i}`, 'object')), consensus: 0.95, approvalClass: 'B', expectedOutcome: 214, urgency: 0.85, policyCost: 0.3, risk: 0.15, insightKind: 'care-gap.proposal' },
    { title: 'Evidence-complete MRI authorization review', cells: ['authorization', 'utilization'], scopeType: 'patient', subject: 'prior-auth:PA-8821', owner: 'Medical Director', due: 'Today', evidence: Array.from({ length: 16 }, (_, i) => ev(`ev:${i}`, 'object')), consensus: 0.9, approvalClass: 'C', expectedOutcome: 1, urgency: 0.9, policyCost: 0.6, risk: 0.25, insightKind: 'authorization.proposal' },
    { title: 'Restore network appointment access', cells: ['network'], scopeType: 'market', subject: 'network:nashville', owner: 'Network Operations Leader', due: 'This week', evidence: Array.from({ length: 18 }, (_, i) => ev(`ev:${i}`, 'object')), consensus: 0.93, approvalClass: 'B', expectedOutcome: 48, urgency: 0.7, policyCost: 0.35, risk: 0.2, insightKind: 'network.proposal' },
    { title: 'Review duplicate-service claim evidence', cells: ['payment integrity'], scopeType: 'division', subject: 'claim:C-55231', owner: 'Payment Integrity Leader', due: '48 hours', evidence: Array.from({ length: 20 }, (_, i) => ev(`ev:${i}`, 'object')), consensus: 0.92, approvalClass: 'B', expectedOutcome: 12400, urgency: 0.65, policyCost: 0.4, risk: 0.1, insightKind: 'payment.proposal' },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true });

  return {
    source: 'payer',
    cells: PAYER_CELLS,
    org: PAYER_ORG,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { careGaps: 214, reviewsRequired: 18, networkAccess: 94.6, valueAtRisk: 1240000 },
  };
}

/** Derive the payer episodes currently open on the shared coordinator. */
export function payerEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (PAYER_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/**
 * Seed durable payer outcome episodes on the SHARED coordinator (idempotent):
 *   1. care-gap.closure   — awaiting approval (Class B)   → shows in My Work
 *   2. authorization.review — awaiting approval (Class C) → shows in My Work
 *   3. network.access     — FULL closed loop (approve → command → ack → verify)
 * Identity is (kind, subject, scopeType) and ANY existing episode — including a
 * terminal one — suppresses re-seeding, so repeated calls never churn episodes.
 */
export async function seedPayerEpisodes(coordinator: PersistentOutcomeCoordinator, _ws?: SwarmWorkspaceStore, now: () => string = NOW): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const findPayer = (kind: string, subject: string, scopeType: ScopeType): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === kind && e.subject === subject && e.scopeType === scopeType);

  const gap = findPayer('care-gap.closure', 'member:m-1042', 'patient');
  if (!gap) {
    const e = coordinator.open({ kind: 'care-gap.closure', subject: 'member:m-1042', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('care-gap.opened', 'fact'), ev('claim.submitted', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({ cellId: 'care-gap-closure', kind: 'care-gap.proposal', subject: e.subject, scopeType: 'patient', option: 'evidence-based outreach + lab order', recommendation: 'Contact member m-1042 and order HbA1c to close the diabetes care gap.', allowed: true, evidence: [ev('care-gap.opened', 'fact')], producedAt: now(), approvalClass: 'B', payload: { gap: 'HEDIS · diabetes HbA1c' } }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    opened.push(e.episodeId);
  } else {
    existing.push(gap.episodeId);
  }

  const auth = findPayer('authorization.review', 'prior-auth:PA-8821', 'patient');
  if (!auth) {
    const e = coordinator.open({ kind: 'authorization.review', subject: 'prior-auth:PA-8821', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('prior-auth.received', 'event'), ev('criteria.matched', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({ cellId: 'authorization-um', kind: 'authorization.proposal', subject: e.subject, scopeType: 'patient', option: 'evidence-complete human review', recommendation: 'Review the pended MRI authorization against medical policy before any decision.', allowed: true, evidence: [ev('prior-auth.received', 'event')], producedAt: now(), approvalClass: 'C', payload: { serviceCode: 'MRI', criteriaSet: 'c-neuro-2026.1' } }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(auth.episodeId);
  }

  const net = findPayer('network.access', 'network:nashville', 'market');
  if (!net) {
    const e = coordinator.open({ kind: 'network.access', subject: 'network:nashville', scopeType: 'market' });
    coordinator.addEvidence(e.episodeId, [ev('appointment.access', 'signal'), ev('network.adequacy', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({ cellId: 'network-access', kind: 'network.proposal', subject: e.subject, scopeType: 'market', option: 'steer to in-network capacity', recommendation: 'Steer new specialty referrals to in-network capacity within 7 days.', allowed: true, evidence: [ev('appointment.access', 'signal')], producedAt: now(), approvalClass: 'B', payload: { days: 7 } }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Network Operations Leader', 'B');
    coordinator.dispatchCommand(e.episodeId, 'schedule-followup');
    coordinator.acknowledge(e.episodeId, 'network:nashville');
    coordinator.verify(e.episodeId, { measureId: 'hedis:appointment-access', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(net.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY payer episodes (in-memory + durable). */
export async function dropPayerEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = payerEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

/** Convenience re-export for the route layer — build a reference coordinator is
 *  NOT needed; the shared persistent coordinator is passed in. */
export type { OutcomeEpisode };
