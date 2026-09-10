import { describe, expect, it, afterEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { RealmRegistry } from '../src/realm/index.js';
import { SimulatorController } from '../src/simulator/controller.js';
import { PANEL_CODES } from '../src/simulator/scenarios.js';
import { RENAL_PANEL_KEYS, buildRenalCohort, renalPatientFacts, renalPatientInputs, attributePatientIdFromOrder } from '../src/swarm/renal-cohort.js';
import { projectRealmEvents } from '../src/swarm/workspace.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, _r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

function cleanupSimRealms() {
  for (const r of RealmRegistry.list()) if (r.id.startsWith('sim:')) RealmRegistry.remove(r.id);
}

/** Patient state for the realm's first patient. */
function firstPatientState(realmId: string): Record<string, unknown> {
  const realm = RealmRegistry.get(realmId);
  expect(realm).toBeDefined();
  const patient = realm!.graph.listKind('patient')[0];
  expect(patient).toBeDefined();
  return patient!.state as Record<string, unknown>;
}

describe('F1 dialysis session data model (sim → reducer → state)', () => {
  const sim = new SimulatorController();
  afterEach(() => { sim.reset(); cleanupSimRealms(); });

  it('writes session records with delivered dose, UF, telemetry and adherence to patient state', async () => {
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(60); // sessions open at hour 48 and close at hour 60
    const state = firstPatientState('sim:test-a');
    const sessions = state.sessions as Array<Record<string, unknown>>;
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const session = sessions[0]!;
    expect(Number(session.deliveredMinutes)).toBeGreaterThan(0);
    expect(Number(session.ufVolumeL)).toBeGreaterThan(0);
    expect(Number(session.adherencePct)).toBeGreaterThan(0);
    expect(Number(session.telemetryPoints)).toBeGreaterThanOrEqual(1);
    // telemetry was folded into clinical aggregates, not just stored raw
    expect(Number(session.nadirSbp)).toBeGreaterThan(0);
    expect(Number(session.recirculationPct)).toBeGreaterThan(0);
    expect(state.currentSession).toBeNull(); // session closed
  });

  it('accumulates a session ring with inter-dialytic weight gain across sessions', async () => {
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(120); // two session cycles (starts at 48 + 96)
    const state = firstPatientState('sim:test-a');
    const sessions = state.sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // second session gained weight relative to the first post-weight
    expect(Number(sessions[1]!.preWeightKg)).toBeGreaterThan(Number(sessions[0]!.postWeightKg));
    expect(Number(sessions[1]!.postWeightKg)).toBeLessThan(Number(sessions[1]!.preWeightKg));
  });

  it('keeps an open session in flight between start and close', async () => {
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(52); // start at 48, telemetry at 54 → still open
    const open = firstPatientState('sim:test-a').currentSession as Record<string, unknown>;
    expect(open).toBeTruthy();
    expect(open.modality).toBeDefined();
    expect(Number(open.prescribedMinutes)).toBeGreaterThan(0);
    expect(Number(open.targetUfL)).toBeGreaterThan(0);
  });

  it('records access observations and maintenance med exposures on the demo script', async () => {
    await sim.start('dialysis-demo', { autoRun: false });
    sim.step(180);
    const realm = RealmRegistry.get('sim:renal-a')!;
    const kinds = realm.ledger.listAll().map((e) => e.effect.kind);
    expect(kinds).toContain('start-session');
    expect(kinds).toContain('record-session-telemetry');
    expect(kinds).toContain('end-session');
    const patient = realm.graph.listKind('patient')[0]!;
    const access = (patient.state as { access?: { type?: string; ageDays?: number } }).access;
    expect(access?.type).toBeTruthy();
    expect(Number(access?.ageDays)).toBeGreaterThan(0);
    // maintenance exposures exist on the ledger (binder / calcimimetic / vitamin D / IV iron)
    const medCodes = new Set(realm.ledger.listAll().filter((e) => e.effect.kind === 'order-med').map((e) => (e.effect as { code: string }).code));
    expect(medCodes.size).toBeGreaterThan(0);
  });

  it('orders the CKD-MBD / nutrition / infection panel and matures it into results', async () => {
    await sim.start('dialysis-demo', { autoRun: false });
    sim.step(6); // panel-baseline fires at hour 5
    const realm = RealmRegistry.get('sim:renal-a')!;
    const ordered = new Set(
      realm.ledger.listAll()
        .filter((e) => e.effect.kind === 'order-lab')
        .map((e) => (e.effect as { code: string }).code),
    );
    for (const code of PANEL_CODES) expect(ordered.has(code)).toBe(true);
    // ambient lab maturation turns them into results a few ticks later
    sim.step(4);
    const results = new Set(
      realm.ledger.listAll()
        .filter((e) => e.effect.kind === 'result-lab')
        .map((e) => (e.effect as { code: string }).code),
    );
    expect([...PANEL_CODES].some((c) => results.has(c))).toBe(true);
  });

  it('projects the new session/access effects into canonical exec event types', () => {
    const projected = projectRealmEvents([
      { realmId: 'r1', eventId: 'e1', kind: 'start-session', status: 'bound', emittedAt: '2026-08-01T06:00:00.000Z', payload: { patientId: 'p1' } },
      { realmId: 'r1', eventId: 'e2', kind: 'record-session-telemetry', status: 'bound', emittedAt: '2026-08-01T07:00:00.000Z', payload: { patientId: 'p1' } },
      { realmId: 'r1', eventId: 'e3', kind: 'end-session', status: 'bound', emittedAt: '2026-08-01T10:00:00.000Z', payload: { patientId: 'p1' } },
      { realmId: 'r1', eventId: 'e4', kind: 'record-access', status: 'bound', emittedAt: '2026-08-01T11:00:00.000Z', payload: { patientId: 'p1' } },
    ]);
    expect(projected.map((p) => p.eventType)).toEqual([
      'session.started.v1', 'session.telemetry.v1', 'session.ended.v1', 'access.observed.v1',
    ]);
    for (const p of projected) expect(p.subjectType).toBe('patient');
  });
});

describe('F1 renal cohort derivation', () => {  const state = {
    facilityId: 'fac-a', unitId: 'ICH-A', trajectory: 'hyperphosphatemia', age: 66, sex: 'M',
    access: { type: 'avf', site: 'left-forearm', ageDays: 420 },
    accessObservations: [{ at: '2026-08-05T07:00:00.000Z', event: 'cannulation-difficulty' }],
    labs: { K: 5.4, HGB: 10.2, URR: 66, PHOS: 6.2, FERRITIN: 320, TSAT: 18, calcium: 9.6, pth: 640, albumin: 3.4, creatinine: 8.6, bicarb: 21, crp: 12.4, wbc: 8.1, procalcitonin: 0.3 },
    lastVitals: { hr: 82, bp: '118/72', spo2: 96, temp: 38.4, at: '2026-08-06T07:00:00.000Z' },
    esaDose: 6000,
    sessions: [
      { sessionId: 's1', startedAt: '2026-08-01T07:00:00.000Z', endedAt: '2026-08-01T11:00:00.000Z', deliveredMinutes: 210, prescribedMinutes: 220, ufVolumeL: 2.4, targetUfL: 2.6, preWeightKg: 72.4, postWeightKg: 70.0, qbAvg: 348, recirculationPct: 5.2, nadirSbp: 104, meanSbp: 112, stoppedEarly: false, telemetryPoints: 2 },
      { sessionId: 's2', startedAt: '2026-08-03T07:00:00.000Z', endedAt: '2026-08-03T10:30:00.000Z', deliveredMinutes: 180, prescribedMinutes: 240, ufVolumeL: 1.9, targetUfL: 2.6, preWeightKg: 73.6, postWeightKg: 71.7, qbAvg: 340, recirculationPct: 14.5, nadirSbp: 86, meanSbp: 98, stoppedEarly: true, complication: 'intradialytic-hypotension', symptoms: ['cramping'], telemetryPoints: 1 },
    ],
  };

  it('attributes matured lab results to a patient via the longest order-id prefix', () => {
    expect(attributePatientIdFromOrder('p1-2-HGB-1', ['p1', 'p1-2'])).toBe('p1-2');
    expect(attributePatientIdFromOrder('p1-2-HGB-1', ['p1'])).toBe('p1');
    expect(attributePatientIdFromOrder('unrelated-1', ['p1'])).toBeUndefined();
  });

  it('merges ledger lab results (orderId-attributed) over seeded patient-state labs', () => {
    const realms = [
      {
        id: 'sim:renal-a',
        ledger: {
          listAll: () => [
            { emittedAt: '2026-08-01T06:05:00.000Z', effect: { kind: 'order-lab', patientId: 'fac-a-pt-0001', code: 'CALCIUM' } },
            // matured results carry ONLY an orderId
            { emittedAt: '2026-08-01T06:09:00.000Z', effect: { kind: 'result-lab', orderId: 'fac-a-pt-0001-CALCIUM-1', code: 'CALCIUM', value: 9.4, unit: 'mg/dL' } },
            { emittedAt: '2026-08-01T06:09:00.000Z', effect: { kind: 'result-lab', orderId: 'fac-a-pt-0001-PTH-1', code: 'PTH', value: 640, unit: 'pg/mL' } },
            { emittedAt: '2026-08-01T06:10:00.000Z', effect: { kind: 'order-med', patientId: 'fac-a-pt-0001', code: 'sevelamer', dose: '800 mg', route: 'PO', frequency: 'three times daily' } },
          ],
        },
        graph: {
          listKind: () => [
            { id: 'fac-a-pt-0001', state: { labs: { PHOS: 6.2 }, access: { type: 'avf' }, sessions: [] } },
            { id: 'fac-a-pt-0002', state: { labs: {}, access: { type: 'avf' }, sessions: [] } },
          ],
        },
      },
    ];
    const inputs = renalPatientInputs(realms as never);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.labs?.CALCIUM?.value).toBe(9.4);
    expect(inputs[0]!.medCodes).toEqual(['sevelamer']);
    expect(inputs[1]!.labs).toBeUndefined();

    const facts = renalPatientFacts(inputs[0]!);
    expect(facts.labs.calcium).toBe(9.4); // ledger wins
    expect(facts.labs.PHOS).toBe(6.2); // seeded state retained
    expect(facts.panel.present).toEqual(['calcium', 'pth']);
    expect(facts.panel.completenessPct).toBe(25);
    expect(facts.exposure.phosphateBinders).toEqual(['sevelamer']);
  });

  it('derives sessions, adherence, IDWG, access and panel facts from patient state', () => {
    const facts = renalPatientFacts({ id: 'fac-a-pt-0001', realmId: 'sim:renal-a', state, medCodes: ['sevelamer', 'cinacalcet', 'calcitriol', 'ferric-sucrose'] });
    expect(facts.sessions.count).toBe(2);
    expect(facts.sessions.stoppedEarlyCount).toBe(1);
    expect(facts.sessions.complicationCount).toBe(1);
    expect(facts.sessions.telemetryPoints).toBe(3);
    expect(facts.sessions.minNadirSbp).toBe(86);
    expect(facts.sessions.avgRecirculationPct).toBe(9.9);
    expect(facts.sessions.avgAdherencePct).toBe(85); // 95% and 75%
    // session 2 IDWG = 73.6 − 70.0 (previous post-weight)
    expect(facts.sessions.avgIdwgKg).toBe(3.6);
    expect(facts.sessions.avgUfAchievementPct).toBe(82.5);
    expect(facts.panel.missing).toHaveLength(0);
    expect(facts.panel.completenessPct).toBe(100);
    expect(facts.access.dysfunction).toBe(true);
    expect(facts.exposure.phosphateBinders).toEqual(['sevelamer']);
    expect(facts.exposure.calcimimetics).toEqual(['cinacalcet']);
    expect(facts.exposure.vitaminD).toEqual(['calcitriol']);
    expect(facts.exposure.ivIron).toBe(true);
    expect(facts.signals).toMatchObject({
      hypotensiveSessions: 1, shortSessions: 1, highRecirculation: false,
      hyperphosphatemia: true, hypercalcemia: false, hyperparathyroidism: true,
      lowAlbumin: true, inflammation: true, metabolicAcidosis: true, infectionRisk: true, accessRisk: true,
    });
  });

  it('rolls the cohort up into fleet-level rates', () => {
    const cohort = buildRenalCohort([
      { id: 'p1', realmId: 'sim:renal-a', state, medCodes: ['sevelamer'] },
      { id: 'p2', realmId: 'sim:renal-b', state: { access: { type: 'catheter' }, labs: { calcium: 9.0 }, sessions: [] } },
    ]);
    expect(cohort.summary.patients).toBe(2);
    expect(cohort.summary.realms).toBe(2);
    expect(cohort.summary.sessions).toBe(2);
    expect(cohort.summary.patientsWithSessions).toBe(1);
    expect(cohort.summary.avgSessionsPerPatient).toBe(1);
    expect(cohort.summary.hypotensionRatePct).toBe(50);
    expect(cohort.summary.shortSessionRatePct).toBe(50); // 95% and 75% adherence → one short session
    expect(cohort.summary.hyperparathyroidismCount).toBe(1);
    expect(cohort.summary.infectionRiskCount).toBe(1);
    expect(cohort.summary.accessRiskCount).toBe(1); // only p1 has a dysfunctional-access observation
    expect(cohort.summary.avgPanelCompletenessPct).toBe(57); // 100% + 13%
  });
});

