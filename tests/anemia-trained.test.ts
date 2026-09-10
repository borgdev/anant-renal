/******************************************************************************
 * Anemia / ESA trained model — P2 "real trainer under the same contract".
 *
 * Proves (a) NO train/serve drift — the committed feature_catalog.json used by
 * the Python trainer equals the TS anemia.ts catalog; (b) the exported artifact
 * loads and its TS forward pass reproduces the Python golden prediction (no
 * Python needed at test time); (c) the trained model recommends under the SAME
 * EsaRecommendation contract, with the P1 coverage + iron-first gates still
 * blocking; and (d) the /advise?model=trained surface serves it.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import {
  ESA_DOSE_STEP, ESA_FEATURES, HGB_TARGET, esaRecommend, type EsaPatientWindow,
} from '../src/swarm/anemia.js';
import {
  encodeLatent, esaRecommendTrained, loadEsaArtifact, predictEsaDoseUnits, predictEsaBand,
} from '../src/swarm/anemia-model.js';
import type { EsaTrainedArtifact } from '../src/swarm/anemia-model.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const ROOT = resolve(process.cwd());
const catalog = JSON.parse(readFileSync(resolve(ROOT, 'anemia-train/feature_catalog.json'), 'utf8')) as {
  hgbTarget: { min: number; max: number };
  doseStep: number;
  features: Array<{ id: string; label: string; loinc?: string; unit: string; min: number; max: number; relevance: number }>;
};

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

/** Canonical below-band window — mirrors the P0 seed p-esa-1 (surrogate → 10,000). */
const P_ESA_1: EsaPatientWindow = {
  patientId: 'p-esa-1', currentHgb: 9.4, mcv: 92, ferritin: 640, transferrinSat: 28,
  crp: 6, calcium: 9.2, pth: 120, onESA: true, currentDose: 8000,
  hgbTrendLast90d: [8.8, 8.9, 9.0, 9.1, 9.2, 9.4], esaEscalationsLast90d: 1,
  lastIronPanelAt: '2026-08-01T00:00:00Z', asOf: '2026-09-01T00:00:00Z',
};
const withOver = (over: Record<string, unknown>): EsaPatientWindow => ({ ...P_ESA_1, ...over } as EsaPatientWindow);

let artifact: EsaTrainedArtifact | null;

