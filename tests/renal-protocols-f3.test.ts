import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

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

/** One deteriorating patient + one stable patient — real patient-state shape from F1. */
const PATIENTS = [
  {
    id: 'fac-a-pt-0001', realmId: 'sim:renal-a', trajectory: 'decompensating', medCodes: ['sevelamer', 'cinacalcet'],
    state: {
      facilityId: 'fac-a', unitId: 'ICH-A', age: 68, sex: 'M', trajectory: 'decompensating',
      access: { type: 'catheter', site: 'right-internal-jugular', ageDays: 45, events: [] },
      accessObservations: [{ at: '2026-08-05T07:00:00.000Z', event: 'cannulation-difficulty' }],
      labs: { K: 5.9, HGB: 9.1, URR: 58, PHOS: 6.6, FERRITIN: 240, TSAT: 16, calcium: 9.4, pth: 760, albumin: 3.1, creatinine: 7.2, bicarb: 19, crp: 18, wbc: 8.6, procalcitonin: 0.4 },
      lastVitals: { hr: 96, bp: '108/66', spo2: 94, temp: 38.4, at: '2026-08-06T07:00:00.000Z' },
      esaDose: 8000,
      sessions: [
        { sessionId: 's1', startedAt: '2026-08-01T07:00:00.000Z', endedAt: '2026-08-01T10:50:00.000Z', deliveredMinutes: 190, prescribedMinutes: 240, ufVolumeL: 1.8, targetUfL: 2.8, preWeightKg: 78.2, postWeightKg: 76.4, qbAvg: 320, recirculationPct: 14.5, nadirSbp: 84, meanSbp: 96, stoppedEarly: true, complication: 'intradialytic-hypotension', symptoms: ['cramping'], telemetryPoints: 2 },
        { sessionId: 's2', startedAt: '2026-08-03T07:00:00.000Z', endedAt: '2026-08-03T10:20:00.000Z', deliveredMinutes: 180, prescribedMinutes: 240, ufVolumeL: 1.6, targetUfL: 2.8, preWeightKg: 79.0, postWeightKg: 77.4, qbAvg: 316, recirculationPct: 16.2, nadirSbp: 86, meanSbp: 98, stoppedEarly: true, complication: 'intradialytic-hypotension', telemetryPoints: 2 },
      ],
    },
  },
  {
    id: 'fac-a-pt-0002', realmId: 'sim:renal-a', trajectory: 'stable', medCodes: ['sevelamer'],
    state: {
      facilityId: 'fac-a', unitId: 'ICH-A', age: 55, sex: 'F', trajectory: 'stable',
      access: { type: 'avf', site: 'left-forearm', ageDays: 640, events: [] },
      accessObservations: [{ at: '2026-08-04T07:00:00.000Z', event: 'angioplasty' }],
      labs: { K: 4.4, HGB: 11.5, URR: 72, PHOS: 4.4, FERRITIN: 340, TSAT: 30, calcium: 9.2, pth: 240, albumin: 3.9, creatinine: 8.8, bicarb: 24, crp: 3.1, wbc: 6.4, procalcitonin: 0.1 },
      lastVitals: { hr: 74, bp: '128/78', spo2: 97, temp: 36.6, at: '2026-08-06T07:00:00.000Z' },
      sessions: [
        { sessionId: 's1', startedAt: '2026-08-01T07:00:00.000Z', endedAt: '2026-08-01T11:05:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 2.6, targetUfL: 2.6, preWeightKg: 66.0, postWeightKg: 63.4, qbAvg: 350, recirculationPct: 4.1, nadirSbp: 112, meanSbp: 120, stoppedEarly: false, telemetryPoints: 2 },
        { sessionId: 's2', startedAt: '2026-08-03T07:00:00.000Z', endedAt: '2026-08-03T11:02:00.000Z', deliveredMinutes: 238, prescribedMinutes: 240, ufVolumeL: 2.4, targetUfL: 2.5, preWeightKg: 65.8, postWeightKg: 63.4, qbAvg: 348, recirculationPct: 3.8, nadirSbp: 110, meanSbp: 118, stoppedEarly: false, telemetryPoints: 2 },
      ],
    },
  },
];

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    renalPatients: () => PATIENTS,
  });
}

