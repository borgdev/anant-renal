/******************************************************************************
 * Anemia / ESA PK exposure (Slice 3, Paper A) — tests.
 *
 * Zhao et al. model ESA response from CUMULATIVE, TIME-WEIGHTED exposure
 * (130 h half-life) plus a 14-day IV-iron term — not the last ordered dose.
 * Proves the decay math, the effective-weekly-dose / intensity derivation, the
 * graceful fallback when no history is supplied, and the HTTP surface.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ESA_DEFAULT_INTERVAL_DAYS,
  ESA_EXPOSURE_CATALOG,
  ESA_HALF_LIFE_HOURS,
  esaDecayWeight,
  esaEffectiveWeeklyDose,
  esaExposure,
  esaSteadyStateFactor,
} from '../src/swarm/anemia-exposure.js';
import { esaWhatIf } from '../src/swarm/anemia-forecast.js';
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

const AS_OF = '2026-09-01T00:00:00Z';
/** ISO timestamp `days` before the fixed asOf epoch. */
const ago = (days: number): string => new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString();

const win = (over: Partial<EsaPatientWindow> = {}): EsaPatientWindow => ({
  patientId: 'p-esa-pk',
  currentHgb: 9.6,
  mcv: 92,
  ferritin: 640,
  transferrinSat: 28,
  crp: 6,
  calcium: 9.2,
  pth: 120,
  onESA: true,
  currentDose: 8000,
  hgbTrendLast90d: [9.0, 9.2, 9.4, 9.6],
  esaEscalationsLast90d: 0,
  lastIronPanelAt: '2026-08-01T00:00:00Z',
  asOf: AS_OF,
  ...over,
});

/** Weekly dosing history for `weeks` doses ending today at `dose` u/wk. */
const weekly = (weeks: number, dose = 8000) => Array.from({ length: weeks }, (_, i) => ({ at: ago(i * 7), dose }));