describe('anemia trained model (catalog + artifact + serve)', () => {
  beforeAll(() => { artifact = loadEsaArtifact(); });
  afterAll(() => { artifact = null; });

  it('feature_catalog.json mirrors the TS anemia catalog (no train/serve drift)', () => {
    expect(catalog.features.map((f) => f.id)).toEqual(ESA_FEATURES.map((f) => f.id));
    expect(catalog.hgbTarget).toEqual(HGB_TARGET);
    expect(catalog.doseStep).toBe(ESA_DOSE_STEP);
    for (const f of catalog.features) {
      const ts = ESA_FEATURES.find((x) => x.id === f.id);
      expect(ts).toBeTruthy();
      expect(f.min).toBe(ts?.min);
      expect(f.max).toBe(ts?.max);
      expect(f.unit).toBe(ts?.unit);
      expect(f.relevance).toBe(ts?.relevance);
      if (f.loinc) expect(f.loinc).toBe(ts?.loinc);
      if (ts?.loinc) expect(f.loinc).toBe(ts.loinc);
    }
  });

  it('loads the exported artifact (self-describing layout + weights)', () => {
    expect(artifact).not.toBeNull();
    const a = artifact as EsaTrainedArtifact;
    expect(a.model).toEqual({ id: 'anemia.esa-dose-v1', version: '1.0.0', kind: 'trained' });
    expect(a.vector.inputDim).toBe(20);
    expect(a.golden.vector).toHaveLength(20);
    expect(a.weights.encoder).toHaveLength(3);
    expect(a.weights.regressor).toHaveLength(3);
    expect(a.synthetic).toBe(true);
    expect(a.metrics.testMae).toBeLessThan(2000);
    expect(a.metrics.pearson).toBeGreaterThan(0.9);
    // The band head keys on the decision variable. Under the old magnitude head
    // `priorEpo` dominated because the model was mostly copying the dose on
    // record — which is precisely why it could not beat the persistence
    // baseline. hgb dominating is the head having learned the policy.
    expect(a.relevance[0]?.id).toBe('hgb');
    expect(a.relevance.find((r) => r.id === 'hgb')?.relevance).toBeGreaterThan(0.5);
    expect(a.relevance.find((r) => r.id === 'priorEpo')?.relevance).toBeGreaterThan(0);
  });

  it('beats the persistence baseline and moves only where a clinician would', () => {
    const a = artifact as EsaTrainedArtifact;
    // persistence (hold the dose on record) IS the baseline, so beating it means
    // the head changes the dose correctly more often than it errs
    expect(a.architecture.head).toBe('band-classifier');
    expect(a.metrics.maeGainVsBaseline).toBeGreaterThan(0);
    expect(a.metrics.testMae).toBeLessThan(a.metrics.baselineMae);
    expect(a.metrics.bandAccuracy).toBeGreaterThan(0.9);
    expect(a.metrics.changeRecall).toBeGreaterThan(0.5);
    expect(a.metrics.falseChangeRate).toBeLessThan(0.1);
  });

  it('TS forward is deterministic and reproduces the Python golden prediction', () => {
    const a = artifact as EsaTrainedArtifact;
    const window = a.golden.window as unknown as EsaPatientWindow;
    const p1 = predictEsaDoseUnits(a, window);
    const p2 = predictEsaDoseUnits(a, window);
    expect(p1).toBe(p2); // deterministic load → identical output
    expect(Math.abs(p1 - a.golden.prediction)).toBeLessThanOrEqual(10); // torch ↔ TS parity
    const latent = encodeLatent(a, a.golden.vector);
    expect(Math.abs(latent.l1)).toBeLessThanOrEqual(1);
    expect(Math.abs(latent.l2)).toBeLessThanOrEqual(1);
  });

  it('the trained model recommends an increase on the below-band window (no blind hold)', () => {
    const a = artifact as EsaTrainedArtifact;
    const ref = esaRecommend(P_ESA_1);
    expect(ref.direction).toBe('increase'); // surrogate reference
    const rec = esaRecommendTrained(P_ESA_1, a);
    expect(rec.model.kind).toBe('trained');
    expect(rec.coverage.covered).toBe(true);
    expect(rec.direction).toBe('increase'); // learned the band logic, not a hold
    expect(rec.recommendedDose ?? 0).toBeGreaterThan(P_ESA_1.currentDose);
    expect(Math.abs((rec.recommendedDose ?? 0) - (ref.recommendedDose ?? 0))).toBeLessThanOrEqual(2000);
    // hgb is what the policy decides on, so it leads the drivers
    expect(rec.drivers[0]?.id).toBe('hgb');
    expect(rec.synthetic).toBe(true);
  });

  it('the head chooses the protocol band, and the protocol supplies the step', () => {
    const a = artifact as EsaTrainedArtifact;
    const window = a.golden.window as unknown as EsaPatientWindow;
    const band = predictEsaBand(a, window);
    expect(band?.band).toBe('increase');
    // below-band + 8000 u/wk → the protocol's own +25% step, not an invented dose
    expect(predictEsaDoseUnits(a, window)).toBe(10000);
    // and a hold band returns the dose on record untouched
    const inBand = { ...window, currentHgb: 11.0 };
    expect(predictEsaBand(a, inBand)?.band).toBe('hold');
    expect(predictEsaDoseUnits(a, inBand)).toBe(window.currentDose);
  });

  it('the trained serve still honors the coverage + iron-first gates (P1 contract preserved)', () => {
    const a = artifact as EsaTrainedArtifact;
    const oob = esaRecommendTrained(withOver({ crp: 520 }), a);
    expect(oob.direction).toBe('blocked');
    expect(oob.recommendedDose).toBeNull();
    expect(oob.note).toMatch(/Out of model range/i);

    const micro = esaRecommendTrained(withOver({ mcv: 74 }), a);
    expect(micro.direction).toBe('blocked');
    expect(micro.guardrails.blockReason).toMatch(/Microcytic/i);
  });
});

describe('anemia trained model (routes)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('GET /trained-model exposes the registered artifact metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/trained-model', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.registered).toBe(true);
    expect(body.model).toEqual({ id: 'anemia.esa-dose-v1', version: '1.0.0', kind: 'trained' });
    expect(body.metrics.testMae).toBeGreaterThan(0);
    expect(body.relevance[0]?.id).toBe('hgb');
  });

  it('POST /advise defaults to the reference surrogate; ?model=trained serves the trained model', async () => {
    const ref = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: { ...P_ESA_1 } });
    expect(ref.statusCode).toBe(200);
    expect(ref.json().model).toBe('reference');
    expect(ref.json().recommendation.model.kind).toBe('reference-surrogate');

    const trained = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: { ...P_ESA_1, model: 'trained' } });
    expect(trained.statusCode).toBe(200);
    expect(trained.json().model).toBe('trained');
    const rec = trained.json().recommendation;
    expect(rec.model.kind).toBe('trained');
    expect(rec.model.id).toBe('anemia.esa-dose-v1');
    expect(rec.recommendedDose).toBeGreaterThan(P_ESA_1.currentDose);
  });

  it('unauth /trained-model is blocked (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/trained-model' });
    expect(res.statusCode).toBe(401);
  });
});
