// Network and benefits — the payer-side view of what services are covered,
// at what cost-share, through what network of providers. Consumed by prior-
// auth and claims-adjudication.

export type NetworkTier = 'in-network' | 'out-of-network' | 'tier-1' | 'tier-2' | 'tier-3' | 'preferred';

export interface Benefit {
  readonly serviceCode: string;
  readonly coveredIndicator: 'covered' | 'excluded' | 'requires-auth' | 'medically-necessary-only';
  readonly copay?: number;
  readonly coinsurancePct?: number;
  readonly deductibleAppliesFlag: boolean;
  readonly authRequired: boolean;
  readonly authThreshold?: { readonly units: number; readonly period: 'per-year' | 'per-episode' };
}

export interface Coverage {
  readonly memberId: string;
  readonly planId: string;
  readonly effectivePeriod: { readonly from: string; readonly to?: string };
  readonly status: 'active' | 'terminated' | 'suspended' | 'grace-period';
  readonly benefits: readonly Benefit[];
}

export interface NetworkProvider {
  readonly providerId: string;
  readonly npi: string;
  readonly tier: NetworkTier;
  readonly specialties: readonly string[];
  readonly credentialsVerifiedAt: string;
  readonly acceptingNewPatients: boolean;
}

export interface EligibilityAnswer {
  readonly memberId: string;
  readonly asOf: string;
  readonly active: boolean;
  readonly reason?: string;
  readonly planId?: string;
  readonly benefits: readonly Benefit[];
}

export function evaluateEligibility(coverage: Coverage | undefined, asOf: string): EligibilityAnswer {
  if (!coverage) return { memberId: 'unknown', asOf, active: false, reason: 'no-coverage-record', benefits: [] };
  const t = Date.parse(asOf);
  const from = Date.parse(coverage.effectivePeriod.from);
  const to = coverage.effectivePeriod.to ? Date.parse(coverage.effectivePeriod.to) : Number.POSITIVE_INFINITY;
  const withinWindow = t >= from && t <= to;
  const activeStatus = coverage.status === 'active' || coverage.status === 'grace-period';
  const answer: EligibilityAnswer = {
    memberId: coverage.memberId,
    asOf,
    active: withinWindow && activeStatus,
    ...(!(withinWindow && activeStatus) ? { reason: coverage.status } : {}),
    planId: coverage.planId,
    benefits: coverage.benefits,
  };
  return answer;
}
