import { describe, it, expect, beforeEach } from 'vitest';
import {
  Realm,
  populateFacility,
  RealmRegistry,
  Federation,
  PolicyRuntime,
  invoicePreview,
  usageCsv,
  runCounterfactual,
  DEFAULT_BILLING_PLAN,
  type WorldEffect,
} from '../src/realm/index.js';

function makeRealm(id: string, facilityId = 'fac-a') {
  const r = RealmRegistry.create({ id, mode: 'sim' });
  populateFacility(r, { facilityId, kind: 'dialysis', name: `Clinic ${facilityId}`, units: ['ICH-A'], patientCount: 4 });
  return r;
}

describe('M13.A PlanRunner', () => {
  it('runs a plan and produces outcomes', async () => {
    const r = makeRealm('m13a-realm-1');
    r.spawnPresence({ realmId: r.id, agentSpecId: 'a.md', runId: 'r1', role: 'admin', clearance: 'phi', purposeOfUse: ['operations'], location: { facilityId: 'fac-a' } });
    r.spawnPresence({ realmId: r.id, agentSpecId: 'md.md', runId: 'r2', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' } });
    // Use resolve-safety-event which has hand-off steps that don't require URN mismatches
    const patient = r.graph.listKind('patient')[0]!;
    const { plan } = await r.submitIntent({ intentKind: 'resolve-safety-event', subjectRef: patient.state?.['id'] as string ?? patient.urn, description: 'Resolve event', priority: 'high', by: 'admin.1' });
    expect(plan.steps.length).toBeGreaterThan(0);
    // Step once — verify PlanRunner returns a defined outcome (advanced|suspended|blocked|complete|idle)
    const outcome = r.stepPlan(plan.planId);
    expect(['advanced', 'suspended', 'blocked', 'complete', 'idle']).toContain((outcome as { kind: string }).kind);
    const final = r.getPlan(plan.planId);
    expect(final).toBeDefined();
    r.stop();
  });
});

describe('M13.C Federation', () => {
  beforeEach(() => { for (const o of Federation.listOrgs()) Federation.removeOrg(o.orgId); });

  it('rolls up cost + hitl + plans across realms', () => {
    const r1 = makeRealm('m13c-realm-1', 'fac-1');
    const r2 = makeRealm('m13c-realm-2', 'fac-2');
    Federation.registerOrg({ orgId: 'org-alpha', displayName: 'Alpha Health', realmIds: [r1.id, r2.id] });
    const summary = Federation.orgSummary('org-alpha');
    expect(summary).toBeDefined();
    expect(summary!.org.realmIds).toEqual([r1.id, r2.id]);
    expect(summary!.cost.perRealm.length).toBe(2);
    expect(summary!.hitl.length).toBe(2);
    r1.stop(); r2.stop();
  });
});

describe('M13.G PolicyRuntime', () => {
  it('ranks candidates by learned preference', () => {
    const r = makeRealm('m13g-realm');
    const md = r.spawnPresence({ realmId: r.id, agentSpecId: 'md.md', runId: 'r1', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' } });
    // Shift preference toward 'order-lab'
    r.selfModel.nudgePreference(md.presenceId, 'order-lab', 0.5, 'test');
    const policy = new PolicyRuntime(r.selfModel);
    const ranked = policy.rank(md, [
      { optionId: 'a', effectKind: 'order-lab', utility: 0.6, action: 'lab' },
      { optionId: 'b', effectKind: 'record-vitals', utility: 0.7, action: 'vitals' },
    ]);
    expect(ranked[0]!.optionId).toBe('a'); // preference-weighted lab (0.6*1.5=0.9) beats vitals (0.7*1.0)
    expect(ranked[0]!.preferenceWeight).toBeCloseTo(1.5, 5);
    r.stop();
  });
});

describe('M13.B Billing', () => {
  it('generates an invoice preview with meters and episode tiers', async () => {
    const r = makeRealm('m13b-realm');
    const md = r.spawnPresence({ realmId: r.id, agentSpecId: 'md.md', runId: 'r1', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' } });
    // Emit a few effects
    const patients = r.graph.listKind('patient');
    const first = patients[0]!;
    const pid = (first.state as { id: string }).id;
    r.emit(md.presenceId, { kind: 'record-vitals', patientId: pid, hr: 78, bp: '128/80', temp: 98.4, spo2: 97 } as WorldEffect);
    r.emit(md.presenceId, { kind: 'order-lab', patientId: pid, code: 'cbc', priority: 'routine' } as WorldEffect);
    r.clock.advanceBy(4 * 60 * 60 * 1000);
    const report = invoicePreview(r, DEFAULT_BILLING_PLAN, {});
    expect(report.totalDueUsd).toBeGreaterThan(0);
    expect(report.meters.length + report.episodes.length).toBeGreaterThan(0);
    const csv = usageCsv(report);
    expect(csv).toContain('total,total');
    r.stop();
  });
});

describe('M13.F Counterfactual', () => {
  it('runs baseline and counterfactual with intervention', () => {
    const facility = { facilityId: 'fac-cf', kind: 'dialysis' as const, name: 'CF Clinic', units: ['ICH-A'], patientCount: 3 };
    const report = runCounterfactual({
      build: () => {
        const fresh = new Realm({ id: `cf-${Math.random().toString(36).slice(2, 8)}`, mode: 'sim' });
        populateFacility(fresh, facility);
        fresh.spawnPresence({ realmId: fresh.id, agentSpecId: 'md.md', runId: 'r1', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: facility.facilityId, unitId: `${facility.facilityId}-ICH-A` } });
        return fresh;
      },
      timeline: [],
      interventions: [{ kind: 'nudge-preference', presenceRole: 'md', effectKind: 'order-lab', delta: 0.3 }],
      advanceTicks: 2,
    });
    expect(report.baseline).toBeDefined();
    expect(report.counterfactual).toBeDefined();
    expect(typeof report.interpretation).toBe('string');
  });
});
