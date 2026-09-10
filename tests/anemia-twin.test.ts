/******************************************************************************
 * Anemia / ESA patient twin + online drift (Slice 4, Paper A) — tests.
 *
 * Proves the twin derives a governed ESA window from REAL ledger events
 * (attribution by patientId or the reducer's `<patientId>-<code>-<seq>` order
 * id), falls back to patient state, and scores the reference responder ONLINE
 * (forecast vs observed weekly Hb: MAE / MAPE / RMSE, Paper-A < 10% bar).
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  attributePatientId,
  buildEsaTwin,
  ESA_TWIN_DRIFT_TARGET_MAPE_PCT,
  scoreEsaTwinDrift,
  toWeeklySeries,
  type EsaTwinEventInput,
} from '../src/swarm/anemia-twin.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore() {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

const AS_OF = '2026-09-01T00:00:00Z';
const ago = (days: number): string => new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString();

const PID = 'f1-pt-0001';

/** A lab result event in the reducer's shape (no patientId — attribution by order id). */
const lab = (code: string, value: number, daysAgo: number, seq: number): EsaTwinEventInput => ({
  realmId: 'sim:renal-a',
  eventId: `ev-${code}-${seq}`,
  kind: 'result-lab',
  emittedAt: ago(daysAgo),
  payload: { orderId: `${PID}-${code}-${seq}`, code, value, unit: code === 'HGB' ? 'g/dL' : 'unit' },
});

const order = (dose: number, daysAgo: number, seq: number): EsaTwinEventInput => ({
  realmId: 'sim:renal-a',
  eventId: `ev-med-${seq}`,
  kind: 'order-med',
  emittedAt: ago(daysAgo),
  payload: { patientId: PID, code: 'epoetin-alfa', dose, route: 'IV', frequency: 'weekly', indication: 'anemia' },
});

/** A weekly Hb series + weekly ESA orders derived from a simple trajectory. */
function ledgerFixture(): EsaTwinEventInput[] {
  const events: EsaTwinEventInput[] = [];
  // 12 weekly Hb results, drifting 9.0 → 10.4, plus an iron panel 2 days ago.
  const hb = [9.0, 9.1, 9.2, 9.3, 9.5, 9.6, 9.8, 9.9, 10.1, 10.2, 10.3, 10.4];
  hb.forEach((value, i) => events.push(lab('HGB', value, (11 - i) * 7, i + 1)));
  events.push(lab('FERRITIN', 640, 2, 90));
  events.push(lab('TSAT', 28, 2, 91));
  // Weekly ESA orders (one per week) at a stable dose.
  for (let i = 0; i < 12; i++) events.push(order(8000, i * 7, i + 1));
  return events;
}

type App = Awaited<ReturnType<typeof build>>;
async function build(events: EsaTwinEventInput[] = [], patients: ReturnType<typeof patientsFixture> = []) {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
    anemiaEvents: () => events,
    anemiaPatients: () => patients,
  });
}

function patientsFixture() {
  return [{
    realmId: 'sim:renal-a',
    patientId: PID,
    state: {
      trajectory: 'anemic-recovering',
      labs: { K: 4.4, HGB: 10.4, URR: 69, PHOS: 4.9 },
      esaDose: 8000,
      esaEscalationsLast90d: 1,
      esaDosingHistory: [{ at: ago(0), dose: 8000 }, { at: ago(7), dose: 8000 }],
    },
  }];
}

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

