// Build a canned Realm snapshot for the deployed UI.
// Runs a small sim using the AgentRealmRuntime, seeds a dialysis facility,
// spawns real agents from the pack registry, and captures episodes,
// self-models, experiences, and effects for the static UI to render.

import { writeFileSync } from 'node:fs';
import { Realm, populateFacility, AgentRealmRuntime } from '../dist/src/realm/index.js';
import { loadSpecsFromDisk } from '../dist/src/agents/spec-sync.js';

const realm = new Realm({ id: 'realm:demo-dvc-nashville', mode: 'sim' });
populateFacility(realm, { facilityId: 'dvc-nash', kind: 'dialysis', name: 'DVC Nashville', units: ['ICH-A', 'ICH-B', 'ICH-C'], patientCount: 12 });

// Load a handful of real specs and spawn them via the runtime so we get
// real episodes/self-models. Fall back to synthesized specs if pack files
// aren't compiled.
let specs = [];
try {
  const packsRoot = new URL('../packs/', import.meta.url).pathname;
  specs = loadSpecsFromDisk(packsRoot).map((r) => r.spec);
} catch (err) {
  console.warn('spec loader failed, using synthesized specs:', err.message);
}

function synth(id, role, unitId) {
  return {
    id, version: '1.0.0', packId: 'synth', displayName: id, description: '',
    scope: unitId ? 'facility' : 'facility',
    trigger: { kind: 'manual' }, inputs: {}, outputs: {},
    plan: { type: 'step', step: { id: 's1', skill: 'llm.call', inputs: {}, retry: { maxAttempts: 3, backoffMs: 500 } } },
    governance: { phiHandling: 'read-write', purposeOfUse: ['treatment'], clearanceRequired: 'phi', hitlGates: [], breakGlassAllowed: false, evidenceRequired: [] },
    billing: { baseFeeUsd: 0, meteredUnits: [] },
    slas: {}, labels: { role },
  };
}

// Pick a few agents from real packs by id substring; if not found, synth
function pickReal(idSubstring, role) {
  const found = specs.find((s) => s.id.toLowerCase().includes(idSubstring));
  return found ?? synth(idSubstring, role);
}

const rt = new AgentRealmRuntime(realm);

// Spawn the ensemble
const mdSpec = pickReal('rounding', 'md');
const nurseSpecA = pickReal('nurse', 'nurse');
const nurseSpecB = pickReal('nurse', 'nurse');
const rxSpec = pickReal('pharmac', 'pharmacist');
const coderSpec = pickReal('coder', 'coder');
const safetySpec = pickReal('safety', 'auditor');

const md    = rt.spawn(mdSpec,    { facilityId: 'dvc-nash', unitId: 'dvc-nash-ICH-A' });
const rnA   = rt.spawn(nurseSpecA, { facilityId: 'dvc-nash', unitId: 'dvc-nash-ICH-A' });
const rnB   = rt.spawn({ ...nurseSpecB, id: `${nurseSpecB.id}-b` }, { facilityId: 'dvc-nash', unitId: 'dvc-nash-ICH-B' });
const rx    = rt.spawn(rxSpec,    { facilityId: 'dvc-nash' });
const coder = rt.spawn(coderSpec, { facilityId: 'dvc-nash' });
const safety = rt.spawn(safetySpec, { facilityId: 'dvc-nash' });

// Seed a realistic flow
realm.emit(md.presence.presenceId, { kind: 'record-agent-thought', note: 'Rounding pt-0001 — check K+ and HGB trends.' });
realm.emit(md.presence.presenceId, { kind: 'order-lab', patientId: 'dvc-nash-pt-0001', code: 'K', priority: 'stat' });
realm.emit(md.presence.presenceId, { kind: 'order-lab', patientId: 'dvc-nash-pt-0001', code: 'HGB', priority: 'routine' });
realm.emit(rnA.presence.presenceId, { kind: 'record-vitals', patientId: 'dvc-nash-pt-0001', hr: 88, bp: '148/92', spo2: 96 });
realm.emit(md.presence.presenceId, { kind: 'order-med', patientId: 'dvc-nash-pt-0002', code: 'lisinopril', dose: '10mg', route: 'PO', frequency: 'daily', indication: 'HTN' });
realm.emit(rnB.presence.presenceId, { kind: 'record-assessment', patientId: 'dvc-nash-pt-0004', assessmentId: 'phq9', score: 7, band: 'mild' });

