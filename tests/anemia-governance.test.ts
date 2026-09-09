/******************************************************************************
 * Anemia / ESA CDSS governance — P1 "safe by default".
 *
 * Proves the advisor cannot-act-unsafely: the coverage gate blocks out-of-
 * domain / low-density / beyond-manifold windows with a human-readable verdict;
 * rt-013..rt-016 live in the shared red-team suite and their real behavioral
 * probes are contained (surrogate steers adversarial windows to suspend/block);
 * the advisor gate requires interpretability + coverage + no blocking ESA
 * findings + regulatory posture; KS drift snapshots are computed + durable.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import {
  ESA_COVERAGE_DEFAULTS, ESA_MODEL_ID, ESA_RED_TEAM_DEFS,
  computeEsaDrift, deriveEsaAdvisorGate, esaCoverage,
  esaRecommendCovered, esaRedTeamProbe, esaTwoSampleKs,
  ensureEsaModel, ensureEsaRedTeamScenarios, evaluateEsaAdvisorGate, isEsaFinding,
} from '../src/swarm/anemia-governance.js';
import type { EsaPatientWindow } from '../src/swarm/anemia.js';
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

/** Density-rich, in-domain, in-manifold ESA window builder. */
const win = (over: Record<string, unknown>): EsaPatientWindow => ({
  patientId: 'esa-gov-t', currentHgb: 10.6, mcv: 92, ferritin: 640, transferrinSat: 28,
  crp: 6, calcium: 9.2, pth: 120, onESA: true, currentDose: 8000,
  hgbTrendLast90d: [10.1, 10.3, 10.4, 10.5, 10.6, 10.6], esaEscalationsLast90d: 0,
  lastIronPanelAt: '2026-08-01T00:00:00Z', asOf: '2026-09-01T00:00:00Z',
  ...over,
} as EsaPatientWindow);

