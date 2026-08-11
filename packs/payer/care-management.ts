// Payer care-management — programs a health plan runs against enrolled
// members: complex-case management, disease management, transitions of care,
// pharmacy management. Case model + risk-stratification hooks.

export type CareProgramKind =
  | 'complex-case-management'
  | 'disease-management'
  | 'transitions-of-care'
  | 'behavioral-health-integration'
  | 'high-cost-claimant'
  | 'end-stage-renal';

export interface CareCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly program: CareProgramKind;
  readonly enrolledAt: string;
  readonly riskTier: 'rising' | 'high' | 'complex';
  readonly primaryConditionCodes: readonly string[];
  readonly assignedCoordinator: string;
  readonly status: 'active' | 'graduated' | 'declined' | 'lost-to-follow-up';
  readonly nextTouchpoint?: string;
}

export interface RiskStratificationInput {
  readonly memberId: string;
  readonly ageYears: number;
  readonly recentEDVisits: number;
  readonly recentAdmissions: number;
  readonly chronicConditionCount: number;
  readonly medicationCount: number;
}

/**
 * Deterministic risk-stratification heuristic. Real deployments plug in
 * plan-specific models; this is documented as a baseline / substitute so
 * downstream workflows can be tested end-to-end.
 */
export function stratifyRisk(input: RiskStratificationInput): { tier: CareCase['riskTier']; score: number; drivers: readonly string[] } {
  const drivers: string[] = [];
  let score = 0;
  if (input.recentAdmissions >= 2) { score += 3; drivers.push('recent-admissions'); }
  if (input.recentEDVisits >= 3) { score += 2; drivers.push('ed-utilization'); }
  if (input.chronicConditionCount >= 3) { score += 2; drivers.push('multimorbidity'); }
  if (input.medicationCount >= 8) { score += 1; drivers.push('polypharmacy'); }
  if (input.ageYears >= 75) { score += 1; drivers.push('advanced-age'); }
  const tier: CareCase['riskTier'] = score >= 6 ? 'complex' : score >= 3 ? 'high' : 'rising';
  return { tier, score, drivers };
}
