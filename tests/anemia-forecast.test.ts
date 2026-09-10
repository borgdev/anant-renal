/******************************************************************************
 * Anemia / ESA dose what-if + MPC controller (Slice 1/2) — tests.
 *
 * Slice 1 (Zhao et al. 2026): project the weekly Hb path under each candidate
 * dose with a deterministic reference responder (1-week erythropoiesis lag +
 * ~10-week first-order settling toward the dose set-point; iron/resistance
 * modulate the response from the same latent manifold as the P0 surrogate).
 *
 * Slice 2 (Brier & Gaweda 2011): an MPC-style optimizer selects the candidate
 * that maximizes weeks in the 10–12 band with the least intervention, and the
 * recommend contract surfaces that choice (Class C, guardrails + coverage).
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ESA_FORECAST_DEFAULT_HORIZON_WEEKS,
  ESA_RBC_LAG_WEEKS,
  ESA_MAX_WEEKLY_RISE_GD,
  esaCandidateDoses,
  esaForecastSeries,
  esaRecommendMpc,
  esaSetPointHgb,
  esaWhatIf,
  pickMpcCandidate,
} from '../src/swarm/anemia-forecast.js';
import { ESA_DOSE_STEP, HGB_TARGET, type EsaPatientWindow } from '../src/swarm/anemia.js';
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

/** Typical ESA window (neutral labs; iron panel fresh at the review epoch). */
const win = (over: Partial<EsaPatientWindow> = {}): EsaPatientWindow => ({
  patientId: 'p-esa-fc',
  currentHgb: 10.6,
  mcv: 92,
  ferritin: 640,
  transferrinSat: 28,
  crp: 6,
  calcium: 9.2,
  pth: 120,
  onESA: true,
  currentDose: 8000,
  hgbTrendLast90d: [10.1, 10.3, 10.4, 10.6],
  esaEscalationsLast90d: 0,
  lastIronPanelAt: '2026-08-01T00:00:00Z',
  asOf: '2026-09-01T00:00:00Z',
  ...over,
});

