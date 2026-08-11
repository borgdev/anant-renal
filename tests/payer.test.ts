import { describe, expect, it } from 'vitest';
import { autoAdjudicate, advancePriorAuth } from '../packs/payer/prior-auth.js';

describe('payer prior-auth', () => {
  const rules = [
    { id: 'r1', criteriaSetId: 'c-hemodialysis', version: '1.0.0', description: 'Documented ESRD', requiredEvidence: ['diagnosis:N18.6'] },
    { id: 'r2', criteriaSetId: 'c-hemodialysis', version: '1.0.0', description: 'Nephrologist referral', requiredEvidence: ['referral:nephrology'] },
  ];

  it('approves when all criteria satisfied', () => {
    const pa = { id: 'pa1', memberId: 'm1', providerId: 'pr1', serviceCode: 'hd', requestedUnits: 13, status: 'received' as const, submittedAt: '2026-08-01', updatedAt: '2026-08-01', criteriaSetId: 'c-hemodialysis', criteriaSetVersion: '1.0.0' };
    const result = autoAdjudicate(pa, { attachments: ['diagnosis:N18.6', 'referral:nephrology'] }, rules);
    expect(result.decision).toBe('approved');
  });

  it('pends when evidence is missing', () => {
    const pa = { id: 'pa1', memberId: 'm1', providerId: 'pr1', serviceCode: 'hd', requestedUnits: 13, status: 'received' as const, submittedAt: '2026-08-01', updatedAt: '2026-08-01', criteriaSetId: 'c-hemodialysis', criteriaSetVersion: '1.0.0' };
    const result = autoAdjudicate(pa, { attachments: [] }, rules);
    expect(result.decision).toBe('pended-info');
    expect(result.missingEvidence.length).toBeGreaterThan(0);
  });

  it('rejects illegal transitions', () => {
    const pa = { id: 'pa1', memberId: 'm1', providerId: 'pr1', serviceCode: 'hd', requestedUnits: 13, status: 'approved' as const, submittedAt: '2026-08-01', updatedAt: '2026-08-01', criteriaSetId: 'c-hemodialysis', criteriaSetVersion: '1.0.0' };
    expect(() => advancePriorAuth(pa, 'denied', '2026-08-02')).toThrow();
  });
});
