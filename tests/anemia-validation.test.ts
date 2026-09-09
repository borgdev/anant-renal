/******************************************************************************
 * Anemia / ESA external validation & regulatory readiness — P3.
 *
 * Proves the path to a validated, deployable CDSS on synthetic data:
 * deterministic external (site-B) cohort + protocol metrics (MAE, % within one
 * dose step, error quartiles, Spearman, Hb-forecast MAE%), a durable validation
 * report the assurance/gates consume, study-mode clinician-acceptance recording
 * ("suggest, don't auto-act"), and the MDR / EU-AI-Act technical file.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { loadEsaArtifact, predictEsaDoseUnits, type EsaTrainedArtifact } from '../src/swarm/anemia-model.js';
import {
  ESA_VALIDATION_PASS, clinicianDecision, computeEsaValidationMetrics,
  ensureEsaMdrFile, esaAcceptanceStats, generateExternalCohort, getEsaMdrFile,
  getEsaValidationReport, recordEsaStudyDecision, runEsaValidation,
  validateReportVerdict,
} from '../src/swarm/anemia-validation.js';
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

let artifact: EsaTrainedArtifact;

describe('anemia P3 (validation + study + MDR)', () => {
  beforeAll(() => {
    const a = loadEsaArtifact();
    if (!a) throw new Error('esa trained artifact missing');
    artifact = a;
  });

  it('generates a deterministic external (site-B) cohort within domain', () => {
    const a = generateExternalCohort(20260909, 160);
    const b = generateExternalCohort(20260909, 160);
    expect(a).toHaveLength(160);
    expect(a[0]?.patientId).toBe('esa-siteB-001');
    expect(a[0]?.currentHgb).toBe(b[0]?.currentHgb); // deterministic
    for (const r of a) {
      expect(r.mcv).toBeGreaterThanOrEqual(80);
      expect(r.mcv).toBeLessThanOrEqual(105);
      expect(r.hgbTrendLast90d).toHaveLength(12);
    }
  });

  it('clinician decisions follow the KDIGO reference policy', () => {
    const base = { hgbTrendLast90d: [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4, 11.5, 11.6, 11.7, 11.8], onESA: true, currentDose: 8000 };
    expect(clinicianDecision({ ...base, currentHgb: 9.4 })).toBe(10000); // below band → +25%
    expect(clinicianDecision({ ...base, currentHgb: 11.0 })).toBe(8000); // in band → hold
    expect(clinicianDecision({ ...base, currentHgb: 12.4, hgbTrendLast90d: [9.0, 9.4, 10.0, 10.6, 11.2, 12.4] })).toBe(0); // rising above band → suspend
    expect(clinicianDecision({ ...base, onESA: false, currentHgb: 11.0 })).toBe(0); // not on ESA in band
  });

  it('external validation metrics pass the protocol thresholds (trained model)', () => {
    const rows = generateExternalCohort(20260909, 160);
    const modelDoses = rows.map((r) => predictEsaDoseUnits(artifact, r));
    const m = computeEsaValidationMetrics('site-B', rows, modelDoses);
    expect(m.n).toBe(160);
    expect(m.siteId).toBe('site-B');
    expect(m.errorQuartiles.q1).toBeGreaterThanOrEqual(0);
    const v = validateReportVerdict(m);
    expect(v.passed).toBe(true);
    expect(m.maeUnits).toBeLessThan(1000);
    expect(m.withinOneStepPct).toBeGreaterThan(ESA_VALIDATION_PASS.withinOneStepMin * 100);
    expect(m.spearman).toBeGreaterThan(0.9);
    expect(m.hbForecastMaePct).toBeLessThan(ESA_VALIDATION_PASS.hbForecastMaxPct);
  });

  it('runEsaValidation produces a durable, deterministic, passing report', async () => {
    const s = new SwarmWorkspaceStore();
    const report = await runEsaValidation(s, artifact, { siteId: 'site-B', seed: 20260909, cohortSize: 160 });
    expect(report.modelId).toBe('anemia.esa-dose-v1');
    expect(report.cohortSize).toBe(160);
    expect(report.verdict.passed).toBe(true);
    expect(report.metrics.n).toBe(160);
    expect(report.metrics.maeUnits).toBeLessThan(1000);
    expect(report.metrics.withinOneStepPct).toBeGreaterThan(ESA_VALIDATION_PASS.withinOneStepMin * 100);
    expect(report.metrics.spearman).toBeGreaterThan(0.9);
    expect(report.metrics.hbForecastMaePct).toBeLessThan(ESA_VALIDATION_PASS.hbForecastMaxPct);
    expect(report.synthetic).toBe(true);

    // Durable single-doc 'default' — a re-run updates, never duplicates.
    const again = await runEsaValidation(s, artifact, { seed: 20260909 });
    expect(again.id).toBe(report.id);
    expect((await s.list('esa-validation-report')).length).toBe(1);
    expect(await getEsaValidationReport(s)).toBeTruthy();
  });

  it('study-mode records + acceptance analytics (suggest, don\u2019t auto-act)', async () => {
    const s = new SwarmWorkspaceStore();
    await recordEsaStudyDecision(s, {
      patientId: 'p-esa-1', modelId: 'anemia.esa-dose-v1', modelVersion: '1.0.0', recommendedDose: 9500,
      clinicianAction: 'accepted', by: 'Dr. Alvarez (nephrology)', window: { currentHgb: 9.4, currentDose: 8000 },
    });
    await recordEsaStudyDecision(s, {
      patientId: 'p-esa-3', modelId: 'anemia.esa-dose-v1', modelVersion: '1.0.0', recommendedDose: 10000,
      clinicianAction: 'adjusted', adjustedDose: 8000, by: 'Dr. Chen', note: 'Prefer slower titration', window: { currentHgb: 9.6, currentDose: 8000 },
    });
    await recordEsaStudyDecision(s, {
      patientId: 'p-esa-5', modelId: 'anemia.esa-dose-v1', modelVersion: '1.0.0', recommendedDose: 6000,
      clinicianAction: 'withheld', by: 'Dr. Alvarez (nephrology)', window: { currentHgb: 10.9, currentDose: 8000 },
    });
    const stats = esaAcceptanceStats(await s.list('esa-study-record'));
    expect(stats.total).toBe(3);
    expect(stats.accepted).toBe(1);
    expect(stats.adjusted).toBe(1);
    expect(stats.withheld).toBe(1);
    expect(stats.acceptanceRatePct).toBeCloseTo(33.3, 0);
    expect(stats.clinicianRetainedControlPct).toBeGreaterThan(0);
  });

  it('MDR / EU-AI-Act technical file is durable + records risk class + HITL', async () => {
    const s = new SwarmWorkspaceStore();
    const file = await ensureEsaMdrFile(s);
    expect(file.id).toBe('default');
    expect(file.riskClass.aiAct).toBe('high-risk-cdss');
    expect(file.riskClass.mdr).toContain('class-iib');
    expect(file.hitlDesignRecord.approvalClass).toBe('C');
    expect(file.hitlDesignRecord.autonomy).toBe('never-autonomous');
    expect(file.xaiEvidence.driverBars).toBe(true);
    expect(file.synthetic).toBe(true);
    expect(await getEsaMdrFile(s)).toBeTruthy();
    expect((await s.list('esa-mdr-file')).length).toBe(1); // idempotent
  });
});

describe('anemia P3 (routes)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('validation run → durable report; study records + stats; MDR file', async () => {
    const before = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/validation', headers: { cookie: cookie(admin) } });
    expect(before.statusCode).toBe(200);

    const run = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/validation/run', headers: { cookie: cookie(admin) }, payload: { siteId: 'site-B', cohortSize: 160 } });
    expect(run.statusCode).toBe(200);
    expect(run.json().report.verdict.passed).toBe(true);

    const after = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/validation', headers: { cookie: cookie(admin) } });
    expect(after.json().registered).toBe(true);
    expect(after.json().report.modelId).toBe('anemia.esa-dose-v1');
  });

  it('study record endpoint validates + rolls up acceptance stats', async () => {
    const empty = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/study', headers: { cookie: cookie(admin) } });
    expect(empty.json().stats.total).toBeGreaterThanOrEqual(0);

    const rec = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/study/record', headers: { cookie: cookie(admin) },
      payload: { patientId: 'p-esa-2', recommendedDose: 9500, clinicianAction: 'accepted', by: 'Dr. Alvarez (nephrology)', window: { currentHgb: 9.4, currentDose: 8000 } },
    });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().ok).toBe(true);
    expect(rec.json().stats.accepted).toBeGreaterThanOrEqual(1);

    const badAction = await app.inject({
      method: 'POST', url: '/admin/swarm/anemia/study/record', headers: { cookie: cookie(admin) },
      payload: { patientId: 'p-x', recommendedDose: 5000, clinicianAction: 'maybe', window: { currentHgb: 10, currentDose: 5000 } },
    });
    expect(badAction.statusCode).toBe(400);

    const missing = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/study/record', headers: { cookie: cookie(admin) }, payload: { clinicianAction: 'accepted' } });
    expect(missing.statusCode).toBe(400);
  });

  it('MDR endpoint serves the technical file', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/mdr', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const file = res.json().file;
    expect(file.riskClass.aiAct).toBe('high-risk-cdss');
    expect(file.intendedUse).toContain('suggests a dose, never orders');
  });

  it('assurance dashboard now includes validation + study + mdr (P3)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/assurance', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.gate.gates.map((g: { name: string }) => g.name)).toEqual(['Interpretability', 'Coverage', 'Red team', 'Regulatory posture']);
    expect(a.validation).toBeTruthy();
    expect(typeof a.study.acceptanceRatePct).toBe('number');
    expect(a.mdr.riskClass.aiAct).toBe('high-risk-cdss');
  });

  it('unauth P3 endpoints are blocked (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/validation' });
    expect(res.statusCode).toBe(401);
  });
});
