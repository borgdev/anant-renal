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

import { describe, it, expect, beforeEach } from 'vitest';
import {
  populateFacility,
  RealmRegistry,
  Federation,
  DEFAULT_BILLING_PLAN,
  runCounterfactual,
  type Intervention,
} from '../src/realm/index.js';
import { listDirectives, listPlanAdvances, directivesByTarget } from '../src/realm/governance.js';
import { NotificationBus, attachBus } from '../src/realm/notifications.js';
import { LLMRegistry } from '../src/realm/llm-registry.js';
import { CounterfactualStore } from '../src/realm/counterfactual-store.js';
import { captureSnapshot, restoreSnapshot, SnapshotRegistry, SNAPSHOT_VERSION } from '../src/realm/realm-snapshot.js';
import type { OperatorLLMAdapter } from '../src/realm/operator-seat.js';
import type { LLMPlannerAdapter } from '../src/realm/planner.js';

function makeRealm(id: string, facilityId = 'fac-a') {
  const r = RealmRegistry.create({ id, mode: 'sim' });
  populateFacility(r, { facilityId, kind: 'dialysis', name: `Clinic ${facilityId}`, units: ['ICH-A'], patientCount: 4 });
  r.spawnPresence({ realmId: r.id, agentSpecId: 'a.md', runId: 'r1', role: 'admin', clearance: 'phi', purposeOfUse: ['operations'], location: { facilityId } });
  return r;
}