describe('ESA PK exposure (Slice 3 / Paper A)', () => {
  it('decays by exactly half at one half-life (130 h) and is monotone in age', () => {
    expect(ESA_HALF_LIFE_HOURS).toBe(130);
    expect(esaDecayWeight(0)).toBeCloseTo(1, 6);
    expect(esaDecayWeight(130)).toBeCloseTo(0.5, 6);
    expect(esaDecayWeight(260)).toBeCloseTo(0.25, 6);
    expect(esaDecayWeight(65)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(esaDecayWeight(40)).toBeGreaterThan(esaDecayWeight(80));
    expect(esaDecayWeight(-5)).toBe(0);
    // Steady-state factor for a 7-day cadence (1 / (1 − 0.5^(168/130))).
    expect(esaSteadyStateFactor(7)).toBeCloseTo(1 / (1 - 2 ** (-168 / 130)), 6);
  });

  it('falls back to the nominal window dose when no dosing history is supplied (basis: window)', () => {
    const readout = esaExposure(win());
    expect(readout.basis).toBe('window');
    expect(readout.administrations).toBe(0);
    expect(readout.nominalWeeklyDose).toBe(8000);
    expect(readout.effectiveWeeklyDose).toBe(8000);
    expect(readout.exposureIntensity).toBe(1);
    expect(readout.decayedActivity).toBe(0);
    expect(readout.daysSinceLastDose).toBeNull();
    expect(readout.intervalDays).toBe(ESA_DEFAULT_INTERVAL_DAYS);
    expect(readout.features).toHaveLength(ESA_EXPOSURE_CATALOG.length);
    expect(esaEffectiveWeeklyDose(win())).toBe(8000);
  });

  it('reports steady-state intensity ≈ 1 for an established weekly regimen, and tracks exposure terms', () => {
    const readout = esaExposure(win({ esaDosingHistory: weekly(13) }));
    expect(readout.basis).toBe('history');
    expect(readout.administrations).toBe(13);
    expect(readout.exposureIntensity).toBeGreaterThan(0.95);
    expect(readout.exposureIntensity).toBeLessThanOrEqual(1.01);
    expect(readout.effectiveWeeklyDose).toBeGreaterThan(7500);
    expect(readout.effectiveWeeklyDose).toBeLessThanOrEqual(8000);
    // Cumulative is 13 × 8000 and decayed activity is strictly smaller.
    expect(readout.cumulativeDose90d).toBe(104000);
    expect(readout.decayedActivity).toBeLessThan(readout.cumulativeDose90d);
    expect(readout.timeWeightedExposure90d).toBe(readout.decayedActivity);
    expect(readout.doseTimeProduct).toBeGreaterThan(0);
    expect(readout.daysSinceLastDose).toBe(0);
  });

  it('drops the effective dose when the regimen has lapsed (a gap decays the exposure)', () => {
    const steady = esaExposure(win({ esaDosingHistory: weekly(13) }));
    const lapsed = esaExposure(win({ esaDosingHistory: [21, 42, 63, 84].map((d) => ({ at: ago(d), dose: 8000 })) }));
    expect(lapsed.exposureIntensity).toBeLessThan(steady.exposureIntensity);
    expect(lapsed.effectiveWeeklyDose).toBeLessThan(steady.effectiveWeeklyDose);
    expect(lapsed.daysSinceLastDose).toBe(21);
    // A single dose long ago decays to almost nothing.
    const stale = esaExposure(win({ esaDosingHistory: [{ at: ago(80), dose: 8000 }] }));
    expect(stale.exposureIntensity).toBeLessThan(0.02);
    expect(stale.effectiveWeeklyDose).toBeLessThan(500);
  });

  it('integrates the 14-day IV-iron window and ignores older iron', () => {
    const readout = esaExposure(win({
      esaDosingHistory: weekly(6),
      ivIronHistory: [
        { at: ago(3), mg: 100 },
        { at: ago(10), mg: 125 },
        { at: ago(30), mg: 250 },
      ],
    }));
    expect(readout.cumulativeIron14d).toBe(225);
    expect(esaExposure(win({ ivIronHistory: [{ at: ago(30), mg: 250 }] })).cumulativeIron14d).toBe(0);
  });

  it('uses the decayed effective dose for the hold candidate in the what-if (a lapsed dose projects Hb falling)', () => {
    const base = win({ currentHgb: 10.6, esaDosingHistory: weekly(13) });
    const steady = esaWhatIf(base);
    const lapsed = esaWhatIf(win({ currentHgb: 10.6, esaDosingHistory: [21, 49, 77].map((d) => ({ at: ago(d), dose: 8000 })) }));
    const holdDose = 8000;
    const steadyHold = steady.candidates.find((c) => c.dose === holdDose);
    const lapsedHold = lapsed.candidates.find((c) => c.dose === holdDose);
    expect(steadyHold).toBeDefined();
    expect(lapsedHold).toBeDefined();
    expect(steady.exposure.effectiveWeeklyDose).toBeGreaterThan(lapsed.exposure.effectiveWeeklyDose);
    expect(steadyHold?.endHgb ?? 0).toBeGreaterThan(lapsedHold?.endHgb ?? 0);
    expect(lapsed.exposure.basis).toBe('history');
  });
});

describe('ESA PK exposure route', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('POST /exposure returns the readout + catalog and validates the body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/exposure', headers: { cookie: cookie(admin) },
      payload: { ...win({ esaDosingHistory: weekly(13) }), ivIronHistory: [{ at: ago(2), mg: 100 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exposure.basis).toBe('history');
    expect(body.exposure.administrations).toBe(13);
    expect(body.exposure.cumulativeIron14d).toBe(100);
    expect(body.catalog.map((f: { id: string }) => f.id)).toContain('effectiveWeeklyDose');

    const bad = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/exposure', headers: { cookie: cookie(admin) }, payload: { patientId: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('exposes the exposure catalog on /features and enriches /advise', async () => {
    const feat = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/features', headers: { cookie: cookie(admin) } });
    expect(feat.statusCode).toBe(200);
    expect(feat.json().exposureFeatures.map((f: { id: string }) => f.id)).toContain('timeWeightedExposure90d');

    const advise = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) },
      payload: win({ esaDosingHistory: weekly(13) }),
    });
    expect(advise.statusCode).toBe(200);
    const rec = advise.json().recommendation;
    expect(rec.exposure.basis).toBe('history');
    expect(rec.exposure.administrations).toBe(13);
    expect(rec.exposure.effectiveWeeklyDose).toBeGreaterThan(0);
  });
});

