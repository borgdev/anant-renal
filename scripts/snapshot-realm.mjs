// Build a canned Realm snapshot for the deployed UI.
// Runs a small sim using the AgentRealmRuntime, seeds a dialysis facility,
// spawns real agents from the pack registry, and captures episodes,
// self-models, experiences, and effects for the static UI to render.

import { writeFileSync } from 'node:fs';
import { Realm, populateFacility, AgentRealmRuntime, Federation, invoicePreview, DEFAULT_BILLING_PLAN, RealmRegistry, listDirectives, listPlanAdvances, directivesByTarget, NotificationBus, NotificationHub, attachBus, LLMRegistry, CounterfactualStore, captureSnapshot, SnapshotRegistry, runCounterfactual } from '../dist/src/realm/index.js';
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

// ==== M12 scenarios ====
// Seed physical objects (dialysis chairs) and tickets, run intents through the planner,
// exercise HITL gates, and record an operator directive so the UI shows all M12 primitives.
for (let i = 1; i <= 4; i++) {
  realm.graph.create('physical-object', `chair-${i}`, { objectKind: 'chair', state: 'idle', locationUnitId: i <= 2 ? 'dvc-nash-ICH-A' : 'dvc-nash-ICH-B' });
}
realm.graph.create('physical-object', 'ro-machine-1', { objectKind: 'ro-system', state: 'idle', locationUnitId: 'dvc-nash-facility' });

// Assign a chair to a patient, mark another for maintenance
realm.emit(rnA.presence.presenceId, { kind: 'assign-object', objectId: 'chair-1', toPatientId: 'dvc-nash-pt-0001', reason: 'session start' });
realm.emit(rnA.presence.presenceId, { kind: 'mark-object-state', objectId: 'chair-3', newState: 'maintenance', reason: 'weekly clean' });

// Open an IT/facilities ticket and close it
const t1 = realm.emit(rnB.presence.presenceId, { kind: 'open-ticket', ticketKind: 'facilities', assigneeRole: 'facilities-tech', priority: 'high', summary: 'RO alarm on ro-machine-1', subjectRef: 'ro-machine-1' });
const t1Id = realm.graph.listKind('work-artifact').filter((w) => (w.state).ticketKind === 'facilities')[0]?.id;
if (t1Id) realm.emit(rnB.presence.presenceId, { kind: 'close-ticket', ticketId: t1Id, resolution: 'resolved', note: 'RO valve reseated' });

// Submit a real intent → plan
await realm.submitIntent({ intentKind: 'discharge-patient-safely', subjectRef: 'dvc-nash-pt-0006', description: 'Safe discharge pt-0006 to home', priority: 'normal', by: md.presence.presenceId });
await realm.submitIntent({ intentKind: 'fix-station', subjectRef: 'chair-3', description: 'Chair 3 needs service', priority: 'high', by: rnA.presence.presenceId });

// Trigger a HITL gate: a critical safety event should be suspended
realm.emit(safety.presence.presenceId, { kind: 'flag-safety-event', patientId: 'dvc-nash-pt-0002', safetyKind: 'anaphylaxis', severity: 'critical' });
// And a high-dollar claim gate (>=4 CPT codes)
realm.emit(coder.presence.presenceId, { kind: 'submit-claim', encounterId: 'dvc-nash-enc-0001', payerId: 'medicare-part-b', cptCodes: ['90999', '99215', '90935', '90945'], icd10Codes: ['N18.6'] });

// Approve the first pending HITL entry so we get a full round-trip visible.
const pending = realm.hitl.pending();
if (pending.length > 0) {
  realm.hitl.decide(pending[0].approvalId, 'approve', 'admin-demo', 'Reviewed — legitimate.');
}

// Spawn an admin presence and record an operator directive so audit log has one
const adminP = realm.spawnPresence({
  agentSpecId: 'admin-console', runId: 'admin-run', role: 'admin', clearance: 'internal', purposeOfUse: ['operations'],
  location: { facilityId: 'dvc-nash' }, perceptualRange: { units: ['*'], patients: [], eventTypes: ['*'] },
});
const directive = await realm.operatorSeat.parse(`bias ${rnA.presence.presenceId} toward hold-med by 0.25`);
if (directive) realm.operatorSeat.apply(directive, adminP.presenceId);

for (let i = 0; i < 4; i++) realm.clock.advanceBy(60 * 60 * 1000);

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