describe('M14.A PlanRunner run-log', () => {
  it('captures a run-log entry on every step transition', async () => {
    const r = makeRealm('m14a-realm-1');
    r.spawnPresence({ realmId: r.id, agentSpecId: 'md.md', runId: 'r2', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' } });
    const patient = r.graph.listKind('patient')[0]!;
    const { plan } = await r.submitIntent({ intentKind: 'resolve-safety-event', subjectRef: (patient.state as { id: string }).id, description: 'Resolve', priority: 'high', by: 'admin.1' });
    r.runPlan(plan.planId);
    const final = r.getPlan(plan.planId);
    const runLog = (final as unknown as { runLog?: Array<{ outcomeKind: string; stepId: string }> }).runLog ?? [];
    expect(runLog.length).toBeGreaterThan(0);
    expect(runLog.every((e) => typeof e.stepId === 'string' && typeof e.outcomeKind === 'string')).toBe(true);
    r.stop();
  });
});

describe('M14.B CounterfactualStore', () => {
  beforeEach(() => CounterfactualStore.clear());
  it('persists a counterfactual run for later retrieval', () => {
    const build = () => makeRealm(`m14b-cf-${Math.random().toString(36).slice(2, 6)}`);
    const interventions: Intervention[] = [{ kind: 'nudge-preference', presenceRole: 'md', effectKind: 'order-lab', delta: 0.2 }];
    const report = runCounterfactual({ build, timeline: [], interventions, advanceTicks: 2 });
    const rec = CounterfactualStore.save({ build, timeline: [], interventions, advanceTicks: 2 }, report, 'test-run');
    expect(CounterfactualStore.get(rec.id)).toBeDefined();
    expect(CounterfactualStore.list().length).toBe(1);
    expect(rec.input.interventions[0]).toMatchObject({ kind: 'nudge-preference', effectKind: 'order-lab' });
  });
});

describe('M14.C Governance ledger', () => {
  it('extracts operator-directive and advance-plan entries from the ledger', async () => {
    const r = makeRealm('m14c-realm-1');
    const admin = r.presences.list().find((p) => p.role === 'admin')!;
    // Issue an operator directive via the seat
    const dir = await r.operatorSeat.parse('bias nurse-1 toward hold-med by 0.3');
    expect(dir).toBeDefined();
    r.operatorSeat.apply(dir!, admin.presenceId);
    const directives = listDirectives(r);
    expect(directives.length).toBeGreaterThan(0);
    expect(directives[0]?.verb).toBe('nudge-preference');
    // Run a plan to generate advance-plan entries
    r.spawnPresence({ realmId: r.id, agentSpecId: 'md.md', runId: 'r2', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' } });
    const patient = r.graph.listKind('patient')[0]!;
    const { plan } = await r.submitIntent({ intentKind: 'resolve-safety-event', subjectRef: (patient.state as { id: string }).id, description: 'Resolve', priority: 'high', by: 'admin.1' });
    r.runPlan(plan.planId);
    const advances = listPlanAdvances(r);
    expect(advances.length).toBeGreaterThan(0);
    const grouped = directivesByTarget(r);
    expect(Object.keys(grouped).length).toBeGreaterThan(0);
    r.stop();
  });
});

describe('M14.D Notification bus', () => {
  it('publishes matching effects to subscribers', () => {
    const r = makeRealm('m14d-realm-1');
    const bus = new NotificationBus();
    const received: string[] = [];
    bus.subscribe({ eventKinds: ['flag-safety-event'], sink: (n) => received.push(n.id) });
    const unsub = attachBus(r, bus);
    r.spawnPresence({ realmId: r.id, agentSpecId: 'nurse.md', runId: 'r-n', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' } });
    const nurse = r.presences.list().find((p) => p.role === 'nurse')!;
    const patient = r.graph.listKind('patient')[0]!;
    r.emit(nurse.presenceId, { kind: 'flag-safety-event', patientId: (patient.state as { id: string }).id, safetyKind: 'fall-risk', severity: 'low' } as never);
    expect(received.length).toBeGreaterThan(0);
    expect(bus.recent(1)[0]?.kind).toBe('flag-safety-event');
    unsub();
    r.stop();
  });
});

describe('M14.E Org billing rollup', () => {
  beforeEach(() => { for (const o of Federation.listOrgs()) Federation.removeOrg(o.orgId); });
  it('sums invoicePreview across an org\'s realms', () => {
    const r1 = makeRealm('m14e-realm-a', 'fac-a');
    const r2 = makeRealm('m14e-realm-b', 'fac-b');
    for (const r of [r1, r2]) {
      const admin = r.presences.list().find((p) => p.role === 'admin')!;
      const patient = r.graph.listKind('patient')[0]!;
      r.emit(admin.presenceId, { kind: 'order-lab', patientId: (patient.state as { id: string }).id, code: 'cbc', priority: 'routine' } as never);
    }
    Federation.registerOrg({ orgId: 'test-org', displayName: 'Test', realmIds: [r1.id, r2.id] });
    const roll = Federation.invoicePreviewForOrg('test-org', DEFAULT_BILLING_PLAN, {});
    expect(roll.perRealm.length).toBe(2);
    expect(roll.totals.totalDueUsd).toBeGreaterThanOrEqual(0);
    expect(roll.totals.metersSubtotalUsd + roll.totals.episodesSubtotalUsd + roll.totals.minimumTopUpUsd).toBeCloseTo(roll.totals.totalDueUsd, 2);
    r1.stop(); r2.stop();
  });
});

describe('M14.F LLM adapter registry', () => {
  it('registers, health-checks, and toggles adapters', async () => {
    const opAdapter: OperatorLLMAdapter = { id: 'test-op', async parse() { return { verb: 'explain', payload: { presenceId: 'x' }, originalText: 'x', reasoning: 'test', confidence: 0.5 }; } };
    LLMRegistry.register({ id: 'test-op', role: 'operator', displayName: 'Test Operator', enabled: true, handle: opAdapter });
    const health = await LLMRegistry.healthCheck('test-op');
    expect(health.ok).toBe(true);
    expect(typeof health.latencyMs).toBe('number');
    LLMRegistry.setEnabled('test-op', false);
    expect(LLMRegistry.get('test-op')?.enabled).toBe(false);

    const planner: LLMPlannerAdapter = { id: 'test-planner', async plan() { return [{ id: 's1', label: 'noop', ownerRole: 'admin', status: 'pending' }]; } };
    LLMRegistry.register({ id: 'test-planner', role: 'planner', displayName: 'Test Planner', enabled: true, handle: planner });
    const h2 = await LLMRegistry.healthCheck('test-planner');
    expect(h2.ok).toBe(true);
    LLMRegistry.unregister('test-op');
    LLMRegistry.unregister('test-planner');
  });

  it('records last error when adapter throws', async () => {
    const bad: OperatorLLMAdapter = { id: 'bad', async parse() { throw new Error('boom'); } };
    LLMRegistry.register({ id: 'bad', role: 'operator', displayName: 'Bad', enabled: true, handle: bad });
    const health = await LLMRegistry.healthCheck('bad');
    expect(health.ok).toBe(false);
    expect(health.lastError).toContain('boom');
    LLMRegistry.unregister('bad');
  });
});

describe('M14.G Realm snapshot + restore', () => {
  it('captures a snapshot with the correct version', () => {
    const r = makeRealm('m14g-realm-src');
    const admin = r.presences.list().find((p) => p.role === 'admin')!;
    const patient = r.graph.listKind('patient')[0]!;
    r.emit(admin.presenceId, { kind: 'order-lab', patientId: (patient.state as { id: string }).id, code: 'cbc', priority: 'routine' } as never);
    const snap = captureSnapshot(r);
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    expect(snap.effects.length).toBeGreaterThan(0);
    expect(snap.presences.length).toBeGreaterThan(0);
    const id = SnapshotRegistry.save(snap);
    expect(SnapshotRegistry.get(id)).toBeDefined();
    r.stop();
  });

  it('restores a fresh realm with matching ledger length', () => {
    const src = makeRealm('m14g-realm-src2');
    const admin = src.presences.list().find((p) => p.role === 'admin')!;
    const patient = src.graph.listKind('patient')[0]!;
    src.emit(admin.presenceId, { kind: 'order-lab', patientId: (patient.state as { id: string }).id, code: 'cbc', priority: 'routine' } as never);
    const snap = captureSnapshot(src);
    const restored = restoreSnapshot(snap, () => makeRealm('m14g-realm-dst'));
    expect(restored.ledger.listAll().length).toBeGreaterThanOrEqual(snap.effects.length);
    src.stop(); restored.stop();
  });
});
