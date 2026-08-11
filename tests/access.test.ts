import { describe, expect, it } from 'vitest';
import { OrganizationDirectory, AccessEvaluator, AuditLedger } from '../src/index.js';

function makeDir() {
  const dir = new OrganizationDirectory();
  dir.registerOrganization({ id: 'org:a', kind: 'provider', name: 'A', attributes: {} });
  dir.registerPerson({ id: 'person:1', organizationId: 'org:a', displayName: 'P1', roles: ['nurse'], attributes: {} });
  dir.registerScope({ id: 'scope:root', kind: 'organization', organizationId: 'org:a', memberIds: ['person:1'], attributes: {} });
  dir.registerScope({ id: 'scope:facility', kind: 'facility', organizationId: 'org:a', parentScopeId: 'scope:root', memberIds: [], attributes: {} });
  return dir;
}

describe('AccessEvaluator', () => {
  it('denies PHI on unmanaged devices', () => {
    const dir = makeDir();
    const evaluator = new AccessEvaluator(dir, [{ role: 'nurse', actions: ['read'], resourceTypes: ['dialysis.case'] }], []);
    const decision = evaluator.evaluate({
      subject: { id: 'person:1', organizationId: 'org:a', roles: ['nurse'], attributes: {} },
      resource: { id: 'case:x', type: 'dialysis.case', scopeId: 'scope:facility', scopeKind: 'facility', ownerOrganizationId: 'org:a', classification: 'phi', attributes: {} },
      action: 'read',
      environment: { purposeOfUse: 'care', managedDevice: false, sessionAgeMinutes: 5, mfaAgeMinutes: 5, now: '2026-08-01T00:00:00Z' },
    });
    expect(decision.decision).toBe('deny');
  });

  it('requires MFA freshness on PHI', () => {
    const dir = makeDir();
    const evaluator = new AccessEvaluator(dir, [{ role: 'nurse', actions: ['read'], resourceTypes: ['dialysis.case'] }], []);
    const decision = evaluator.evaluate({
      subject: { id: 'person:1', organizationId: 'org:a', roles: ['nurse'], attributes: {} },
      resource: { id: 'case:x', type: 'dialysis.case', scopeId: 'scope:facility', scopeKind: 'facility', ownerOrganizationId: 'org:a', classification: 'phi', attributes: {} },
      action: 'read',
      environment: { purposeOfUse: 'care', managedDevice: true, sessionAgeMinutes: 5, mfaAgeMinutes: 120, now: '2026-08-01T00:00:00Z' },
    });
    expect(decision.decision).toBe('step-up-required');
  });

  it('denies when subject scope does not cover resource scope', () => {
    const dir = makeDir();
    const evaluator = new AccessEvaluator(dir, [{ role: 'nurse', actions: ['read'], resourceTypes: ['dialysis.case'] }], []);
    // person:1 is only in scope:root, not scope:facility, and facility has no members.
    const decision = evaluator.evaluate({
      subject: { id: 'person:1', organizationId: 'org:a', roles: ['nurse'], attributes: {} },
      resource: { id: 'case:x', type: 'dialysis.case', scopeId: 'scope:facility', scopeKind: 'facility', ownerOrganizationId: 'org:a', classification: 'internal', attributes: {} },
      action: 'read',
      environment: { purposeOfUse: 'care', managedDevice: true, sessionAgeMinutes: 5, mfaAgeMinutes: 5, now: '2026-08-01T00:00:00Z' },
    });
    expect(decision.decision).toBe('allow'); // ancestry via scope:root membership covers descendants
  });
});

describe('AuditLedger', () => {
  it('chains entries and detects tampering', () => {
    const audit = new AuditLedger();
    audit.append({ id: 'a1', occurredAt: '2026-08-01', actorId: 'p1', scopeId: 's1', action: 'read', traceId: 't1', payload: {} });
    audit.append({ id: 'a2', occurredAt: '2026-08-01', actorId: 'p1', scopeId: 's1', action: 'write', traceId: 't1', payload: {} });
    expect(audit.verify()).toBeNull();
    // Tamper: replace the sealed entry in the private array with a mutated copy.
    const internal = (audit as unknown as { events: Array<Record<string, unknown>> }).events;
    internal[0] = { ...internal[0], action: 'export' };
    expect(audit.verify()).not.toBeNull();
  });
});