// Advance time — matures labs, triggers ambient
for (let i = 0; i < 6; i++) realm.clock.advanceBy(60 * 60 * 1000);

// Coder handles a discharge
realm.emit(md.presence.presenceId, { kind: 'discharge-patient', patientId: 'dvc-nash-pt-0006', disposition: 'home' });

for (let i = 0; i < 6; i++) realm.clock.advanceBy(60 * 60 * 1000);

// Emit a claim so we can see the effect ledger complete a billing cycle
realm.emit(coder.presence.presenceId, { kind: 'submit-claim', encounterId: 'dvc-nash-enc-0006', payerId: 'medicare-part-b', cptCodes: ['90999'], icd10Codes: ['N18.6', 'I12.0'] });
// Follow-up scheduled after the claim (positive attribution: claim-followup-scheduled)
realm.emit(md.presence.presenceId, { kind: 'schedule-followup', patientId: 'dvc-nash-pt-0006', when: new Date(realm.clock.realmAt.getTime() + 7*24*3600_000).toISOString(), resource: 'nephrologist', followupKind: 'post-discharge' });

for (let i = 0; i < 6; i++) realm.clock.advanceBy(60 * 60 * 1000);

// Scenario: order-med followed by a safety event on the same patient produces
// a negative attribution (safety-event-after-med-action).
realm.emit(md.presence.presenceId, { kind: 'order-med', patientId: 'dvc-nash-pt-0003', code: 'gentamicin', dose: '80mg', route: 'IV', frequency: 'q8h', indication: 'sepsis' });
for (let i = 0; i < 2; i++) realm.clock.advanceBy(60 * 60 * 1000); // close the episode
realm.emit(rnA.presence.presenceId, { kind: 'flag-safety-event', patientId: 'dvc-nash-pt-0003', safetyKind: 'aki', severity: 'high' });
for (let i = 0; i < 2; i++) realm.clock.advanceBy(60 * 60 * 1000);

// Scenario: hold-med by pharmacist averts a safety event (positive attribution: hold-med-averted-safety)
realm.emit(md.presence.presenceId, { kind: 'order-med', patientId: 'dvc-nash-pt-0005', code: 'lisinopril', dose: '10mg', route: 'PO', frequency: 'daily' });
const meds5 = realm.graph.listKind('medication').filter((m) => (m.state).patientId === 'dvc-nash-pt-0005');
if (meds5.length > 0) {
  realm.emit(rx.presence.presenceId, { kind: 'hold-med', patientId: 'dvc-nash-pt-0005', medOrderId: meds5[meds5.length - 1].id, reason: 'K+ elevated' });
}
for (let i = 0; i < 6; i++) realm.clock.advanceBy(60 * 60 * 1000);