describe('anemia governance (pure)', () => {
  it('coverage covers an in-band, density-rich, in-manifold window', () => {
    const v = esaCoverage(win({}));
    expect(v.covered).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.labDensity.observed).toBeGreaterThanOrEqual(ESA_COVERAGE_DEFAULTS.minTrendSamples);
    expect(v.manifold.inside).toBe(true);
    expect(v.manifold.distance).toBeGreaterThanOrEqual(0);
  });

  it('coverage blocks a feature outside the trained domain with a human reason', () => {
    const v = esaCoverage(win({ crp: 520 })); // CRP bound is 300 mg/L
    expect(v.covered).toBe(false);
    expect(v.reason).toMatch(/Out of model range/i);
    expect(v.reason).toContain('C-reactive protein');
    expect(v.range?.feature).toBe('crp');
  });

  it('coverage blocks low lab density (insufficient weekly Hb samples)', () => {
    const v = esaCoverage(win({ hgbTrendLast90d: [10.2, 10.5] }));
    expect(v.covered).toBe(false);
    expect(v.reason).toMatch(/Insufficient lab density/i);
    expect(v.labDensity.observed).toBe(2);
  });

  it('coverage blocks a within-domain but beyond-manifold window (restrict to similar populations)', () => {
    const w = win({ mcv: 128, ferritin: 2900, transferrinSat: 75, crp: 250, calcium: 12.5, pth: 1400 });
    const v = esaCoverage(w);
    // All features are inside their trained bounds, but the latent sits far from
    // the reference population → blocked by the manifold radius.
    expect(v.range).toBeUndefined();
    expect(v.manifold.distance).toBeGreaterThan(ESA_COVERAGE_DEFAULTS.maxManifoldDistance);
    expect(v.covered).toBe(false);
    expect(v.reason).toMatch(/Out of reference manifold/i);
  });

  it('advise keeps the underlying recommendation when the coverage gate is disabled (window still flagged)', () => {
    const rec = esaRecommendCovered(win({ currentHgb: 9.4, hgbTrendLast90d: [] }), { coverageGateEnabled: false });
    expect(rec.direction).toBe('increase');          // surrogate's own call
    expect(rec.recommendedDose).toBe(10000);
    expect(rec.coverage?.covered).toBe(false);       // still reported for transparency
  });

  it('advise returns a blocked verdict when the coverage gate blocks (no dose)', () => {
    const rec = esaRecommendCovered(win({ crp: 520 }), { coverageGateEnabled: true });
    expect(rec.direction).toBe('blocked');
    expect(rec.recommendedDose).toBeNull();
    expect(rec.delta).toBe(0);
    expect(rec.coverage?.covered).toBe(false);
    expect(rec.note).toMatch(/Out of model range/i);
  });

  it('gate evaluator: active when all gates pass; blocked on open ESA findings; gated when unregistered', () => {
    const active = evaluateEsaAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 0, posturePresent: true });
    expect(active.status).toBe('active');
    expect(active.gates).toHaveLength(4);

    const blocked = evaluateEsaAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 2, posturePresent: true });
    expect(blocked.status).toBe('blocked');
    expect(blocked.reasons.some((r) => r.startsWith('Red team'))).toBe(true);

    const gated = evaluateEsaAdvisorGate({ registered: false, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 0, posturePresent: true });
    expect(gated.status).toBe('gated');
    expect(gated.reasons.some((r) => r.includes('not registered'))).toBe(true);

    const noCoverage = evaluateEsaAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: false, openFindings: 0, posturePresent: true });
    expect(noCoverage.status).toBe('gated');
    expect(noCoverage.gates.find((g) => g.name === 'Coverage')?.passed).toBe(false);
  });

  it('regulatory posture is part of the gate and marks CDSS / HITL / Class C / never autonomous', () => {
    const gate = evaluateEsaAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 0, posturePresent: true });
    const postureGate = gate.gates.find((g) => g.name === 'Regulatory posture');
    expect(postureGate?.passed).toBe(true);
    expect(gate.posture.posture).toContain('human-in-the-loop');
    expect(gate.posture.approvalClass).toBe('C');
    expect(gate.posture.autonomy).toBe('never-autonomous');
    expect(gate.posture.aiActRiskClass).toBe('high-risk-cdss');
  });

  it('rt-013..rt-016 defs exist with policy-flippable checks', () => {
    expect(ESA_RED_TEAM_DEFS.map((d) => d.id)).toEqual(['rt-013', 'rt-014', 'rt-015', 'rt-016']);
    for (const d of ESA_RED_TEAM_DEFS) {
      expect(d.threatModel).toBeTruthy();
      expect(d.checks.some((c) => c.name.toLowerCase().includes('deny') || c.name.toLowerCase().includes('external write'))).toBe(true);
    }
  });

  it('real behavioral probes are contained — the guarded advisor never misbehaves on adversarial windows', () => {
    for (const def of ESA_RED_TEAM_DEFS) {
      const probe = esaRedTeamProbe(def);
      expect(probe.passed, `${def.id} should be contained (got ${probe.checks[0]?.observed})`).toBe(true);
    }
  });

  it('two-sample KS is deterministic, 0 for identical distributions, >0 for a shift', () => {
    const base = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4];
    expect(esaTwoSampleKs(base, [...base])).toBe(0);
    const shifted = base.map((v) => Number((v + 1.5).toFixed(1)));
    const ks = esaTwoSampleKs(base, shifted);
    expect(ks).toBeGreaterThan(0.5);
    expect(esaTwoSampleKs(base, shifted)).toBe(esaTwoSampleKs(base, shifted));
  });

  it('computeEsaDrift maps KS to basis points + status', () => {
    const base = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4, 11.5];
    const current = base.map((v) => Number((v + 0.2).toFixed(1)));
    const s = computeEsaDrift({ baseline: base, current, metric: 'hgb-distribution-ks' });
    expect(s.targetId).toBe(ESA_MODEL_ID);
    expect(s.status).toBe('healthy'); // tiny shift
    expect(s.valueBasisPoints).toBe(Math.round(s.ksStatistic * 10000));
  });
});