// M12 payload extensions
const orgNodes = realm.graph.listKind('org-node').map((n) => ({ id: n.id, ...n.state }));
const physicalObjects = realm.graph.listKind('physical-object').map((o) => ({ id: o.id, ...o.state }));
const workArtifacts = realm.graph.listKind('work-artifact').map((w) => ({ id: w.id, ...w.state }));
const intents = realm.listIntents();
const plans = realm.listPlans();
const approvals = realm.hitl.all();
const costRollup = realm.cost.rollup();
const costRecords = realm.cost.list();
const operatorDirectives = realm.graph.listKind('operator-directive').map((d) => ({ id: d.id, ...d.state }));

const payload = {
  realm: { id: realm.id, mode: realm.mode, seq: realm.clock.seq, realmAt: realm.clock.realmAt.toISOString(), counts: snap.counts },
  facility: { id: 'dvc-nash', kind: 'dialysis', name: 'DVC Nashville' },
  units, patients, presences, effects, perception,
  episodes, selfModels, experiences,
  attribution: realm.attribution.stats(),
  attributions: realm.attribution.all(),
  rules: realm.rules.list(),
  lifecycle,
  // M12
  org: { nodes: orgNodes },
  physicalObjects,
  workArtifacts,
  intents,
  plans,
  approvals,
  hitl: { gates: realm.hitl.listGates().map((g) => ({ id: g.id, reason: g.reason })), pending: realm.hitl.pending().length, all: approvals.length },
  cost: { rollup: costRollup, records: costRecords },
  operatorDirectives,
};

// ---------- M13 snapshots ----------
// Register the demo realm in the RealmRegistry so Federation can find it.
try { RealmRegistry.register(realm); } catch (_) { /* already? */ }

// Build a second sim realm for federation demo
const realm2 = new Realm({ id: 'realm:demo-dvc-brentwood', mode: 'sim' });
populateFacility(realm2, { facilityId: 'dvc-brent', kind: 'dialysis', name: 'DVC Brentwood', units: ['ICH-A', 'ICH-B'], patientCount: 8 });
try { RealmRegistry.register(realm2); } catch (_) { /* ok */ }
Federation.registerOrg({ orgId: 'org-davita-mid-tn', displayName: 'DaVita Middle Tennessee', realmIds: [realm.id, realm2.id] });
const orgSummary = Federation.orgSummary('org-davita-mid-tn');

const billingReport = invoicePreview(realm, DEFAULT_BILLING_PLAN, {});

// Policy trace for a few key presences
const policyKinds = ['order-lab', 'order-med', 'hold-med', 'record-vitals', 'flag-safety-event', 'submit-claim', 'discharge-patient', 'schedule-followup'];
const policyTraces = realm.presences.list().slice(0, 6).map((p) => ({
  presenceId: p.presenceId,
  role: p.role,
  trace: policyKinds.map((k) => {
    const w = realm.selfModel.preferenceFor(p.presenceId, k);
    return { effectKind: k, weight: w, lean: w > 1.05 ? 'toward' : w < 0.95 ? 'away' : 'neutral' };
  }),
}));

payload.federation = {
  orgs: Federation.listOrgs(),
  summary: orgSummary,
};
payload.billing = { plan: DEFAULT_BILLING_PLAN, report: billingReport };
payload.policyTraces = policyTraces;

