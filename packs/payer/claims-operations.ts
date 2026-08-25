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

// Claims operations — adjudicate submitted claims, mark denials, produce
// remittance events. Uses the harness's canonical claim.* events; this module
// is a state machine that consumes claim.submitted and emits either
// claim.remittance or claim.denied.

import type { CanonicalEvent } from '../../src/healthcare-core/events.js';

export type ClaimAdjudicationOutcome = 'paid' | 'denied' | 'partial-paid' | 'pended';

export interface ClaimAdjudicationInput {
  readonly claimId: string;
  readonly memberId: string;
  readonly cpt: string;
  readonly icd10: string;
  readonly chargeAmount: number;
  readonly coveredAt: string;
}

export interface ClaimAdjudicationResult {
  readonly claimId: string;
  readonly outcome: ClaimAdjudicationOutcome;
  readonly paidAmount: number;
  readonly denialCode?: string;
  readonly denialReason?: string;
  readonly explanationOfBenefits: readonly {
    readonly code: string;
    readonly amount: number;
    readonly reason: string;
  }[];
  readonly adjudicatedAt: string;
}

export interface AdjudicationRuleset {
  readonly id: string;
  readonly version: string;
  adjudicate(claim: ClaimAdjudicationInput): { outcome: ClaimAdjudicationOutcome; paidAmount: number; denialCode?: string; denialReason?: string; eob: ClaimAdjudicationResult['explanationOfBenefits'] };
}

export function adjudicateClaim(
  claim: ClaimAdjudicationInput,
  ruleset: AdjudicationRuleset,
  now: string,
): ClaimAdjudicationResult {
  const r = ruleset.adjudicate(claim);
  return {
    claimId: claim.claimId,
    outcome: r.outcome,
    paidAmount: r.paidAmount,
    ...(r.denialCode ? { denialCode: r.denialCode } : {}),
    ...(r.denialReason ? { denialReason: r.denialReason } : {}),
    explanationOfBenefits: r.eob,
    adjudicatedAt: now,
  };
}

/** Convert an adjudication result into a canonical event for the harness. */
export function adjudicationToEvent(
  result: ClaimAdjudicationResult,
  memberId: string,
  facilityId: string,
  scopeId: string,
  sourceId: string,
): CanonicalEvent {
  const type: CanonicalEvent['type'] = result.outcome === 'denied' ? 'claim.denied' : 'claim.remittance';
  return {
    id: `event:adjudication:${result.claimId}`,
    type,
    occurredAt: result.adjudicatedAt,
    scopeId,
    subjectId: memberId,
    facilityId,
    payload: {
      claimId: result.claimId,
      paidAmount: result.paidAmount,
      outcome: result.outcome,
      ...(result.denialCode ? { denialCode: result.denialCode } : {}),
      ...(result.denialReason ? { denialReason: result.denialReason } : {}),
      eob: result.explanationOfBenefits,
    },
    provenance: { sourceId, observedAt: result.adjudicatedAt, ingestedAt: result.adjudicatedAt },
    classification: 'phi',
  };
}