describe('ESA patient twin (Slice 4 / Paper A)', () => {
  it('attributes an event by explicit patientId or by the order-id prefix', () => {
    expect(attributePatientId({ kind: 'order-med', emittedAt: AS_OF, payload: { patientId: 'p-9' } }, [])).toBe('p-9');
    expect(attributePatientId(lab('HGB', 10, 1, 1), [PID])).toBe(PID);
    // Longest id wins when ids share prefixes.
    const longerId = `${PID}-x`;
    const longerEvent: EsaTwinEventInput = { kind: 'result-lab', emittedAt: AS_OF, payload: { orderId: `${longerId}-HGB-9`, code: 'HGB', value: 10 } };
    expect(attributePatientId(longerEvent, [longerId, PID])).toBe(longerId);
    expect(attributePatientId(lab('HGB', 10, 1, 1), [])).toBeUndefined();
  });

  it('collapses frequent observations to one value per week bucket', () => {
    const obs = [
      { at: ago(0), hgb: 10.4 }, { at: ago(2), hgb: 10.2 }, { at: ago(7), hgb: 9.9 }, { at: ago(9), hgb: 9.8 },
    ];
    const weekly = toWeeklySeries(obs, Date.parse(AS_OF));
    expect(weekly).toHaveLength(2);
    // Chronological (oldest → newest) so the drift walk compares prev → cur.
    expect(weekly[0]?.hgb).toBe(9.9);
    expect(weekly[1]?.hgb).toBe(10.4);
  });

  it('derives a governed window from the real ledger (ledger hgb + dose + iron panel)', () => {
    const twin = buildEsaTwin({ patientId: PID, events: ledgerFixture(), patients: patientsFixture(), asOf: AS_OF });
    expect(twin.window).not.toBeNull();
    expect(twin.provenance.derivedFrom).toBe('ledger');
    expect(twin.provenance.hgbLabs).toBe(12);
    expect(twin.provenance.esaDoses).toBe(12);
    expect(twin.provenance.doseSource).toBe('ledger');
    expect(twin.provenance.ironLabs).toBe(2);
    expect(twin.hgbSeries).toHaveLength(12);
    const w = twin.window!;
    expect(w.currentHgb).toBe(10.4);
    expect(w.currentDose).toBe(8000);
    expect(w.onESA).toBe(true);
    expect(w.ferritin).toBe(640);
    expect(w.transferrinSat).toBe(28);
    expect(w.lastIronPanelAt).toBeDefined();
    expect(w.hgbTrendLast90d.length).toBeGreaterThan(3);
    expect(w.esaDosingHistory?.length).toBe(12);
    expect(w.esaEscalationsLast90d).toBe(1); // patient state is authoritative (fixture records 1)
  });

  it('falls back to patient state when the ledger is thin, and reports insufficient without Hb', () => {
    const stateOnly = buildEsaTwin({ patientId: PID, events: [], patients: patientsFixture(), asOf: AS_OF });
    expect(stateOnly.window).not.toBeNull();
    expect(stateOnly.provenance.derivedFrom).toBe('patient-state');
    expect(stateOnly.provenance.doseSource).toBe('patient-state');
    expect(stateOnly.window?.currentDose).toBe(8000);
    expect(stateOnly.window?.currentHgb).toBe(10.4);

    const nothing = buildEsaTwin({ patientId: 'nobody', events: [], patients: [], asOf: AS_OF });
    expect(nothing.window).toBeNull();
    expect(nothing.provenance.derivedFrom).toBe('insufficient');
    expect(nothing.note).toContain('cannot build');
  });

  it('scores the responder ONLINE against observed Hb (MAE / MAPE / RMSE vs the <10% bar)', () => {
    const twin = buildEsaTwin({ patientId: PID, events: ledgerFixture(), patients: patientsFixture(), asOf: AS_OF });
    const drift = scoreEsaTwinDrift(twin);
    expect(ESA_TWIN_DRIFT_TARGET_MAPE_PCT).toBe(10);
    expect(drift.n).toBeGreaterThanOrEqual(8);
    expect(drift.rows.length).toBeGreaterThanOrEqual(8);
    expect(drift.mape).toBeGreaterThanOrEqual(0);
    expect(drift.rmse).toBeGreaterThanOrEqual(drift.mae - 0.001);
    expect(['pass', 'watch']).toContain(drift.verdict);
    // Every row carries an observed + predicted pair with the error consistent.
    for (const row of drift.rows) {
      expect(row.predicted).toBeGreaterThan(0);
      expect(row.observed).toBeGreaterThan(0);
      expect(row.error).toBeCloseTo(row.predicted - row.observed, 2);
      expect(row.pctError).toBeGreaterThanOrEqual(0);
    }
    expect(drift.note).toContain('MAPE');
  });

  it('reports insufficient drift with a single observation', () => {
    const twin = buildEsaTwin({ patientId: PID, events: [lab('HGB', 10.1, 1, 1), order(8000, 1, 1)], patients: [], asOf: AS_OF });
    const drift = scoreEsaTwinDrift(twin);
    expect(drift.n).toBe(0);
    expect(drift.verdict).toBe('insufficient');
  });
});

describe('ESA patient twin routes', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build(ledgerFixture(), patientsFixture());
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('POST /twin builds from the ledger and returns drift + what-if; /twin/score persists', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/twin', headers: { cookie: cookie(admin) },
      payload: { patientId: PID, persist: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.twin.provenance.derivedFrom).toBe('ledger');
    expect(body.twin.window.currentDose).toBe(8000);
    expect(body.whatIf.candidates.length).toBeGreaterThan(3);
    expect(body.drift.n).toBeGreaterThanOrEqual(8);
    expect(body.persisted).toBe(true);

    const missing = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/twin', headers: { cookie: cookie(admin) }, payload: {} });
    expect(missing.statusCode).toBe(400);

    const scored = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/twin/score', headers: { cookie: cookie(admin) },
      payload: { patientId: PID },
    });
    expect(scored.statusCode).toBe(200);
    expect(scored.json().drift.n).toBeGreaterThanOrEqual(8);
    expect(scored.json().provenance.doseSource).toBe('ledger');

    const durable = await app.inject({ method: 'GET', url: `/admin/swarm/anemia/twin/drift?patientId=${PID}`, headers: { cookie: cookie(admin) } });
    expect(durable.statusCode).toBe(200);
    const rows = durable.json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`esa-twin-drift:${PID}`);
    expect(rows[0].score.n).toBeGreaterThanOrEqual(8);
  });

  it('returns a null what-if (honest note) when the ledger yields no window', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/twin', headers: { cookie: cookie(admin) },
      payload: { patientId: 'no-such-patient' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.twin.window).toBeNull();
    expect(body.whatIf).toBeNull();
    expect(body.drift.verdict).toBe('insufficient');
  });
});
