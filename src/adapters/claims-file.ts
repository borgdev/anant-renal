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