describe('ESA dose what-if (Slice 1) + MPC controller (Slice 2)', () => {
  it('builds the candidate dose ladder around the current dose (and initiation doses at zero)', () => {
    expect(esaCandidateDoses({ currentDose: 8000 })).toEqual([0, 4000, 6000, 8000, 10000, 12000]);
    const init = esaCandidateDoses({ currentDose: 0 });
    expect(init[0]).toBe(0);
    expect(init).toEqual([...init].sort((a, b) => a - b));
    expect(init.some((d) => d > 0)).toBe(true);
  });

  it('projects a horizon-long weekly series, waits the erythropoiesis lag, and converges slowly toward the set-point', () => {
    const series = esaForecastSeries(win({ currentHgb: 9.4 }), 8000);
    expect(series).toHaveLength(ESA_FORECAST_DEFAULT_HORIZON_WEEKS);
    // 7-day lag: week 1 does not move yet.
    expect(series[0]?.hgb).toBe(9.4);
    expect(series[1]?.hgb).toBeGreaterThan(9.4);
    // Slow RBC settling (~10-wk tau) → by week 12 still short of the set-point.
    const setPoint = esaSetPointHgb(8000, 0.376, 0.1435);
    const end = series[series.length - 1]?.hgb ?? 0;
    expect(end).toBeGreaterThan(9.4);
    expect(end).toBeLessThan(setPoint);
    // Every point is inside the clamp + band math is consistent.
    for (const p of series) {
      expect(p.hgb).toBeGreaterThanOrEqual(5);
      expect(p.hgb).toBeLessThanOrEqual(14);
      expect(p.inBand).toBe(p.hgb >= HGB_TARGET.min && p.hgb <= HGB_TARGET.max);
    }
    expect(ESA_RBC_LAG_WEEKS).toBe(1);
  });

  it('drives a higher equilibrium with a higher dose (monotone dose response, diminishing returns)', () => {
    const low = esaSetPointHgb(4000, 0.5, 0.5);
    const mid = esaSetPointHgb(8000, 0.5, 0.5);
    const high = esaSetPointHgb(16000, 0.5, 0.5);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
    // Concave / saturating: the second doubling adds less than the first.
    expect(mid - low).toBeGreaterThan(high - mid);
    // Iron-poor / resistant patients need more ESA for the same Hb.
    expect(esaSetPointHgb(8000, 0.2, 0.9)).toBeLessThan(esaSetPointHgb(8000, 0.6, 0.2));
  });

  it('scores candidates with monotone cost and ranks them by the MPC objective (fewest out-of-band weeks first)', () => {
    const result = esaWhatIf(win({ currentHgb: 9.4 }));
    expect(result.blocked).toBe(false);
    expect(result.candidates.length).toBeGreaterThan(3);
    for (const c of result.candidates) {
      expect(c.series).toHaveLength(result.horizonWeeks);
      expect(c.weeksBelow + c.weeksInBand + c.weeksAbove).toBe(result.horizonWeeks);
      expect(c.weeksOutOfBand).toBe(c.weeksBelow + c.weeksAbove);
      expect(c.variabilityGd).toBeGreaterThanOrEqual(0);
      expect(c.rapidRise).toBe(c.maxWeeklyRise > ESA_MAX_WEEKLY_RISE_GD);
    }
    const ascending = [...result.candidates].sort((a, b) => a.dose - b.dose);
    for (let i = 1; i < ascending.length; i++) {
      const prev = ascending[i - 1];
      const cur = ascending[i];
      if (!prev || !cur) continue;
      expect(cur.projectedCostUsd).toBeGreaterThan(prev.projectedCostUsd);
      expect(cur.endHgb).toBeGreaterThanOrEqual(prev.endHgb - 0.01);
    }
    // The MPC pick has no more out-of-band weeks than any other candidate.
    const best = pickMpcCandidate(result.candidates, result.currentDose);
    const minOut = Math.min(...result.candidates.map((c) => c.weeksOutOfBand));
    expect(best.weeksOutOfBand).toBe(minOut);
    expect(result.controller?.chosenIndex).toBe(result.chosenIndex);
  });

  it('holds when the patient is already in band; escalates when below band (with the least intervention)', () => {
    const inBand = esaWhatIf(win({ currentHgb: 10.6 }));
    expect(inBand.blocked).toBe(false);
    const inBandChoice = inBand.candidates[inBand.chosenIndex ?? 0];
    expect(inBandChoice?.weeksOutOfBand).toBe(0);
    expect(inBandChoice?.dose).toBe(8000); // closest-to-current tie-break

    const below = esaWhatIf(win({ currentHgb: 9.4 }));
    const belowChoice = below.candidates[below.chosenIndex ?? 0];
    expect(belowChoice).toBeDefined();
    expect(belowChoice?.dose ?? 0).toBeGreaterThan(8000);
    expect(belowChoice?.endHgb ?? 0).toBeGreaterThan(9.4);
  });

  it('returns an MPC recommendation on the same contract (Class C, guardrails + coverage) and a what-if payload', () => {
    const { recommendation, whatIf } = esaRecommendMpc(win({ currentHgb: 9.4 }));
    expect(recommendation.model.id).toBe('anemia.esa-mpc-v0');
    expect(recommendation.model.kind).toBe('reference-surrogate');
    expect(recommendation.guardrails.blocked).toBe(false);
    expect(recommendation.coverage.covered).toBe(true);
    expect(recommendation.direction).toBe('increase');
    expect(recommendation.recommendedDose ?? 0).toBeGreaterThan(recommendation.currentDose);
    expect(recommendation.delta).toBe((recommendation.recommendedDose ?? 0) - recommendation.currentDose);
    expect((recommendation.recommendedDose ?? 0) % ESA_DOSE_STEP).toBe(0);
    expect(recommendation.note).toContain('Class C');
    expect(whatIf.chosenIndex).toBe(recommendation.recommendedDose === 0 ? whatIf.candidates.findIndex((c) => c.dose === 0) : whatIf.candidates.findIndex((c) => c.dose === recommendation.recommendedDose));
  });

  it('blocks the projection on an iron-first guardrail (stale iron panel) and honours horizon overrides', () => {
    const blocked = esaWhatIf(win({ lastIronPanelAt: '2025-01-01T00:00:00Z' }));
    expect(blocked.blocked).toBe(true);
    expect(blocked.candidates).toHaveLength(0);
    expect(blocked.chosenIndex).toBeNull();
    expect(blocked.blockReason).toContain('Iron panel');
    expect(esaRecommendMpc(win({ lastIronPanelAt: '2025-01-01T00:00:00Z' })).recommendation.direction).toBe('blocked');

    const short = esaWhatIf(win(), { horizonWeeks: 6 });
    expect(short.horizonWeeks).toBe(6);
    expect(short.candidates.every((c) => c.series.length === 6)).toBe(true);
    // Clamped into the supported window.
    expect(esaWhatIf(win(), { horizonWeeks: 1 }).horizonWeeks).toBeGreaterThanOrEqual(4);
  });

  it('says so honestly when even the best dose cannot reach the band (ESA hyporesponse)', () => {
    const resistant = esaWhatIf(win({
      currentHgb: 8.6, currentDose: 2000, mcv: 84, ferritin: 300, transferrinSat: 12,
      crp: 290, pth: 1400, calcium: 12,
    }));
    expect(resistant.blocked).toBe(false);
    const choice = resistant.candidates[resistant.chosenIndex ?? 0];
    expect(choice).toBeDefined();
    if ((choice?.endHgb ?? 0) < HGB_TARGET.min) {
      expect(resistant.note.toLowerCase()).toContain('hyporesponse');
    }
  });
});

describe('ESA dose what-if routes', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('POST /what-if returns the candidates + MPC controller, and validates its body', async () => {
    const ok = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/what-if', headers: { cookie: cookie(admin) },
      payload: { ...win({ currentHgb: 9.4 }), horizonWeeks: 12 },
    });
    expect(ok.statusCode).toBe(200);
    const whatIf = ok.json().whatIf;
    expect(whatIf.blocked).toBe(false);
    expect(whatIf.candidates.length).toBeGreaterThan(3);
    expect(whatIf.chosenIndex).toBeGreaterThanOrEqual(0);
    expect(whatIf.controller.constraints.targetBand).toEqual({ min: 10, max: 12 });
    expect(whatIf.controller.expected.weeksInBand).toBe(whatIf.candidates[whatIf.chosenIndex].weeksInBand);

    const bad = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/what-if', headers: { cookie: cookie(admin) }, payload: { patientId: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /advise model=mpc returns the optimized recommendation plus the trajectory', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) },
      payload: { ...win({ currentHgb: 9.4 }), model: 'mpc' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('mpc');
    expect(body.recommendation.model.id).toBe('anemia.esa-mpc-v0');
    expect(body.recommendation.direction).toBe('increase');
    expect(body.whatIf.candidates.length).toBeGreaterThan(3);
    expect(body.dst).toBeTruthy();
  });
});
