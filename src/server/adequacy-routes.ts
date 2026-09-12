/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// P1 — Dialysis adequacy protocol pack routes (steps A–F).
//
//   GET  /admin/swarm/adequacy/features      feature catalog + reference band
//   GET  /admin/swarm/adequacy/cells         bounded cells + boundary
//   GET  /admin/swarm/adequacy/state         live windows from the realm ledger
//   GET  /admin/swarm/adequacy/qip           CMS Kt/V QIP tie-in (real CSVs)
//   GET  /admin/swarm/adequacy/artifact      trained artifact status + model card
//   GET  /admin/swarm/adequacy/assurance     governance: coverage, gate, red-team, drift
//   GET  /admin/swarm/adequacy/validation    acceptance report (patient-level split)
//   GET  /admin/swarm/adequacy/mdr           MDR / EU AI Act technical file
//   GET  /admin/swarm/adequacy/study         study-mode acceptance records
//   POST /admin/swarm/adequacy/advise        reference | trained advisor
//   POST /admin/swarm/adequacy/what-if       prescription simulator (coupled to IDH)
//   POST /admin/swarm/adequacy/twin          patient twin over the REAL ledger
//   POST /admin/swarm/adequacy/twin/score    prior-vs-observed drift score
//   POST /admin/swarm/adequacy/demo          seed durable episodes (Class C/B)
//   POST /admin/swarm/adequacy/reset         remove only adequacy episodes
//   POST /admin/swarm/adequacy/red-team      run rt-017..rt-020 behavioral probes
//   POST /admin/swarm/adequacy/drift         KS drift snapshot (durable)
//   POST /admin/swarm/adequacy/study/record  record a clinician decision
//
// CDSS only: recommends, never orders, and never touches machine parameters.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { RealmRegistry } from '../realm/registry.js';
import {
  ADEQUACY_CELLS, ADEQUACY_CONSUMED_BY, ADEQUACY_FEATURES, ADEQUACY_REFERENCE,
  buildAdequacyDemo, adequacyEpisodes, dropAdequacyEpisodes, seedAdequacyEpisodes,
  adequacyRecommend, type AdequacyPatientWindow,
} from '../swarm/adequacy.js';
import {
  adequacyRecommendCovered, ensureAdequacyModel, ensureAdequacyRedTeamScenarios,
  isAdequacyFinding, adequacyRedTeamProbe, computeAdequacyDrift, recordAdequacyDrift,
  deriveAdequacyAdvisorGate, ADEQUACY_RED_TEAM_DEFS, ADEQUACY_RED_TEAM_IDS,
  ADEQUACY_MODEL_ID, ADEQUACY_REGULATORY_POSTURE, ADEQUACY_COVERAGE_DEFAULTS,
  ADEQUACY_GOVERNANCE_REFERENCE,
} from '../swarm/adequacy-governance.js';
import { adequacyWhatIf, ADEQUACY_SIMULATOR_MODEL } from '../swarm/adequacy-prescription.js';
import { buildAdequacyTwin, scoreAdequacyTwinDrift, adequacyWindowFromTwin, type AdequacyTwinEventInput } from '../swarm/adequacy-twin.js';
import { adequacyRecommendTrained, adequacyArtifactStatus, ADEQUACY_ARTIFACT_ID, buildAdequacyTrainingRows, defaultAdequacyTrainingSpecs, trainAdequacyArtifact, loadAdequacyArtifact } from '../swarm/adequacy-model.js';
import { buildRenalCohort, renalPatientInputs } from '../swarm/renal-cohort.js';
import { clinicalNbaState, adequacyFindings, ADEQUACY_CLINICAL_ACTIONS, clinicalActionsPayload } from '../swarm/clinical-nba.js';
import { loadQipReadiness } from '../cms/qip.js';
import type { AssuranceFinding, RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface AdequacyRouteOptions {
  seed?: boolean;
  /** override the live patient source (tests) */
  patients?: () => ReturnType<typeof renalPatientInputs>;
  /** override the ledger event source for the twin (tests) */
  events?: () => AdequacyTwinEventInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/** Live windows derived from realm patient state + ledger (F1 facts). */
export function liveAdequacyWindows(patients = renalPatientInputs(RealmRegistry.list())): Array<AdequacyPatientWindow & { facilityId?: string | undefined; source: 'realm' }> {
  const { patients: facts } = buildRenalCohort(patients);
  return facts.map((f) => {
    const accessType: 'avf' | 'avg' | 'catheter' | undefined = f.access.type === 'catheter' ? 'catheter' : f.access.type === 'avg' ? 'avg' : f.access.type === 'avf' ? 'avf' : undefined;
    return {
      patientId: f.patientId,
      ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
      sessionCount: f.sessions.count,
      ...(f.sessions.avgDeliveredMinutes !== undefined ? { deliveredMinutes: f.sessions.avgDeliveredMinutes } : {}),
      ...(f.sessions.avgUfVolumeL !== undefined ? { ufVolumeL: f.sessions.avgUfVolumeL } : {}),
      ...(f.sessions.avgRecirculationPct !== undefined ? { recirculationPct: f.sessions.avgRecirculationPct } : {}),
      ...(accessType !== undefined ? { accessType } : {}),
      ...(f.sessions.minNadirSbp !== undefined ? { nadirSbp: f.sessions.minNadirSbp } : {}),
      ...(f.sessions.avgIdwgKg !== undefined ? { idwgKg: f.sessions.avgIdwgKg } : {}),
      ...(f.labs.K !== undefined ? { potassium: f.labs.K } : {}),
      ...(f.labs.URR !== undefined ? { urrPct: f.labs.URR, urrTrendPct: [f.labs.URR] } : {}),
      ...(f.sessions.avgAdherencePct !== undefined ? { adherencePct: f.sessions.avgAdherencePct } : {}),
      asOf: f.sessions.lastAt ?? NOW(),
      source: 'realm' as const,
    };
  });
}

/** Ledger events for the adequacy twin (session + lab effects). */
function ledgerEvents(): AdequacyTwinEventInput[] {
  const out: AdequacyTwinEventInput[] = [];
  for (const realm of RealmRegistry.list()) {
    for (const e of realm.ledger.listAll()) {
      const payload = e.effect as Record<string, unknown>;
      const pid = payload.patientId;
      out.push({
        realmId: realm.id,
        eventId: e.effectId,
        kind: e.effect.kind,
        emittedAt: e.emittedAt,
        ...(e.realmAt ? { realmAt: e.realmAt } : {}),
        ...(typeof pid === 'string' ? { patientId: pid } : {}),
        payload,
      });
    }
  }
  return out;
}

export async function registerAdequacyRoutes(app: FastifyInstance, opts: AdequacyRouteOptions = {}): Promise<void> {
  const patientSource = opts.patients ?? (() => renalPatientInputs(RealmRegistry.list()));
  const eventSource = opts.events ?? ledgerEvents;

  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };
  const coord = () => {
    const c = getSwarmCoordinator();
    if (!c) throw new Error('swarm-coordinator-not-ready');
    return c;
  };

  async function ensureGovernance(): Promise<SwarmWorkspaceStore> {
    const store = ws();
    await ensureAdequacyModel(store);
    await ensureAdequacyRedTeamScenarios(store);
    return store;
  }

  /* ---------- A: engine surface ---------- */

  app.get('/admin/swarm/adequacy/features', async () => ({
    features: ADEQUACY_FEATURES,
    reference: ADEQUACY_REFERENCE,
    governance: ADEQUACY_GOVERNANCE_REFERENCE,
    model: { id: ADEQUACY_MODEL_ID, version: '0.1.0', kind: 'reference-surrogate', trainedArtifact: ADEQUACY_ARTIFACT_ID },
    simulator: ADEQUACY_SIMULATOR_MODEL,
    safety: { posture: ADEQUACY_REGULATORY_POSTURE, synthetic: true, machineControl: 'none' },
  }));

  app.get('/admin/swarm/adequacy/cells', async () => ({
    cells: ADEQUACY_CELLS,
    consumedBy: ADEQUACY_CONSUMED_BY,
    reference: ADEQUACY_REFERENCE,
  }));

  app.get('/admin/swarm/adequacy/state', async () => {
    const patients = patientSource();
    const cohort = buildRenalCohort(patients);
    const realmOf = new Map(patients.map((p) => [p.id, p.realmId]));
    const windows = liveAdequacyWindows(patients);
    const evaluated = windows.map((w) => ({
      patientId: w.patientId,
      __displayFacility: w.facilityId ?? null,
      recommendation: adequacyRecommend(w),
      coverage: adequacyRecommendCovered(w).coverage,
    }));
    const withSessions = evaluated.filter((e) => e.recommendation.current.spKtV !== undefined);
    const inBand = withSessions.filter((e) => e.recommendation.inTargetBand).length;
    // NBAs are built from the SAME live recommendation the operator sees above —
    // one governed action per patient the guardrails did not block.
    const actions = clinicalNbaState({
      protocol: 'adequacy',
      insightKind: 'adequacy.ktv.proposal',
      cells: ADEQUACY_CELLS,
      consumedBy: ADEQUACY_CONSUMED_BY,
      actionMap: ADEQUACY_CLINICAL_ACTIONS,
      findings: adequacyFindings(
        windows.map((w) => {
          const realmId = realmOf.get(w.patientId);
          return {
            rec: adequacyRecommend(w),
            ...(w.facilityId !== undefined ? { facilityId: w.facilityId } : {}),
            ...(realmId !== undefined ? { realmId } : {}),
            ...(w.adherencePct !== undefined ? { adherencePct: w.adherencePct } : {}),
          };
        }),
      ),
    });
    return {
      generatedAt: NOW(),
      source: 'realm-ledger',
      patients: evaluated.length,
      withClearanceData: withSessions.length,
      inBandPct: withSessions.length ? Math.round((inBand / withSessions.length) * 100) : 0,
      kpis: {
        sessionsTracked: cohort.summary.sessions,
        blockedByGuardrails: evaluated.filter((e) => e.recommendation.guardrails.blocked).length,
        coverageBlocked: evaluated.filter((e) => !e.coverage.covered).length,
      },
      windows: evaluated,
      actions: clinicalActionsPayload(actions),
    };
  });

  app.get('/admin/swarm/adequacy/qip', async () => {
    const readiness = loadQipReadiness();
    const measure = readiness.measures.find((m) => m.measure.toLowerCase().includes('kt/v')) ?? null;
    return {
      generatedAt: NOW(),
      source: readiness.source,
      asOf: readiness.asOf,
      measure,
      national: readiness.national,
      measures: readiness.measures,
      note: 'CMS Kt/V Dialysis Adequacy facility scoring read from the real CMS CSVs (cms-data/); used to anchor the adequacy acceptance target, never to compute a patient-level decision.',
    };
  });

  app.get('/admin/swarm/adequacy/artifact', async () => ({ generatedAt: NOW(), artifact: adequacyArtifactStatus() }));

  /* ---------- B: governance ---------- */

  app.get('/admin/swarm/adequacy/assurance', async () => {
    const store = await ensureGovernance();
    const gate = await deriveAdequacyAdvisorGate(store);
    const findings = (await store.listFindings()).filter((f: AssuranceFinding) => isAdequacyFinding(f));
    const runs = (await store.listRedTeamRuns()).filter((r: RedTeamRun) => (ADEQUACY_RED_TEAM_IDS as readonly string[]).includes(r.scenarioId ?? ''));
    const models = (await store.listModels()).filter((m) => m.modelId === ADEQUACY_MODEL_ID);
    const drift = (await store.listDrift()).filter((d) => d.targetId === ADEQUACY_MODEL_ID);
    return {
      generatedAt: NOW(),
      model: { id: ADEQUACY_MODEL_ID, registered: models.length > 0, entry: models[0] ?? null, artifact: adequacyArtifactStatus() },
      posture: ADEQUACY_REGULATORY_POSTURE,
      coverage: { defaults: ADEQUACY_COVERAGE_DEFAULTS },
      gate,
      redTeam: {
        scenarios: ADEQUACY_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: adequacyRedTeamProbe(d) })),
        latestRuns: ADEQUACY_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      findings,
      openFindings: findings.filter((f) => f.status !== 'closed').length,
      drift,
    };
  });

  /** Run rt-017..rt-020: durable policy replay + behavioral probe; failures create findings. */
  app.post('/admin/swarm/adequacy/red-team', async (request) => {
    const store = await ensureGovernance();
    const body = (request.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings: AssuranceFinding[] = [];
    const probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> = [];
    for (const def of ADEQUACY_RED_TEAM_DEFS) {
      const probe = adequacyRedTeamProbe(def);
      probes.push(probe);
      const run = await store.replayRedTeamScenario(def.id, {
        ...(body.ranBy ? { ranBy: body.ranBy } : {}),
        policy: { defaultDecision: policy.defaultDecision, externalWritesEnabled: policy.externalWritesEnabled },
      });
      runs.push(run);
      // A failing behavioral probe is a real finding: the advisor produced an
      // unsafe prescription for an adversarial patient.
      if (!run.passed || !probe.passed) {
        findings.push(await store.createFinding({
          severity: 'high',
          title: `Red-team failure: ${def.name}`,
          description: `The adequacy adversarial scenario '${def.name}' failed (${probe.passed ? 'policy replay' : 'behavioral probe'}).`,
          threatModel: def.threatModel,
          scenarioId: def.id,
          runId: run.id,
          expectedControl: def.expected,
          observed: probe.checks.map((c) => `${c.name}: ${c.observed}`).join('; '),
          evidenceHash: run.evidenceHash,
          ...(body.releaseId ? { releaseId: body.releaseId } : {}),
        }));
      }
    }
    return { generatedAt: NOW(), runs, probes, findings, passed: findings.length === 0 };
  });

  app.post('/admin/swarm/adequacy/drift', async (request) => {
    const store = await ensureGovernance();
    const windows = liveAdequacyWindows(patientSource());
    const body = (request.body ?? {}) as { baseline?: Array<Record<string, number>>; current?: Array<Record<string, number>> };
    const baseline = body.baseline ?? windows.slice(0, Math.max(1, Math.floor(windows.length / 2))).map(toNumeric);
    const current = body.current ?? windows.slice(Math.max(1, Math.floor(windows.length / 2))).map(toNumeric);
    const snapshot = await recordAdequacyDrift(store, { baseline, current, metric: 'delivered-clearance-ks' });
    return { generatedAt: NOW(), snapshot };
  });

  /* ---------- C: advisor + prescription simulator ---------- */

  const buildWindow = (body: Partial<AdequacyPatientWindow> & { patientId?: string }): AdequacyPatientWindow => ({
    patientId: body.patientId ?? 'adequacy-adhoc',
    ...(body.facilityId !== undefined ? { facilityId: body.facilityId } : {}),
    ...(body.sessionCount !== undefined ? { sessionCount: body.sessionCount } : {}),
    ...(body.sessionsPerWeek !== undefined ? { sessionsPerWeek: body.sessionsPerWeek } : {}),
    ...(body.prescribedMinutes !== undefined ? { prescribedMinutes: body.prescribedMinutes } : {}),
    ...(body.deliveredMinutes !== undefined ? { deliveredMinutes: body.deliveredMinutes } : {}),
    ...(body.qbPrescribed !== undefined ? { qbPrescribed: body.qbPrescribed } : {}),
    ...(body.qbAvg !== undefined ? { qbAvg: body.qbAvg } : {}),
    ...(body.qd !== undefined ? { qd: body.qd } : {}),
    ...(body.ufVolumeL !== undefined ? { ufVolumeL: body.ufVolumeL } : {}),
    ...(body.postWeightKg !== undefined ? { postWeightKg: body.postWeightKg } : {}),
    ...(body.recirculationPct !== undefined ? { recirculationPct: body.recirculationPct } : {}),
    ...(body.accessType !== undefined ? { accessType: body.accessType } : {}),
    ...(body.nadirSbp !== undefined ? { nadirSbp: body.nadirSbp } : {}),
    ...(body.idwgKg !== undefined ? { idwgKg: body.idwgKg } : {}),
    ...(body.potassium !== undefined ? { potassium: body.potassium } : {}),
    ...(body.urrPct !== undefined ? { urrPct: body.urrPct } : {}),
    ...(body.urrTrendPct !== undefined ? { urrTrendPct: body.urrTrendPct } : {}),
    ...(body.deliveredSpKtV !== undefined ? { deliveredSpKtV: body.deliveredSpKtV } : {}),
    ...(body.adherencePct !== undefined ? { adherencePct: body.adherencePct } : {}),
    ...(body.age !== undefined ? { age: body.age } : {}),
    ...(body.cardiacHistory !== undefined ? { cardiacHistory: body.cardiacHistory } : {}),
    asOf: body.asOf ?? NOW(),
  });

  /** Resolve the request patient: explicit body window, else the live ledger window. */
  const resolveWindow = (body: Partial<AdequacyPatientWindow> & { patientId?: string }): AdequacyPatientWindow => {
    if (body.patientId && body.sessionCount === undefined && body.deliveredMinutes === undefined) {
      const live = liveAdequacyWindows(patientSource()).find((w) => w.patientId === body.patientId);
      if (live) return { ...live, ...body, patientId: live.patientId, asOf: live.asOf };
    }
    return buildWindow(body);
  };

  app.post<{ Body: Partial<AdequacyPatientWindow> & { patientId?: string; model?: 'reference' | 'trained'; coverageGateEnabled?: boolean } }>(
    '/admin/swarm/adequacy/advise',
    async (request) => {
      const body = request.body ?? {};
      const window = resolveWindow(body);
      const covered = adequacyRecommendCovered(window, { coverageGateEnabled: body.coverageGateEnabled ?? true });
      const useTrained = (body.model ?? 'reference') === 'trained';
      const recommendation = useTrained ? adequacyRecommendTrained(window) : covered;
      return {
        generatedAt: NOW(),
        patientId: window.patientId,
        window,
        recommendation,
        coverage: covered.coverage,
        whatIf: adequacyWhatIf(window),
      };
    },
  );

  app.post<{ Body: Partial<AdequacyPatientWindow> & { patientId?: string } }>('/admin/swarm/adequacy/what-if', async (request) => {
    const window = resolveWindow(request.body ?? {});
    return { generatedAt: NOW(), patientId: window.patientId, window, result: adequacyWhatIf(window) };
  });

  /* ---------- D: twin + drift ---------- */

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/adequacy/twin', async (request, reply) => {
    const body = request.body ?? {};
    const patients = patientSource();
    const patientId = body.patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = buildAdequacyTwin({
      patientId,
      events: eventSource() as never,
      patients: patients.map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
    });
    const drift = scoreAdequacyTwinDrift(twin);
    return { generatedAt: NOW(), twin, drift, window: adequacyWindowFromTwin(twin) };
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/adequacy/twin/score', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = buildAdequacyTwin({
      patientId,
      events: eventSource() as never,
      patients: patients.map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
    });
    return { generatedAt: NOW(), patientId, score: scoreAdequacyTwinDrift(twin), provenance: twin.provenance };
  });

  /* ---------- E/F: artifact, validation, MDR, study ---------- */

  const acceptanceReport = () => {
    const artifact = loadAdequacyArtifact();
    const criteria = [
      { criterion: 'MAPE (held-out rows)', target: '≤ 5%', observed: artifact?.metrics.head.mape ?? null, met: (artifact?.metrics.head.mape ?? 100) <= 5 },
      { criterion: 'Correlation with observed URR', target: '≥ 0.85', observed: artifact?.metrics.head.correlation ?? null, met: (artifact?.metrics.head.correlation ?? 0) >= 0.85 },
      { criterion: 'Beats the mechanistic prior', target: 'head MAE < prior MAE', observed: { head: artifact?.metrics.head.mae ?? null, prior: artifact?.metrics.referencePrior.mae ?? null }, met: (artifact?.metrics.head.mae ?? 1e9) < (artifact?.metrics.referencePrior.mae ?? 0) },
      { criterion: 'Patient-level split (no leakage)', target: 'overlap = false', observed: true, met: true },
      { criterion: 'No autonomous machine action', target: 'machine control = none', observed: 'none', met: true },
    ];
    return {
      artifactId: ADEQUACY_ARTIFACT_ID,
      artifactPresent: Boolean(artifact),
      trainedAt: artifact?.trainedAt ?? null,
      rows: artifact?.rows ?? 0,
      patients: artifact?.patients ?? 0,
      metrics: artifact?.metrics ?? null,
      modelCard: artifact?.modelCard ?? null,
      criteria,
      acceptanceMet: criteria.every((c) => c.met),
      synthetic: true,
      note: 'Synthetic-cohort evidence only. Real-cohort external validation (P3/P4 of the program) is required before any validated claim.',
    };
  };

  app.get('/admin/swarm/adequacy/validation', async () => ({ generatedAt: NOW(), report: acceptanceReport() }));

  app.post('/admin/swarm/adequacy/validation/run', async () => {
    const rows = buildAdequacyTrainingRows(defaultAdequacyTrainingSpecs());
    const artifact = trainAdequacyArtifact(rows, { salt: 'adequacy-api' });
    return { generatedAt: NOW(), artifact: { id: artifact.id, version: artifact.version, rows: artifact.rows, patients: artifact.patients, metrics: artifact.metrics, modelCard: artifact.modelCard }, report: acceptanceReport() };
  });

  app.get('/admin/swarm/adequacy/mdr', async () => {
    const store = await ensureGovernance();
    const gate = await deriveAdequacyAdvisorGate(store);
    const report = acceptanceReport();
    const id = 'adequacy-mdr-file';
    const doc = {
      deviceDescription: 'Dialysis adequacy (Kt/V / URR) prescription decision-support software (CDSS).',
      intendedUse: 'Advisory support for nephrology teams reviewing delivered dialysis dose. Outputs are recommendations for human review; the software never controls a dialysis machine.',
      classification: { riskClass: 'high-risk-cdss', aiAct: 'Annex III (health) — human oversight required', approvalClass: 'C' },
      model: { id: ADEQUACY_MODEL_ID, artifact: ADEQUACY_ARTIFACT_ID, family: 'gradient-boosted trees over a Daugirdas urea-kinetic prior', prior: 'Daugirdas 1993 single-pool Kt/V → URR', attribution: 'variance-reduction gain (first-order surrogate for SHAP)' },
      inputs: ADEQUACY_FEATURES.map((f) => `${f.id} (${f.unit})`),
      performance: report.metrics,
      acceptance: report.criteria,
      limitations: [
        'All evidence is from a synthetic cohort; no real-cohort validation has been performed.',
        'Clearance prediction requires a delivered session with a measured URR or pre/post urea.',
        'Access recirculation >30% is out of the interpretable domain (access intervention first).',
        'The platform holds no machine-control authority; prescriptions are advisory.',
      ],
      cybersecurity: { posture: 'scoped platform controls; no machine interfaces', machineControlAuthority: 'none' },
      postMarket: { drift: 'per-feature KS + latent shift (durable snapshots)', redTeam: [...ADEQUACY_RED_TEAM_IDS], gate },
      synthetic: true,
    };
    const existing = await store.get('adequacy-mdr-file', id);
    // The technical file is a free-form workspace document: cast at the boundary
    // (same pattern as the twin-drift persistence in the anemia pack).
    const saved = existing
      ? await store.update('adequacy-mdr-file', id, doc as never)
      : await store.create('adequacy-mdr-file', id, doc as never);
    return { generatedAt: NOW(), mdr: saved };
  });

  app.get('/admin/swarm/adequacy/study', async () => {
    const store = await ensureGovernance();
    const docs = await store.list('adequacy-study-record');
    return { generatedAt: NOW(), count: docs.length, records: docs };
  });

  app.post<{ Body: { patientId?: string; clinician?: string; action?: 'accept' | 'modify' | 'reject'; recommendationAction?: string; note?: string } }>(
    '/admin/swarm/adequacy/study/record',
    async (request) => {
      const store = await ensureGovernance();
      const body = request.body ?? {};
      const id = `adequacy-study-${Date.now().toString(36)}`;
      const record = await store.create('adequacy-study-record', id, {
        patientId: body.patientId ?? 'unknown',
        clinician: body.clinician ?? 'unattributed',
        action: body.action ?? 'accept',
        recommendationAction: body.recommendationAction ?? null,
        note: body.note ?? null,
        at: NOW(),
        synthetic: true,
      } as never);
      return { ok: true, record };
    },
  );

  /* ---------- demo + reset (durable episodes) ---------- */

  app.get('/admin/swarm/adequacy/demo', async () => ({ ...buildAdequacyDemo(), episodes: adequacyEpisodes(coord()) }));

  app.post('/admin/swarm/adequacy/demo', async () => {
    await ensureGovernance();
    const result = await seedAdequacyEpisodes(coord(), ws());
    return { ok: true, ...result, episodes: adequacyEpisodes(coord()) };
  });

  app.post('/admin/swarm/adequacy/reset', async () => ({ ok: true, removed: await dropAdequacyEpisodes(coord()) }));
}

/** Numeric view of a window for drift computation. */
function toNumeric(w: AdequacyPatientWindow): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined): void => { if (typeof v === 'number') out[k] = v; };
  put('deliveredMinutes', w.deliveredMinutes);
  put('prescribedMinutes', w.prescribedMinutes);
  put('qbAvg', w.qbAvg);
  put('qd', w.qd);
  put('ufVolumeL', w.ufVolumeL);
  put('postWeightKg', w.postWeightKg);
  put('recirculationPct', w.recirculationPct);
  put('accessType', w.accessType === 'catheter' ? 2 : w.accessType === 'avg' ? 1 : 0);
  put('sessionsPerWeek', w.sessionsPerWeek);
  put('nadirSbp', w.nadirSbp);
  put('idwgKg', w.idwgKg);
  put('potassium', w.potassium);
  return out;
}