describe('F1 renal read routes', () => {
  async function build() {
    return buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      renalPatients: () => [
        {
          id: 'fac-a-pt-0001', realmId: 'sim:renal-a', medCodes: ['sevelamer'],
          state: {
            facilityId: 'fac-a', access: { type: 'avf', ageDays: 300 },
            labs: { PHOS: 6.1, calcium: 9.4, pth: 700, albumin: 3.6, creatinine: 8.4, bicarb: 23, crp: 8, wbc: 7, procalcitonin: 0.2 },
            sessions: [{ sessionId: 's1', startedAt: '2026-08-01T07:00:00.000Z', endedAt: '2026-08-01T11:00:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 2.5, targetUfL: 2.5, stoppedEarly: false, telemetryPoints: 2 }],
            accessObservations: [],
          },
        },
      ],
    });
  }

  it('serves the renal cohort with derived facts and fleet summary', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/renal/cohort' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.panelKeys).toEqual([...RENAL_PANEL_KEYS]);
      expect(body.patients).toHaveLength(1);
      expect(body.patients[0].signals.hyperparathyroidism).toBe(true);
      expect(body.patients[0].exposure.phosphateBinders).toEqual(['sevelamer']);
      expect(body.summary.patients).toBe(1);
      expect(body.summary.hyperparathyroidismCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('serves per-patient session history and 404s unknown patients', async () => {
    const app = await build();
    try {
      const ok = await app.inject({ method: 'GET', url: '/admin/swarm/renal/patients/fac-a-pt-0001/sessions' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().sessions).toHaveLength(1);
      expect(ok.json().sessionSummary.avgAdherencePct).toBe(100);
      const missing = await app.inject({ method: 'GET', url: '/admin/swarm/renal/patients/nope/sessions' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves the fleet summary on its own endpoint', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/renal/summary' });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.sessions).toBe(1);
    } finally {
      await app.close();
    }
  });
});
