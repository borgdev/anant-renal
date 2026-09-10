/******************************************************************************
 * ESA responsiveness phenotype (Slice 5, Paper B) — tests.
 *
 * Brier & Gaweda stratify ESA hyporesponse with a biomarker panel; this domain
 * classifies the same clinical buckets from routine-lab surrogates (ferritin /
 * TSAT / MCV / CRP + escalation history): functional iron deficiency,
 * inflammatory resistance, refractory, responsive, or insufficient data — and
 * returns the recommended workup without ever ordering.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ESA_PHENOTYPE_CATALOG,
  esaResponsiveness,
  type EsaPhenotype,
} from '../src/swarm/anemia-phenotype.js';
import type { EsaPatientWindow } from '../src/swarm/anemia.js';
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

type App = Awaited<ReturnType<typeof build>>;
async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

/** Neutral, responsive baseline window (fresh iron panel, stable trend). */
const win = (over: Partial<EsaPatientWindow> = {}): EsaPatientWindow => ({
  patientId: 'p-esa-ph',
  currentHgb: 10.8,
  mcv: 92,
  ferritin: 640,
  transferrinSat: 28,
  crp: 6,
  calcium: 9.2,
  pth: 120,
  onESA: true,
  currentDose: 8000,
  hgbTrendLast90d: [10.4, 10.5, 10.6, 10.8],
  esaEscalationsLast90d: 0,
  lastIronPanelAt: '2026-08-01T00:00:00Z',
  asOf: '2026-09-01T00:00:00Z',
  ...over,
});

describe('ESA responsiveness phenotype (Slice 5 / Paper B)', () => {
  it('classifies a stable, iron-replete patient as responsive with a low-risk workup', () => {
    const readout = esaResponsiveness(win());
    expect(readout.phenotype).toBe('responsive');
    expect(readout.label).toBe('Responsive');
    expect(readout.markers.inflammatory).toBe(false);
    expect(readout.markers.escalationWithoutResponse).toBe(false);
    expect(readout.markers.doseIntensity).toBe('moderate');
    expect(readout.workup.length).toBeGreaterThan(0);
    expect(['moderate', 'high']).toContain(readout.confidence);
  });

  it('detects functional iron deficiency (stores present, TSAT < 20%)', () => {
    const readout = esaResponsiveness(win({ ferritin: 300, transferrinSat: 14 }));
    expect(readout.phenotype).toBe('functional-iron-deficiency');
    expect(readout.markers.functionalIronDeficiency).toBe(true);
    expect(readout.reasons.join(' ')).toContain('functional iron deficiency');
    expect(readout.workup.join(' ')).toContain('IV iron');
  });

  it('detects microcytic iron-first presentations', () => {
    const readout = esaResponsiveness(win({ mcv: 74 }));
    expect(readout.phenotype).toBe('functional-iron-deficiency');
    expect(readout.markers.lowMcv).toBe(true);
    expect(readout.reasons.join(' ')).toContain('microcytic');
  });

  it('detects inflammatory resistance from CRP / the latent resistance axis', () => {
    const readout = esaResponsiveness(win({ crp: 42, currentHgb: 9.6, hgbTrendLast90d: [9.7, 9.6, 9.5, 9.4] }));
    expect(['inflammatory-resistance', 'refractory']).toContain(readout.phenotype);
    expect(readout.markers.inflammatory).toBe(true);
    expect(readout.reasons.join(' ').toLowerCase()).toContain('crp');
  });

  it('detects refractory hyporesponse (escalating high dose, no Hb rise, inflamed)', () => {
    const readout = esaResponsiveness(win({
      currentHgb: 9.2,
      currentDose: 14000,
      esaEscalationsLast90d: 3,
      hgbTrendLast90d: [9.3, 9.25, 9.2, 9.15],
      crp: 38,
      ferritin: 220,
      transferrinSat: 16,
    }));
    expect(readout.phenotype).toBe('refractory');
    expect(readout.markers.escalationWithoutResponse).toBe(true);
    expect(readout.markers.highDose).toBe(true);
    expect(readout.workup.join(' ').toLowerCase()).toContain('hyporesponse');
    expect(readout.note).toContain('Refractory');
  });

  it('returns insufficient-data (never guesses) on a thin window, and the catalog covers all buckets', () => {
    const readout = esaResponsiveness(win({ hgbTrendLast90d: [10.2], currentDose: 0, onESA: false }));
    expect(readout.phenotype).toBe('insufficient-data');
    expect(readout.confidence).toBe('low');
    expect(readout.note).toContain('Not enough weekly Hb history');
    const ids = ESA_PHENOTYPE_CATALOG.map((p) => p.id);
    for (const expected of ['responsive', 'functional-iron-deficiency', 'inflammatory-resistance', 'refractory', 'insufficient-data'] as EsaPhenotype[]) {
      expect(ids).toContain(expected);
    }
  });
});

describe('ESA phenotype route + advise enrichment', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('POST /phenotype returns the readout + catalog and validates the body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/phenotype', headers: { cookie: cookie(admin) },
      payload: win({ ferritin: 300, transferrinSat: 14 }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phenotype.phenotype).toBe('functional-iron-deficiency');
    expect(body.catalog.map((p: { id: string }) => p.id)).toContain('refractory');

    const bad = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/phenotype', headers: { cookie: cookie(admin) }, payload: { patientId: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('enriches every /advise response with the phenotype', async () => {
    for (const model of ['reference', 'mpc'] as const) {
      const res = await app.inject({
        method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) },
        payload: { ...win({ crp: 40, currentHgb: 9.6 }), model },
      });
      expect(res.statusCode).toBe(200);
      const rec = res.json().recommendation;
      expect(rec.phenotype).toBeTruthy();
      expect(typeof rec.phenotype.label).toBe('string');
      expect(Array.isArray(rec.phenotype.reasons)).toBe(true);
    }
  });
});
