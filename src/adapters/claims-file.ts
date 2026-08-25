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

// Claims flat-file adapter (institutional CSV, one row per claim line).

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export interface ClaimsFileRow {
  readonly claimId: string;
  readonly memberId: string;
  readonly serviceDate: string;
  readonly cpt: string;
  readonly icd10: string;
  readonly chargeAmount: number;
  readonly paidAmount?: number;
  readonly denialReason?: string;
  readonly payerId: string;
}

export interface ClaimsMappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

export function claimsRowsToEvents(rows: readonly ClaimsFileRow[], opts: ClaimsMappingOptions): CanonicalEvent[] {
  return rows.map<CanonicalEvent>((r) => {
    const denied = typeof r.denialReason === 'string' && r.denialReason.length > 0;
    const remitted = typeof r.paidAmount === 'number';
    const type: CanonicalEventType = denied ? 'claim.denied' : remitted ? 'claim.remittance' : 'claim.submitted';
    return {
      id: `event:claims-file:${r.claimId}`,
      type,
      occurredAt: r.serviceDate,
      scopeId: opts.scopeId,
      subjectId: r.memberId,
      facilityId: opts.facilityId,
      payload: {
        claimId: r.claimId,
        cpt: r.cpt,
        icd10: r.icd10,
        chargeAmount: r.chargeAmount,
        ...(r.paidAmount !== undefined ? { paidAmount: r.paidAmount } : {}),
        ...(r.denialReason ? { denialReason: r.denialReason } : {}),
        payerId: r.payerId,
      },
      provenance: { sourceId: opts.sourceId, observedAt: r.serviceDate, ingestedAt: opts.ingestedAt },
      classification: 'phi',
    };
  });
}