writeFileSync('/home/user/workspace/hh-admin-ui/realms-list.json', JSON.stringify({ realms: [{ id: realm.id, mode: realm.mode }, { id: realm2.id, mode: realm2.mode }] }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/orgs.json', JSON.stringify({ orgs: Federation.listOrgs() }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/org-summary.json', JSON.stringify(orgSummary, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/billing.json', JSON.stringify({ plan: DEFAULT_BILLING_PLAN, report: billingReport }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/policy.json', JSON.stringify(policyTraces, null, 2));

// ---------- M14 snapshots ----------
// M14.D: attach a notification bus and register a demo subscription.
const bus = NotificationHub;
bus.subscribe({ eventKinds: ['flag-safety-event', 'submit-claim', 'advance-plan'], sink: () => {} });
attachBus(realm, bus);
attachBus(realm2, bus);
// Replay a couple of effects to hydrate history (bus only saw future emits above).
realm.emit(rnA.presence.presenceId, { kind: 'flag-safety-event', patientId: 'dvc-nash-pt-0001', safetyKind: 'fall-risk', severity: 'moderate' });

// M14.F: register a dummy Ollama-shaped adapter
LLMRegistry.register({
  id: 'ollama-llama3-operator',
  role: 'operator',
  displayName: 'Ollama · llama3 (operator parse)',
  enabled: false,
  handle: { id: 'ollama-llama3-operator', async parse(text) { return { verb: 'explain', payload: { presenceId: 'unknown' }, originalText: text, reasoning: 'stub — connect Ollama', confidence: 0.3 }; } },
});
LLMRegistry.register({
  id: 'ollama-llama3-planner',
  role: 'planner',
  displayName: 'Ollama · llama3 (planner)',
  enabled: false,
  handle: { id: 'ollama-llama3-planner', async plan() { return [{ id: 's1', label: 'noop-plan', ownerRole: 'admin', status: 'pending' }]; } },
});
for (const a of LLMRegistry.list()) { await LLMRegistry.healthCheck(a.id).catch(() => {}); }

// M14.B: run a small counterfactual for the deployed UI to display
const cfBuild = () => {
  const fresh = new Realm({ id: `cf#dvc-nash#${Date.now()}`, mode: 'sim' });
  populateFacility(fresh, { facilityId: 'dvc-nash', kind: 'dialysis', name: 'DVC Nashville CF', units: ['ICH-A'], patientCount: 4 });
  return fresh;
};
try {
  const cfReport = runCounterfactual({ build: cfBuild, timeline: [], interventions: [{ kind: 'nudge-preference', presenceRole: 'md', effectKind: 'order-lab', delta: 0.5 }], advanceTicks: 4 });
  CounterfactualStore.save({ build: cfBuild, timeline: [], interventions: [{ kind: 'nudge-preference', presenceRole: 'md', effectKind: 'order-lab', delta: 0.5 }], advanceTicks: 4 }, cfReport, 'demo · bias md toward labs', realm.id);
} catch (err) { console.warn('counterfactual failed:', err.message); }

// M14.G: capture a snapshot of the demo realm
const realmSnap = captureSnapshot(realm);
SnapshotRegistry.save(realmSnap);

// M14.E: org billing rollup
const orgBilling = Federation.invoicePreviewForOrg('org-davita-mid-tn', DEFAULT_BILLING_PLAN, {});

// M14.A / M14.C: pick any plan and dump its runLog + governance summaries
const allPlans = realm.listPlans();
for (const pl of allPlans) { try { realm.runPlan(pl.planId); } catch (_) { /* ignore */ } }
const planTimelines = realm.listPlans().map((p) => ({
  realmId: realm.id, planId: p.planId, steps: p.steps,
  runLog: p.runLog ?? [],
}));

const govDirectives = listDirectives(realm);
const govAdvances = listPlanAdvances(realm);
const govByTarget = directivesByTarget(realm);

writeFileSync('/home/user/workspace/hh-admin-ui/orgs-billing.json', JSON.stringify(orgBilling, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/notifications.json', JSON.stringify({ notifications: bus.recent(50), subscriptions: bus.listSubscriptions().map((s) => ({ id: s.id, eventKinds: s.eventKinds, role: s.role ?? null })) }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/llm-adapters.json', JSON.stringify({ adapters: LLMRegistry.list() }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/governance.json', JSON.stringify({ realmId: realm.id, directives: govDirectives, advances: govAdvances, byTarget: govByTarget }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/counterfactuals.json', JSON.stringify({ counterfactuals: CounterfactualStore.list() }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/snapshots.json', JSON.stringify({ snapshots: SnapshotRegistry.list() }, null, 2));
writeFileSync('/home/user/workspace/hh-admin-ui/plan-timelines.json', JSON.stringify({ timelines: planTimelines }, null, 2));

// ---------- M15/M16/M17/M18 payloads ----------
import { createOrgWithFacilities, ONBOARDING_TEMPLATES } from '../dist/src/onboarding/bootstrap.js';
import { IdentityRegistry, createInvite, claimInvite, activateBreakGlass, reviewBreakGlass, pendingReviews, Scim, listInvites } from '../dist/src/identity/index.js';
import { SelfServeAdmin } from '../dist/src/self-serve/admin.js';

// Pack inventory (M15)
import { readdirSync as _rd, existsSync as _ex } from 'node:fs';
import { join as _jn } from 'node:path';
const _packsRoot = new URL('../packs/', import.meta.url).pathname;
const _packInventory = _rd(_packsRoot).filter((d) => _ex(_jn(_packsRoot, d, 'agents'))).map((d) => ({
  packId: d,
  agentCount: _rd(_jn(_packsRoot, d, 'agents')).filter((f) => f.endsWith('.yaml')).length,
}));
writeFileSync('/home/user/workspace/hh-admin-ui/packs-inventory.json', JSON.stringify({ packs: _packInventory, total: _packInventory.reduce((n, p) => n + p.agentCount, 0) }, null, 2));

// Onboarding templates
writeFileSync('/home/user/workspace/hh-admin-ui/onboarding-templates.json', JSON.stringify({
  templates: ONBOARDING_TEMPLATES.map((t) => ({ id: t.id, displayName: t.displayName, description: t.description })),
}, null, 2));

// Sample bootstrap result — small independent clinic
const _sampleBootstrap = createOrgWithFacilities({
  orgId: 'demo-clinic', displayName: 'Demo Independent Clinic', sampleData: true,
  facilities: [{ facilityId: 'main', kind: 'dialysis', name: 'Demo Site', units: ['A', 'B'], patientCount: 12 }],
});
writeFileSync('/home/user/workspace/hh-admin-ui/onboarding-sample.json', JSON.stringify(_sampleBootstrap, null, 2));

// Identity: role mapping + a couple of invited users + a break-glass
IdentityRegistry.setMapping({
  orgId: 'demo-clinic', defaultRole: 'nurse',
  entries: [
    { idpGroup: 'okta-admins', role: 'admin', clearance: 'phi', purposeOfUse: ['operations', 'quality'] },
    { idpGroup: 'okta-docs',   role: 'md',    clearance: 'phi', purposeOfUse: ['treatment'] },
    { idpGroup: 'okta-rns',    role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'] },
  ],
});
const _adminInv = createInvite({ orgId: 'demo-clinic', email: 'admin@democlinic.com', role: 'admin' });
const _adminPrincipal = claimInvite(_adminInv.token, { displayName: 'Demo Admin' });
const _mdInv = createInvite({ orgId: 'demo-clinic', email: 'dr.smith@democlinic.com', role: 'md' });
const _mdPrincipal = claimInvite(_mdInv.token, { displayName: 'Dr. Smith' });
const _bg = activateBreakGlass({ subjectId: _mdPrincipal.subjectId, reason: 'Acute code — external records lookup, patient dvc-nash-pt-0001.' });
reviewBreakGlass(_bg.session.sessionId, _adminPrincipal.subjectId, 'Justified — verified event in EHR.', true);
// SCIM sample
const _scimUser = Scim.createUser('demo-clinic', {
  userName: 'jane.doe@democlinic.com',
  emails: [{ value: 'jane.doe@democlinic.com', primary: true }],
  name: { givenName: 'Jane', familyName: 'Doe' },
  groups: [{ value: 'okta-rns', display: 'okta-rns' }],
  active: true,
});

writeFileSync('/home/user/workspace/hh-admin-ui/identity.json', JSON.stringify({
  providers: IdentityRegistry.listProviders(),
  mappings: IdentityRegistry.listMappings(),
  principals: IdentityRegistry.listPrincipals(),
  invites: listInvites(),
  breakGlass: {
    active: [],
    pending: pendingReviews(),
  },
  audit: IdentityRegistry.listAudit(50),
}, null, 2));

// M18 sample
SelfServeAdmin.setPackToggles({ realmId: 'demo-clinic-main', enabledPacks: ['flagship-agents', 'dialysis-deep', 'behavioral-health'], disabledAgents: [] }, _adminPrincipal.subjectId);
SelfServeAdmin.addMeterOverride({ realmId: 'demo-clinic-main', unit: 'llm.tokens.input', priceUsdPerUnit: 0.000002, budgetCapMonthlyUsd: 500 }, _adminPrincipal.subjectId);
SelfServeAdmin.addHitlGate({ realmId: 'demo-clinic-main', agentSelector: 'suicidality-*', afterStepId: 'step-3', role: 'md', slaMinutes: 15 }, _adminPrincipal.subjectId);
SelfServeAdmin.setBranding({ realmId: 'demo-clinic-main', brandName: 'Demo Independent Clinic', primaryColor: '#03A9F4', supportEmail: 'support@democlinic.com' }, _adminPrincipal.subjectId);
writeFileSync('/home/user/workspace/hh-admin-ui/self-serve.json', JSON.stringify({
  packToggles: SelfServeAdmin.listPackToggles(),
  meterOverrides: SelfServeAdmin.listMeterOverrides('demo-clinic-main'),
  hitlGates: SelfServeAdmin.listHitlGates('demo-clinic-main'),
  customEffects: SelfServeAdmin.listCustomEffects('demo-clinic-main'),
  branding: SelfServeAdmin.listBranding(),
}, null, 2));

writeFileSync('/home/user/workspace/hh-admin-ui/realm.json', JSON.stringify(payload, null, 2));
console.log('wrote realm.json —', {
  patients: patients.length, presences: presences.length, effects: effects.length,
  perception: perception.length, episodes: episodes.length, selfModels: selfModels.length,
  experiences: experiences.length, seq: realm.clock.seq,
  org: orgNodes.length, physicalObjects: physicalObjects.length, workArtifacts: workArtifacts.length,
  intents: intents.length, plans: plans.length, approvals: approvals.length, operatorDirectives: operatorDirectives.length,
  costEpisodes: costRollup.episodeCount,
});
