import { describe, it, expect } from 'vitest';
import { Realm, populateFacility } from '../src/realm/index.js';

function makeSimRealm() {
  const realm = new Realm({ id: 'realm:test-sim', mode: 'sim' });
  populateFacility(realm, { facilityId: 'fac-a', kind: 'dialysis', name: 'DVC Alpha', units: ['ICH-A', 'ICH-B'], patientCount: 6 });
  return realm;
}

describe('Realm substrate', () => {
  it('populates a facility with entities and relations', () => {
    const realm = makeSimRealm();
    expect(realm.graph.count('facility')).toBe(1);
    expect(realm.graph.count('unit')).toBe(2);
    expect(realm.graph.count('patient')).toBe(6);
    const patients = realm.graph.listKind('patient');
    for (const p of patients) {
      const st = p.state as { facilityId: string; unitId: string };
      expect(st.facilityId).toBe('fac-a');
      expect(['fac-a-ICH-A', 'fac-a-ICH-B']).toContain(st.unitId);
    }
  });

  it('applies an admit-patient effect and updates entity state', () => {
    const realm = makeSimRealm();
    const presence = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.md', runId: 'r1',
      role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' },
    });
    const emitted = realm.emit(presence.presenceId, {
      kind: 'admit-patient', patientId: 'fac-a-pt-0001', facilityId: 'fac-a', unitId: 'fac-a-ICH-A', reason: 'ESRD',
    });
    expect(emitted.status).toBe('shadow');
    expect(emitted.rejection).toBeUndefined();
    const patient = realm.graph.get(realm.graph.urnFor('patient', 'fac-a-pt-0001'));
    expect((patient?.state as { admissionReason?: string }).admissionReason).toBe('ESRD');
  });

  it('rejects effects when the presence role lacks authority', () => {
    const realm = makeSimRealm();
    const auditor = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.auditor', runId: 'r2',
      role: 'auditor', clearance: 'phi', purposeOfUse: ['compliance'],
      location: { facilityId: 'fac-a' },
    });
    const rejected = realm.emit(auditor.presenceId, {
      kind: 'order-med', patientId: 'fac-a-pt-0001', code: 'ASA-81', dose: '81mg', route: 'PO', frequency: 'daily',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection).toMatch(/not authorized/);
  });

  it('filters perception by presence unit', () => {
    const realm = makeSimRealm();
    const nurseA = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.nurse', runId: 'r3',
      role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' },
    });
    const nurseB = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.nurse', runId: 'r4',
      role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-B' },
    });
    const md = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.md', runId: 'r5',
      role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' },
    });
    const receivedByA: string[] = [];
    const receivedByB: string[] = [];
    realm.subscribe(nurseA.presenceId, (e) => { if (e.kind === 'effect.applied') receivedByA.push(String((e.payload as { effect?: { kind: string } }).effect?.kind)); });
    realm.subscribe(nurseB.presenceId, (e) => { if (e.kind === 'effect.applied') receivedByB.push(String((e.payload as { effect?: { kind: string } }).effect?.kind)); });
    realm.emit(md.presenceId, {
      kind: 'record-vitals', patientId: 'fac-a-pt-0001', hr: 82, bp: '130/80', spo2: 97,
    });
    expect(receivedByA).toContain('record-vitals');
    expect(receivedByB).not.toContain('record-vitals');
  });

  it('ambient lab maturation resolves ordered labs into results after ticks', () => {
    const realm = makeSimRealm();
    const md = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.md', runId: 'r6',
      role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' },
    });
    realm.emit(md.presenceId, {
      kind: 'order-lab', patientId: 'fac-a-pt-0001', code: 'K', priority: 'stat',
    });
    // STAT = 1 tick to mature
    realm.clock.advanceBy(60_000);
    realm.clock.advanceBy(60_000);
    const results = realm.graph.listKind('result');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const first = results[0]!.state as { code?: string; unit?: string };
    expect(first.code).toBe('K');
    expect(first.unit).toBe('mmol/L');
  });

  it('records mutations on the effect ledger and computes a content hash', () => {
    const realm = makeSimRealm();
    const md = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.md', runId: 'r7',
      role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a' },
    });
    realm.emit(md.presenceId, { kind: 'record-agent-thought', note: 'reasoning about pt-0001 hyperkalemia' });
    realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'fac-a-pt-0001', code: 'HGB', priority: 'routine' });
    const all = realm.ledger.listAll();
    expect(all.length).toBe(2);
    const hash1 = realm.ledger.contentHash();
    realm.emit(md.presenceId, { kind: 'record-agent-thought', note: 'follow-up thought' });
    const hash2 = realm.ledger.contentHash();
    expect(hash1).not.toBe(hash2);
  });

  it('twin mode routes non-bound effects as shadow, bound effects as bound', () => {
    const realm = new Realm({ id: 'realm:test-twin', mode: 'twin', boundEffects: ['record-vitals'] });
    populateFacility(realm, { facilityId: 'fac-b', kind: 'primary-care', name: 'PC Beta', units: ['exam-1'], patientCount: 2 });
    const md = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.md', runId: 'r8',
      role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-b', unitId: 'fac-b-exam-1' },
    });
    const bound = realm.emit(md.presenceId, { kind: 'record-vitals', patientId: 'fac-b-pt-0001', hr: 76 });
    const shadow = realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'fac-b-pt-0001', code: 'HGB', priority: 'routine' });
    expect(bound.status).toBe('bound');
    expect(shadow.status).toBe('shadow');
  });

  it('presence.move updates the perceptual field', () => {
    const realm = makeSimRealm();
    const rn = realm.spawnPresence({
      realmId: realm.id, agentSpecId: 'test.nurse', runId: 'r9',
      role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac-a', unitId: 'fac-a-ICH-A' },
    });
    expect(rn.perceptualRange.units).toEqual(['fac-a-ICH-A']);
    realm.movePresence(rn.presenceId, { unitId: 'fac-a-ICH-B' });
    const after = realm.presences.get(rn.presenceId)!;
    expect(after.perceptualRange.units).toEqual(['fac-a-ICH-B']);
  });
});