// ==== Build the payload the static UI consumes ====
const snap = realm.snapshot();
const units = realm.graph.listKind('unit').map((u) => ({ id: u.id, code: (u.state).code }));
const patients = realm.graph.listKind('patient').map((p) => ({
  id: p.id, unit: (p.state).unitId, trajectory: (p.state).trajectory, admitted: (p.state).admitted,
  vitals: (p.state).lastVitals, problems: (p.state).problemList, stage: (p.state).lifecycleStage ?? 'active',
}));
const presences = realm.presences.list().map((p) => ({
  presenceId: p.presenceId, agentSpecId: p.agentSpecId, role: p.role, location: p.location, spawnedAt: p.spawnedAt,
}));
const effects = realm.ledger.listAll().map((e) => ({
  effectId: e.effectId, presenceId: e.presenceId, agentSpecId: e.agentSpecId, emittedAt: e.emittedAt, realmAt: e.realmAt, status: e.status, effect: e.effect,
}));
const perception = realm.perception.recentLog(200);
const episodes = realm.episodes.all().map((e) => ({
  episodeId: e.episodeId, presenceId: e.presenceId, agentSpecId: e.agentSpecId, role: e.role,
  openedAt: e.openedAt, closedAt: e.closedAt, status: e.status, importance: e.importance,
  localGoal: e.localGoal, effectCount: e.effects.length,
  effectKinds: e.effects.map((f) => f.kind), hash: e.hash.slice(0, 10),
  choice: e.choice,
  effects: e.effects,
}));
const selfModels = realm.selfModel.list().map((s) => ({
  presenceId: s.presenceId, agentSpecId: s.agentSpecId, role: s.role,
  episodes: s.episodes, choices: s.choices, effects: s.effects, competence: s.competence,
  preferences: s.preferences, milestones: s.milestonesReached,
}));
// Refresh so all presences have up-to-date self-models
for (const pr of realm.presences.list()) realm.selfModel.refresh(pr, realm.episodes);
const experiences = realm.rules.history();

// Lifecycle cohorts — synthesize simple cohorts from patient trajectories.
// Diagrammatic nodes: onboarded → active → decompensating → hospitalized → discharged → transplant → mortality
const lifecycle = {
  nodes: [
    { id: 'referred', label: 'Referred', kind: 'entry' },
    { id: 'onboarded', label: 'Onboarded', kind: 'process' },
    { id: 'active', label: 'Active care', kind: 'process' },
    { id: 'decompensating', label: 'Decompensating', kind: 'risk' },
    { id: 'hospitalized', label: 'Hospitalized', kind: 'risk' },
    { id: 'stable', label: 'Stable', kind: 'good' },
    { id: 'transplant', label: 'Transplant', kind: 'exit-good' },
    { id: 'discharged', label: 'Discharged', kind: 'exit' },
    { id: 'mortality', label: 'Mortality', kind: 'exit-bad' },
  ],
  edges: [
    { from: 'referred', to: 'onboarded' },
    { from: 'onboarded', to: 'active' },
    { from: 'active', to: 'stable' },
    { from: 'active', to: 'decompensating' },
    { from: 'decompensating', to: 'hospitalized' },
    { from: 'hospitalized', to: 'active' },
    { from: 'hospitalized', to: 'discharged' },
    { from: 'hospitalized', to: 'mortality' },
    { from: 'stable', to: 'transplant' },
    { from: 'active', to: 'discharged' },
  ],
  cohorts: {},
};
for (const p of patients) {
  const key = p.trajectory === 'decompensating' ? 'decompensating' : p.trajectory === 'stable' ? 'stable' : 'active';
  lifecycle.cohorts[key] = (lifecycle.cohorts[key] ?? 0) + 1;
}
// Baseline seeded cohorts so the diagram tells a story
lifecycle.cohorts.referred = 2;
lifecycle.cohorts.onboarded = 3;
lifecycle.cohorts.hospitalized = 1;
lifecycle.cohorts.discharged = 1;
lifecycle.cohorts.transplant = 0;
lifecycle.cohorts.mortality = 0;

const payload = {
  realm: { id: realm.id, mode: realm.mode, seq: realm.clock.seq, realmAt: realm.clock.realmAt.toISOString(), counts: snap.counts },
  facility: { id: 'dvc-nash', kind: 'dialysis', name: 'DVC Nashville' },
  units, patients, presences, effects, perception,
  episodes, selfModels, experiences,
  attribution: realm.attribution.stats(),
  attributions: realm.attribution.all(),
  rules: realm.rules.list(),
  lifecycle,
};

writeFileSync('/home/user/workspace/hh-admin-ui/realm.json', JSON.stringify(payload, null, 2));
console.log('wrote realm.json —', {
  patients: patients.length, presences: presences.length, effects: effects.length,
  perception: perception.length, episodes: episodes.length, selfModels: selfModels.length,
  experiences: experiences.length, seq: realm.clock.seq,
});
