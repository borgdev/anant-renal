// Build a canned Realm snapshot for the deployed UI.
// Runs a small sim: seeds a dialysis facility, spawns 4 presences,
// emits a few effects, ticks the clock, and writes a JSON snapshot the
// static UI can load without a backend.

import { writeFileSync } from 'node:fs';
import { Realm, populateFacility } from '../dist/src/realm/index.js';

const realm = new Realm({ id: 'realm:demo-dvc-nashville', mode: 'sim' });
populateFacility(realm, { facilityId: 'dvc-nash', kind: 'dialysis', name: 'DVC Nashville', units: ['ICH-A', 'ICH-B', 'ICH-C'], patientCount: 12 });

// Spawn presences
const rnA = realm.spawnPresence({ realmId: realm.id, agentSpecId: 'flagship.charge-rn', runId: 'sim-1', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'dvc-nash', unitId: 'dvc-nash-ICH-A' } });
const rnB = realm.spawnPresence({ realmId: realm.id, agentSpecId: 'flagship.charge-rn', runId: 'sim-2', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'dvc-nash', unitId: 'dvc-nash-ICH-B' } });
const md   = realm.spawnPresence({ realmId: realm.id, agentSpecId: 'dialysis.rounding-md', runId: 'sim-3', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'dvc-nash', unitId: 'dvc-nash-ICH-A' } });
const rx   = realm.spawnPresence({ realmId: realm.id, agentSpecId: 'flagship.pharmacist-review', runId: 'sim-4', role: 'pharmacist', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'dvc-nash' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] } });
const ops  = realm.spawnPresence({ realmId: realm.id, agentSpecId: 'flagship.claims-coder', runId: 'sim-5', role: 'coder', clearance: 'internal', purposeOfUse: ['operations'], location: { facilityId: 'dvc-nash' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] } });

// Subscribe every presence so the perception router records the events they receive.
for (const pr of realm.presences.list()) realm.subscribe(pr.presenceId, () => {});

// Emit a plausible sequence of effects
realm.emit(md.presenceId, { kind: 'record-agent-thought', note: 'Rounding pt-0001 — check K+ and HGB trends.' });
realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'dvc-nash-pt-0001', code: 'K', priority: 'stat' });
realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'dvc-nash-pt-0001', code: 'HGB', priority: 'routine' });
realm.emit(rnA.presenceId, { kind: 'record-vitals', patientId: 'dvc-nash-pt-0001', hr: 88, bp: '148/92', spo2: 96 });
realm.emit(md.presenceId, { kind: 'order-med', patientId: 'dvc-nash-pt-0002', code: 'lisinopril', dose: '10mg', route: 'PO', frequency: 'daily', indication: 'HTN' });
realm.emit(rnB.presenceId, { kind: 'record-assessment', patientId: 'dvc-nash-pt-0004', assessmentId: 'phq9', score: 7, band: 'mild' });

// Tick — matures the STAT K+ lab into a result
for (let i = 0; i < 6; i++) realm.clock.advanceBy(60 * 60 * 1000);

// Pharmacist reacts to hyperkalemia if K > 5.5
const kResult = realm.graph.listKind('result').find((r) => (r.state).code === 'K');
if (kResult && (kResult.state).value > 5.5) {
  const medOrder = realm.graph.listKind('medication').find((m) => (m.state).patientId === 'dvc-nash-pt-0002' && (m.state).code === 'lisinopril');
  if (medOrder) {
    realm.emit(rx.presenceId, { kind: 'record-agent-thought', note: `K=${(kResult.state).value} — hold ACEi.` });
    realm.emit(rx.presenceId, { kind: 'hold-med', patientId: 'dvc-nash-pt-0002', medOrderId: (medOrder.state).patientId + '-lisinopril-' + (medOrder.state).patientId, reason: 'Hyperkalemia' });
  }
}

// Coder submits a claim
realm.emit(ops.presenceId, { kind: 'submit-claim', encounterId: 'dvc-nash-enc-0001', payerId: 'medicare-part-b', cptCodes: ['90999'], icd10Codes: ['N18.6', 'I12.0'] });

// Tick some more
for (let i = 0; i < 12; i++) realm.clock.advanceBy(60 * 60 * 1000);

// Build the snapshot
const snap = realm.snapshot();
const patients = realm.graph.listKind('patient').map((p) => ({
  id: p.id,
  unit: (p.state).unitId,
  trajectory: (p.state).trajectory,
  admitted: (p.state).admitted,
  vitals: (p.state).lastVitals,
  problems: (p.state).problemList,
}));
const presences = realm.presences.list().map((p) => ({
  presenceId: p.presenceId, agentSpecId: p.agentSpecId, role: p.role, location: p.location, perceptualRange: p.perceptualRange, attention: p.attention, spawnedAt: p.spawnedAt,
}));
const effects = realm.ledger.listAll().map((e) => ({
  effectId: e.effectId, presenceId: e.presenceId, agentSpecId: e.agentSpecId, emittedAt: e.emittedAt, realmAt: e.realmAt, status: e.status, effect: e.effect, mutations: e.mutations,
}));
const perception = realm.perception.recentLog(200);
const units = realm.graph.listKind('unit').map((u) => ({ id: u.id, code: (u.state).code }));

const payload = {
  realm: {
    id: realm.id, mode: realm.mode, seq: realm.clock.seq, realmAt: realm.clock.realmAt.toISOString(),
    counts: snap.counts,
  },
  facility: { id: 'dvc-nash', kind: 'dialysis', name: 'DVC Nashville' },
  units, patients, presences, effects, perception,
};

writeFileSync('/home/user/workspace/hh-admin-ui/realm.json', JSON.stringify(payload, null, 2));
console.log('wrote realm.json —', {
  patients: patients.length, presences: presences.length, effects: effects.length, perception: perception.length, seq: realm.clock.seq,
});
