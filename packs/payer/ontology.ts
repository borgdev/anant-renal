// Payer pack ontology. Kept close to standard UM language: authorization,
// medical-necessity criteria, adverse decision + appeal. Every case carries
// the criteria set version used, so retro-review is reproducible.

export type PriorAuthStatus =
  | 'received'
  | 'in-review'
  | 'pended-info'
  | 'approved'
  | 'partial-approval'
  | 'denied'
  | 'withdrawn'
  | 'appealed'
  | 'appeal-upheld'
  | 'appeal-overturned';

export interface PriorAuthorization {
  id: string;
  memberId: string;
  providerId: string;
  serviceCode: string;
  requestedUnits: number;
  approvedUnits?: number;
  status: PriorAuthStatus;
  submittedAt: string;
  updatedAt: string;
  criteriaSetId: string;
  criteriaSetVersion: string;
  denialReasonCode?: string;
  appealDueBy?: string;
}

export interface CriteriaRule {
  id: string;
  criteriaSetId: string;
  version: string;
  description: string;
  requiredEvidence: readonly string[];
}

export interface AppealCase {
  id: string;
  priorAuthId: string;
  memberId: string;
  filedAt: string;
  status: 'received' | 'reviewing' | 'upheld' | 'overturned';
  externalReviewRequested?: boolean;
}
