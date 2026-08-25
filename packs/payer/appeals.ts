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

// Appeals — post-denial workflow. CMS-0057-F requires payers to expose
// prior-auth denials and their basis so providers/members can appeal.

export type AppealLevel = 'internal-first' | 'internal-second' | 'external-review';
export type AppealOutcome = 'overturned' | 'upheld' | 'partially-overturned' | 'withdrawn';

export interface PayerAppealCase {
  readonly appealId: string;
  readonly originalCaseId: string; // UM case or claim
  readonly memberId: string;
  readonly submittedAt: string;
  readonly level: AppealLevel;
  readonly rationale: string;
  readonly supportingDocumentIds: readonly string[];
  readonly newClinicalEvidence: readonly string[];
}

export interface AppealDecision {
  readonly appealId: string;
  readonly outcome: AppealOutcome;
  readonly rationale: string;
  readonly reviewer: { readonly ref: string; readonly role: 'nurse' | 'md' | 'external-irb' };
  readonly decidedAt: string;
  readonly slaHours: number;
  readonly nextLevelAvailable?: AppealLevel;
}

/** CMS default timeframes for coverage-decision appeals (illustrative). */
export const APPEAL_SLAS_HOURS: Record<AppealLevel, { standard: number; expedited: number }> = {
  'internal-first': { standard: 30 * 24, expedited: 72 },
  'internal-second': { standard: 60 * 24, expedited: 72 },
  'external-review': { standard: 45 * 24, expedited: 72 },
};

const nextLevel: Record<AppealLevel, AppealLevel | undefined> = {
  'internal-first': 'internal-second',
  'internal-second': 'external-review',
  'external-review': undefined,
};

export function decideAppeal(
  input: PayerAppealCase,
  outcome: AppealOutcome,
  rationale: string,
  reviewer: AppealDecision['reviewer'],
  urgency: 'standard' | 'expedited',
  now: string,
): AppealDecision {
  const slas = APPEAL_SLAS_HOURS[input.level];
  const slaHours = urgency === 'expedited' ? slas.expedited : slas.standard;
  const next = nextLevel[input.level];
  const decision: AppealDecision = {
    appealId: input.appealId,
    outcome,
    rationale,
    reviewer,
    decidedAt: now,
    slaHours,
    ...(next && outcome !== 'overturned' ? { nextLevelAvailable: next } : {}),
  };
  return decision;
}
