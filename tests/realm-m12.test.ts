import { describe, expect, it } from 'vitest';
import { Realm, DIALYSIS_CLINIC_ORG_PACK, parseDirectiveDeterministic } from '../src/realm/index.js';

function mkRealm() {
  const r = new Realm({ id: 'realm:test-m12', mode: 'sim' });
  return r;
}

describe('M12.1 org-graph', () => {
  it('loads default dialysis org pack with departments, teams, roles', () => {
    const r = mkRealm();
    const orgNodes = r.graph.listKind('org-node');
    expect(orgNodes.length).toBe(DIALYSIS_CLINIC_ORG_PACK.nodes.length);
    const departments = orgNodes.filter((n) => (n.state as { nodeKind?: string }).nodeKind === 'department');
    expect(departments.length).toBeGreaterThanOrEqual(4);
    const roles = orgNodes.filter((n) => (n.state as { nodeKind?: string }).nodeKind === 'role');
    expect(roles.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves escalation target for nurse -> charge-nurse', () => {
    const r = mkRealm();
    const target = r.orgQuery.escalationTargetFor('role.nurse');
    expect(target).toBe('role.charge-nurse');
  });

  it('walks containment path from role -> team -> department', () => {
    const r = mkRealm();
    const path = r.orgQuery.containmentPath('role.nurse');
    expect(path).toEqual(['role.nurse', 'team.floor-nursing', 'dept.clinical']);
  });
});

describe('M12.1 physical objects + work artifacts', () => {
  it('creates, assigns, releases a chair; state transitions correctly', () => {
    const r = mkRealm();
    r.graph.create('physical-object', 'chair-1', { objectKind: 'chair', state: 'idle', locationUnitId: 'unit-a' });
    const nurse = r.spawnPresence({
      agentSpecId: 'nurse.charge', runId: 'run-1', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-1', unitId: 'unit-a' },
      perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    });
    r.emit(nurse.presenceId, { kind: 'assign-object', objectId: 'chair-1', toPatientId: 'pt-1', reason: 'session start' });
    const afterAssign = r.graph.get(r.graph.urnFor('physical-object', 'chair-1'));
    expect((afterAssign?.state as { state: string }).state).toBe('in-use');
    expect((afterAssign?.state as { assignedToPatientId: string }).assignedToPatientId).toBe('pt-1');
    r.emit(nurse.presenceId, { kind: 'release-object', objectId: 'chair-1', reason: 'session end' });
    const afterRelease = r.graph.get(r.graph.urnFor('physical-object', 'chair-1'));
    expect((afterRelease?.state as { state: string }).state).toBe('cleaning');
  });

  it('opens and closes a ticket with history', () => {
    const r = mkRealm();
    const tech = r.spawnPresence({
      agentSpecId: 'tech-1', runId: 'run-1', role: 'tech', clearance: 'internal', purposeOfUse: ['operations'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: [], eventTypes: ['*'] },
    });
    const opened = r.emit(tech.presenceId, { kind: 'open-ticket', ticketKind: 'facilities', assigneeRole: 'facilities-tech', priority: 'high', summary: 'RO alarm' });
    expect(opened.status).toBe('shadow');
    const tickets = r.graph.listKind('work-artifact');
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    const tId = tickets[0]!.id;
    r.emit(tech.presenceId, { kind: 'close-ticket', ticketId: tId, resolution: 'resolved', note: 'valve tightened' });
    const closed = r.graph.get(r.graph.urnFor('work-artifact', tId));
    expect((closed?.state as { status: string }).status).toBe('closed');
    expect((closed?.state as { resolution: string }).resolution).toBe('resolved');
  });
});

describe('M12.2 planner', () => {
  it('deterministic template plans a discharge-patient-safely intent with 4 steps', async () => {
    const r = mkRealm();
    const { intent, plan } = await r.submitIntent({ intentKind: 'discharge-patient-safely', subjectRef: 'pt-1', description: 'Discharge pt-1', priority: 'normal', by: 'operator' });
    expect(intent.subjectRef).toBe('pt-1');
    expect(plan.producedBy).toBe('template');
    expect(plan.steps.length).toBe(4);
    expect(plan.steps[3]!.effectHint?.kind).toBe('discharge-patient');
  });

  it('LLM fallback is called when no template matches', async () => {
    const r = mkRealm();
    let called = false;
    r.planner.setLLM({ id: 'test-llm', plan: async () => { called = true; return [{ id: 's1', label: 'llm-step', ownerRole: 'md', status: 'pending' }]; } });
    const { plan } = await r.submitIntent({ intentKind: 'unusual-open-ended-intent', description: 'do something', priority: 'low', by: 'operator' });
    expect(called).toBe(true);
    expect(plan.producedBy).toBe('llm');
  });

  it('template planner throws when neither template nor LLM handles the intent', async () => {
    const r = mkRealm();
    await expect(r.submitIntent({ intentKind: 'unknown-intent-kind', description: 'x', priority: 'low', by: 'op' })).rejects.toThrow(/planner-no-match/);
  });
});

describe('M12.3 HITL', () => {
  it('suspends critical safety event and re-emits when approved', () => {
    const r = mkRealm();
    r.graph.create('patient', 'pt-1', { admitted: true });
    const nurse = r.spawnPresence({
      agentSpecId: 'nurse-1', runId: 'run-1', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    });
    const emitted = r.emit(nurse.presenceId, { kind: 'flag-safety-event', patientId: 'pt-1', safetyKind: 'anaphylaxis', severity: 'critical' });
    expect(emitted.status).toBe('rejected');
    expect(emitted.rejection).toMatch(/hitl-suspended/);
    const pending = r.hitl.pending();
    expect(pending.length).toBe(1);
    // Approve
    r.hitl.decide(pending[0]!.approvalId, 'approve', 'admin-1', 'reviewed');
    // Re-emission should produce a real safety-event effect (non-rejected) in the ledger.
    const applied = r.ledger.listAll().filter((e) => e.effect.kind === 'flag-safety-event' && e.status !== 'rejected');
    expect(applied.length).toBeGreaterThanOrEqual(1);
  });

  it('reject decision does not re-emit', () => {
    const r = mkRealm();
    r.graph.create('patient', 'pt-2', { admitted: true });
    const nurse = r.spawnPresence({
      agentSpecId: 'nurse-2', runId: 'run-1', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    });
    r.emit(nurse.presenceId, { kind: 'flag-safety-event', patientId: 'pt-2', safetyKind: 'x', severity: 'critical' });
    const pending = r.hitl.pending();
    r.hitl.decide(pending[0]!.approvalId, 'reject', 'admin-1', 'not warranted');
    const applied = r.ledger.listAll().filter((e) => e.effect.kind === 'flag-safety-event' && e.status !== 'rejected' && (e.effect as { patientId?: string }).patientId === 'pt-2');
    expect(applied.length).toBe(0);
  });
});

describe('M12.4 cost ledger', () => {
  it('scores an episode on close with clinician-min, dollars, satisfaction', () => {
    const r = mkRealm();
    r.graph.create('patient', 'pt-3', { admitted: true });
    r.graph.create('encounter', 'enc-3', { patientId: 'pt-3' });
    const md = r.spawnPresence({
      agentSpecId: 'md-1', runId: 'run-1', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    });
    // Open an episode manually + record effects on it.
    const ep = r.episodes.openEpisode({ presence: md, localGoal: 'process encounter', openingPerception: [], openedAt: new Date().toISOString() });
    const e1 = r.emit(md.presenceId, { kind: 'schedule-followup', patientId: 'pt-3', when: '2026-08-15', resource: 'nephro-clinic', followupKind: 'nephro-clinic' });
    const e2 = r.emit(md.presenceId, { kind: 'submit-claim', encounterId: 'enc-3', payerId: 'p1', cptCodes: ['90999', '99215'], icd10Codes: ['N18.6'] });
    r.episodes.recordEffect(ep.episodeId, { kind: 'schedule-followup', patientId: 'pt-3', when: '2026-08-15', resource: 'nephro-clinic', followupKind: 'nephro-clinic' }, e1);
    r.episodes.recordEffect(ep.episodeId, { kind: 'submit-claim', encounterId: 'enc-3', payerId: 'p1', cptCodes: ['90999', '99215'], icd10Codes: ['N18.6'] }, e2);
    r.episodes.closeEpisode(ep.episodeId, new Date().toISOString(), 'routine');
    const rec = r.cost.get(ep.episodeId);
    expect(rec).toBeDefined();
    expect(rec!.scores.dollars).toBeGreaterThan(0);
    expect(rec!.scores.clinicianMin).toBeGreaterThan(0);
    expect(rec!.scores.patientSatisfaction).toBeGreaterThan(0);
    const roll = r.cost.rollup();
    expect(roll.episodeCount).toBe(1);
    expect(roll.totals.dollars).toBeGreaterThan(0);
  });
});

describe('M12.5 operator seat', () => {
  it('parses spawn / nudge / discharge intent / explain deterministically', () => {
    expect(parseDirectiveDeterministic('spawn a nurse in unit-a')?.verb).toBe('spawn');
    expect(parseDirectiveDeterministic('bias nurse-1 toward hold-med by 0.3')?.verb).toBe('nudge-preference');
    expect(parseDirectiveDeterministic('get pt-1 discharged safely')?.verb).toBe('submit-intent');
    expect(parseDirectiveDeterministic('explain nurse-1')?.verb).toBe('explain');
    expect(parseDirectiveDeterministic('nonsense phrase that doesnt match')).toBeUndefined();
  });

  it('applies nudge-preference directive and shifts stored preference', async () => {
    const r = mkRealm();
    const nurse = r.spawnPresence({
      agentSpecId: 'nurse-9', runId: 'run-1', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    });
    r.selfModel.ensure(nurse);
    const admin = r.spawnPresence({
      agentSpecId: 'admin-1', runId: 'admin-run', role: 'admin', clearance: 'internal', purposeOfUse: ['operations'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: [], eventTypes: ['*'] },
    });
    const d = await r.operatorSeat.parse(`bias ${nurse.presenceId} toward hold-med by 0.3`);
    expect(d).toBeDefined();
    const result = r.operatorSeat.apply(d!, admin.presenceId);
    expect(result.applied).toBe(true);
    expect(r.selfModel.preferenceFor(nurse.presenceId, 'hold-med')).toBeGreaterThan(1.0);
  });

  it('applies submit-intent directive and materializes a plan', async () => {
    const r = mkRealm();
    const admin = r.spawnPresence({
      agentSpecId: 'admin-2', runId: 'admin-run', role: 'admin', clearance: 'internal', purposeOfUse: ['operations'],
      location: { facilityId: 'fac-1' }, perceptualRange: { units: ['*'], patients: [], eventTypes: ['*'] },
    });
    const d = await r.operatorSeat.parse('get pt-42 discharged safely');
    expect(d).toBeDefined();
    r.operatorSeat.apply(d!, admin.presenceId);
    // The seat records the operator-directive + emits submit-intent; check that at least one submit-intent effect appears.
    const intentEffects = r.ledger.listAll().filter((e) => e.effect.kind === 'submit-intent');
    expect(intentEffects.length).toBeGreaterThanOrEqual(1);
  });
});