describe('anemia governance (durable store)', () => {
  it('ensure seeds the shared baseline + rt-013..rt-016 and registers the ESA model idempotently', async () => {
    const s = new SwarmWorkspaceStore();
    const scenarios = await s.seedRedTeamScenarios();
    expect(scenarios).toHaveLength(16);
    for (const id of ['rt-013', 'rt-014', 'rt-015', 'rt-016']) {
      expect(await s.get('red-team-scenario', id)).toBeTruthy();
    }
    expect(await ensureEsaRedTeamScenarios(s)).toBe(0); // already present
    expect(await ensureEsaModel(s)).toBe(true);
    expect(await ensureEsaModel(s)).toBe(false); // idempotent
    const models = await s.listModels();
    expect(models.some((m) => m.modelId === ESA_MODEL_ID)).toBe(true);
  });

  it('deriveEsaAdvisorGate is active under block policy; blocked once an ESA finding opens', async () => {
    const s = new SwarmWorkspaceStore();
    await ensureEsaRedTeamScenarios(s);
    await ensureEsaModel(s);
    expect((await deriveEsaAdvisorGate(s)).status).toBe('active');

    const f = await s.createFinding({
      severity: 'high',
      title: 'Red-team failure: ESA out-of-manifold extrapolation',
      description: 'ESA scenario failed under unsafe policy.',
      threatModel: 'esa-out-of-manifold',
      scenarioId: 'rt-014',
      runId: 'run-x',
      expectedControl: 'Coverage gate',
      observed: 'default deny: runtime policy is allow',
      evidenceHash: 'aa',
    });
    expect(isEsaFinding(f)).toBe(true);
    expect((await deriveEsaAdvisorGate(s)).status).toBe('blocked');

    // §20.2 workflow closes it → gate re-activates (findings are never deleted).
    await s.advanceFinding(f.id, { retest: { runId: 'run-retest', passed: true } });
    await s.advanceFinding(f.id, { review: { reviewer: 'tester', acceptClosure: true } });
    expect((await deriveEsaAdvisorGate(s)).status).toBe('active');
  });

  it('an unsafe (allow) policy makes the ESA scenarios fail in the shared suite and block the gate', async () => {
    const s = new SwarmWorkspaceStore();
    await ensureEsaRedTeamScenarios(s);
    await ensureEsaModel(s);
    await s.saveAdminPolicy({ defaultDecision: 'allow' });
    const suite = await s.runRedTeamSuite({ ranBy: 'test-esa' });
    const esaFailures = suite.runs.filter((r) => (['rt-013', 'rt-014', 'rt-015', 'rt-016'] as string[]).includes(r.scenarioId) && !r.passed);
    expect(esaFailures.length).toBe(4);
    expect((await deriveEsaAdvisorGate(s)).status).toBe('blocked');
  });
});

describe('anemia governance (routes)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
    // Deterministic baseline: default-deny so the advisor gate is active.
    await app.inject({ method: 'PUT', url: '/admin/swarm/admin/policy', headers: { cookie: cookie(admin) }, payload: { defaultDecision: 'block', externalWritesEnabled: false } });
  });
  afterAll(async () => {
    await app.inject({ method: 'PUT', url: '/admin/swarm/admin/policy', headers: { cookie: cookie(admin) }, payload: { defaultDecision: 'block', externalWritesEnabled: false } });
    await app.close();
  });

  it('assurance dashboard shows coverage config, advisor gate, red-team + drift + posture', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/assurance', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.model.registered).toBe(true);
    expect(a.coverage.enabled).toBe(true);
    expect(a.gate.gates.map((g: { name: string }) => g.name)).toEqual(['Interpretability', 'Coverage', 'Red team', 'Regulatory posture']);
    expect(a.redTeam.scenarios).toHaveLength(4);
    expect(a.posture.posture).toContain('human-in-the-loop');
    // rt-013..rt-016 are part of the shared red-team scenario catalog now.
    const scenarios = await app.inject({ method: 'GET', url: '/admin/swarm/red-team/scenarios', headers: { cookie: cookie(admin) } });
    expect(scenarios.statusCode, `scenarios endpoint failed: ${scenarios.body}`).toBe(200);
    const ids = scenarios.json().scenarios.map((s: { id: string }) => s.id);
    for (const id of ['rt-013', 'rt-014', 'rt-015', 'rt-016']) expect(ids).toContain(id);
  });

  it('advise returns a coverage-blocked verdict for out-of-domain and low-density windows', async () => {
    const oob = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: win({ crp: 520 }) });
    const rec = oob.json().recommendation;
    expect(rec.direction).toBe('blocked');
    expect(rec.recommendedDose).toBeNull();
    expect(rec.coverage.covered).toBe(false);
    expect(rec.coverage.reason).toMatch(/Out of model range/i);

    const lowDensity = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: win({ hgbTrendLast90d: [] }) });
    expect(lowDensity.json().recommendation.coverage.reason).toMatch(/Insufficient lab density/i);
    expect(lowDensity.json().recommendation.recommendedDose).toBeNull();
  });

  it('red-team endpoint passes under default-deny (no findings) and the gate stays active', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/red-team', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(4);
    expect(body.findings).toHaveLength(0);
    expect(body.passed).toBe(true);
    const assurance = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/assurance', headers: { cookie: cookie(admin) } });
    expect(assurance.json().gate.status).toBe('active');
  });

  it('drift endpoint writes a durable KS snapshot for the ESA model', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/drift', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshot.status).toBe('healthy');
    expect(body.snapshot.metric).toBe('hgb-distribution-ks');
    const all = await app.inject({ method: 'GET', url: '/admin/swarm/drift', headers: { cookie: cookie(admin) } });
    expect(all.json().drift.some((d: { targetId: string }) => d.targetId === ESA_MODEL_ID)).toBe(true);
  });

  it('unauth /admin/swarm/anemia/assurance is blocked (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/assurance' });
    expect(res.statusCode).toBe(401);
  });
});