describe('F3 protocol operations shell', () => {
  it('serves the registry (7 protocols, substates, priors) as configuration', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/protocols' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(7);
      expect(body.substates).toHaveLength(7);
      expect(new Set(body.protocols.map((p: { substate: string }) => p.substate)).size).toBe(7);
      expect(body.priors.length).toBeGreaterThanOrEqual(6);
      // every descriptor carries its model plan + safety class (no page scaffolding needed)
      for (const p of body.protocols) {
        expect(p.model.rationale).toBeTruthy();
        expect(['A', 'B', 'C']).toContain(p.safetyClass);
      }
    } finally {
      await app.close();
    }
  });

  it('derives the cockpit from real patient state: per-protocol status + per-patient latent + forecasts', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/protocols/cockpit' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.protocols).toHaveLength(7);
      expect(body.index.patients).toBe(2);
      expect(body.index.redProtocols).toBeGreaterThan(0);
      expect(body.horizonsDays).toEqual([7, 28, 84]);
      expect(body.patients).toHaveLength(2);
      // worst patient first, with the shared latent (7 substates + global) and 21 forecasts
      const worst = body.patients[0];
      expect(worst.patientId).toBe('fac-a-pt-0001');
      expect(worst.latent).toHaveLength(8);
      expect(worst.protocols).toHaveLength(7);
      expect(worst.forecasts).toHaveLength(21);
      expect(new Set(worst.forecasts.map((f: { horizonDays: number }) => f.horizonDays)).size).toBe(3);
      // fluid + adequacy + mbd + nutrition are flagged for this patient
      const red = worst.protocols.filter((p: { status: string }) => p.status === 'red').map((p: { protocol: string }) => p.protocol);
      expect(red).toContain('fluid');
      expect(red).toContain('ckd-mbd');
      // the stable patient is not all-red
      const stable = body.patients.find((p: { patientId: string }) => p.patientId === 'fac-a-pt-0002');
      const stableRed = stable.protocols.filter((p: { status: string }) => p.status === 'red');
      expect(stableRed.length).toBeLessThan(red.length);
    } finally {
      await app.close();
    }
  });

  it('serves one protocol in depth and 404s unknown protocols', async () => {
    const app = await build();
    try {
      const ok = await app.inject({ method: 'GET', url: '/admin/swarm/protocols/ckd-mbd' });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(body.protocol.id).toBe('ckd-mbd');
      expect(body.protocol.substate).toBe('SI');
      expect(body.report.evaluated).toBe(2);
      expect(body.patients[0].patientId).toBe('fac-a-pt-0001');
      expect(body.patients[0].forecasts.length).toBe(3); // 7/28/84 d
      expect(body.patients[0].signals.length).toBeGreaterThan(0);
      const missing = await app.inject({ method: 'GET', url: '/admin/swarm/protocols/not-a-protocol' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves the F2 head-vs-baseline evaluation report', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/protocols/evaluation' });
      expect(res.statusCode).toBe(200);
      const report = res.json().report;
      expect(report.noPatientOverlap).toBe(true);
      expect(report.regressionHeads.length).toBeGreaterThanOrEqual(4);
      expect(report.coverage.protocols.length).toBeGreaterThanOrEqual(3);
      expect(report.summary.totalHeads).toBe(report.regressionHeads.length);
      for (const head of report.regressionHeads) {
        expect(head.comparison.head.mae).toBeDefined();
        expect(head.comparison.persistence.mae).toBeDefined();
      }
      expect(report.classificationHeads.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});

describe('F3 config-driven protocol surface', () => {
  it('keeps the registry as the single source of truth for cells, routes and UI', async () => {
    const { RENAL_PROTOCOLS } = await import('../src/protocols/registry.js');
    for (const p of RENAL_PROTOCOLS) {
      expect(p.cells.length).toBeGreaterThan(0);
      expect(p.routes.some((r) => r.includes('/admin/swarm/'))).toBe(true);
      expect(p.ui.route.startsWith('/admin/swarm/')).toBe(true);
      expect(p.inputs.length).toBeGreaterThan(0);
      expect(p.requiredSignals.length).toBeGreaterThan(0);
      expect(p.status).toBe('implemented');
    }
    // the anemia protocol points at its own shipped page; the rest share the cockpit
    expect(RENAL_PROTOCOLS.find((p) => p.id === 'anemia')?.ui.route).toBe('/admin/swarm/anemia/state');
    expect(RENAL_PROTOCOLS.filter((p) => p.ui.route === '/admin/swarm/protocols/cockpit')).toHaveLength(6);
  });
});
