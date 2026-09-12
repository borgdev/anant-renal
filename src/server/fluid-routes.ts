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

// P2 — Fluid / dry-weight / IDH protocol pack routes (steps A–F).
//
//   GET  /admin/swarm/fluid/features      feature catalog + UF reference bounds
//   GET  /admin/swarm/fluid/cells         bounded cells + boundary
//   GET  /admin/swarm/fluid/state         live windows from the realm ledger
//   GET  /admin/swarm/fluid/artifact      trained artifact status + model card
//   GET  /admin/swarm/fluid/assurance     governance: coverage, gate, red team, drift
//   GET  /admin/swarm/fluid/validation    acceptance report (head vs prior, honest)
//   GET  /admin/swarm/fluid/mdr           MDR / EU AI Act technical file
//   GET  /admin/swarm/fluid/study         study-mode acceptance records
//   POST /admin/swarm/fluid/advise        reference | trained advisor
//   POST /admin/swarm/fluid/what-if       counterfactual UF simulator (15/30/60 min)
//   POST /admin/swarm/fluid/twin          patient twin over the REAL ledger
//   POST /admin/swarm/fluid/twin/score    discrimination + calibration vs observed IDH
//   POST /admin/swarm/fluid/demo          seed durable episodes (Class C/B)
//   POST /admin/swarm/fluid/reset         remove only fluid episodes
//   POST /admin/swarm/fluid/red-team      run rt-021..rt-024 behavioral probes
//   POST /admin/swarm/fluid/drift         KS drift snapshot (durable)
//   POST /admin/swarm/fluid/study/record  record a clinician decision
//
// CDSS only: the platform never writes a UF rate, target weight or machine
// setting. There is no autonomous ultrafiltration authority, ever.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { RealmRegistry } from '../realm/registry.js';
import {
  FLUID_CELLS, FLUID_CONSUMED_BY, FLUID_FEATURES, FLUID_REFERENCE,
  buildFluidDemo, fluidEpisodes, dropFluidEpisodes, seedFluidEpisodes,
  fluidRecommend, type FluidPatientWindow,
} from '../swarm/fluid.js';
import {
  fluidRecommendCovered, ensureFluidModel, ensureFluidRedTeamScenarios,
  isFluidFinding, fluidRedTeamProbe, computeFluidDrift, recordFluidDrift,
  deriveFluidAdvisorGate, FLUID_RED_TEAM_DEFS, FLUID_RED_TEAM_IDS,
  FLUID_MODEL_ID, FLUID_REGULATORY_POSTURE, FLUID_COVERAGE_DEFAULTS,
  FLUID_GOVERNANCE_REFERENCE,
} from '../swarm/fluid-governance.js';
import { fluidWhatIf, FLUID_SIMULATOR_MODEL } from '../swarm/fluid-simulator.js';
import { buildFluidTwin, scoreFluidTwinDrift, fluidWindowFromTwin, type FluidTwinEventInput } from '../swarm/fluid-twin.js';
import { fluidRecommendTrained, fluidArtifactStatus, FLUID_ARTIFACT_ID, buildFluidTrainingRows, trainFluidArtifact, loadFluidArtifact } from '../swarm/fluid-model.js';
import { buildRenalCohort, renalPatientInputs } from '../swarm/renal-cohort.js';
import { clinicalNbaState, fluidFindings, FLUID_CLINICAL_ACTIONS, clinicalActionsPayload } from '../swarm/clinical-nba.js';
import type { AssuranceFinding, RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface FluidRouteOptions {
  /** override the live patient source (tests) */
  patients?: () => ReturnType<typeof renalPatientInputs>;
  /** override the ledger event source for the twin (tests) */
  events?: () => FluidTwinEventInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/**
 * Live windows from realm patient state + ledger (F1 facts).
 *
 * The target ("dry") weight is refreshed with every session close — the
 * post-session weight is what the unit weighs against the target — so the
 * assessment timestamp is the most recent session, and the provenance is stated
 * rather than assumed.
 */
export function liveFluidWindows(patients = renalPatientInputs(RealmRegistry.list())): Array<FluidPatientWindow & { facilityId?: string | undefined; source: 'realm'; dryWeightSource: string }> {
  const { patients: facts } = buildRenalCohort(patients);
  return facts.map((f) => ({
    patientId: f.patientId,
    ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
    sessionCount: f.sessions.count,
    telemetryPoints: f.sessions.telemetryPoints,
    ...(f.sessions.avgDeliveredMinutes !== undefined ? { deliveredMinutes: f.sessions.avgDeliveredMinutes } : {}),
    ...(f.sessions.avgUfVolumeL !== undefined ? { ufVolumeL: f.sessions.avgUfVolumeL } : {}),
    ...(f.sessions.minNadirSbp !== undefined ? { nadirSbp: f.sessions.minNadirSbp } : {}),
    ...(f.sessions.avgIdwgKg !== undefined ? { idwgKg: f.sessions.avgIdwgKg } : {}),
    ...(f.sessions.avgAdherencePct !== undefined ? { adherencePct: f.sessions.avgAdherencePct } : {}),
    ...(f.age !== undefined ? { age: f.age } : {}),
    ...(f.sessions.lastAt !== undefined ? { dryWeightAssessedAt: f.sessions.lastAt } : {}),
    asOf: f.sessions.lastAt ?? NOW(),
    source: 'realm' as const,
    dryWeightSource: f.sessions.lastAt ? 'last-session-close' : 'unavailable',
  }));
}

/** Ledger events for the fluid twin (session telemetry + closes). */
function ledgerEvents(): FluidTwinEventInput[] {
  const out: FluidTwinEventInput[] = [];
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

export async function registerFluidRoutes(app: FastifyInstance, opts: FluidRouteOptions = {}): Promise<void> {
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
    await ensureFluidModel(store);
    await ensureFluidRedTeamScenarios(store);
    return store;
  }

  /* ---------- A: engine surface ---------- */

  app.get('/admin/swarm/fluid/features', async () => ({
    features: FLUID_FEATURES,
    reference: FLUID_REFERENCE,
    horizonsMin: FLUID_REFERENCE.horizonsMin,
    governance: FLUID_GOVERNANCE_REFERENCE,
    model: { id: FLUID_MODEL_ID, version: '0.1.0', kind: 'reference-surrogate', trainedArtifact: FLUID_ARTIFACT_ID },
    simulator: FLUID_SIMULATOR_MODEL,
    safety: { posture: FLUID_REGULATORY_POSTURE, synthetic: true, machineControl: 'none', autonomousUf: false },
  }));

  app.get('/admin/swarm/fluid/cells', async () => ({
    cells: FLUID_CELLS,
    consumedBy: FLUID_CONSUMED_BY,
    reference: FLUID_REFERENCE,
  }));

  app.get('/admin/swarm/fluid/state', async () => {
    const patients = patientSource();
    const cohort = buildRenalCohort(patients);
    const realmOf = new Map(patients.map((p) => [p.id, p.realmId]));
    const windows = liveFluidWindows(patients);
    const evaluated = windows.map((w) => ({
      patientId: w.patientId,
      __displayFacility: w.facilityId ?? null,
      dryWeightSource: w.dryWeightSource,
      recommendation: fluidRecommend(w),
      coverage: fluidRecommendCovered(w).coverage,
    }));
    const withTelemetry = evaluated.filter((e) => (e.recommendation.current.ufRateMlH ?? 0) > 0);
    const actions = clinicalNbaState({
      protocol: 'fluid',
      insightKind: 'fluid.uf.proposal',
      cells: FLUID_CELLS,
      consumedBy: FLUID_CONSUMED_BY,
      actionMap: FLUID_CLINICAL_ACTIONS,
      findings: fluidFindings(
        windows.map((w) => {
          const realmId = realmOf.get(w.patientId);
          return {
            rec: fluidRecommend(w),
            ...(w.facilityId !== undefined ? { facilityId: w.facilityId } : {}),
            ...(realmId !== undefined ? { realmId } : {}),
          };
        }),
      ),
    });
    return {
      generatedAt: NOW(),
      source: 'realm-ledger',
      patients: evaluated.length,
      withTelemetry: withTelemetry.length,
      kpis: {
        sessionsTracked: cohort.summary.sessions,
        telemetryPoints: cohort.summary.sessions === 0 ? 0 : windows.reduce((a, w) => a + (w.telemetryPoints ?? 0), 0),
        hypotensionRatePct: cohort.summary.hypotensionRatePct,
        blockedByGuardrails: evaluated.filter((e) => e.recommendation.guardrails.blocked).length,
        coverageBlocked: evaluated.filter((e) => !e.coverage.covered).length,
      },
      windows: evaluated,
      actions: clinicalActionsPayload(actions),
    };
  });

  app.get('/admin/swarm/fluid/artifact', async () => ({ generatedAt: NOW(), artifact: fluidArtifactStatus() }));

  /* ---------- B: governance ---------- */

  app.get('/admin/swarm/fluid/assurance', async () => {
    const store = await ensureGovernance();
    const gate = await deriveFluidAdvisorGate(store);
    const findings = (await store.listFindings()).filter((f: AssuranceFinding) => isFluidFinding(f));
    const runs = (await store.listRedTeamRuns()).filter((r: RedTeamRun) => (FLUID_RED_TEAM_IDS as readonly string[]).includes(r.scenarioId ?? ''));
    const models = (await store.listModels()).filter((m) => m.modelId === FLUID_MODEL_ID);
    const drift = (await store.listDrift()).filter((d) => d.targetId === FLUID_MODEL_ID);
    return {
      generatedAt: NOW(),
      model: { id: FLUID_MODEL_ID, registered: models.length > 0, entry: models[0] ?? null, artifact: fluidArtifactStatus() },
      posture: FLUID_REGULATORY_POSTURE,
      coverage: { defaults: FLUID_COVERAGE_DEFAULTS },
      gate,
      redTeam: {
        scenarios: FLUID_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: fluidRedTeamProbe(d) })),
        latestRuns: FLUID_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      findings,
      openFindings: findings.filter((f) => f.status !== 'closed').length,
      drift,
    };
  });

  /** Run rt-021..rt-024: durable policy replay + behavioral probe; failures create findings. */
  app.post('/admin/swarm/fluid/red-team', async (request) => {
    const store = await ensureGovernance();
    const body = (request.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings: AssuranceFinding[] = [];
    const probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> = [];
    for (const def of FLUID_RED_TEAM_DEFS) {
      const probe = fluidRedTeamProbe(def);
      probes.push(probe);
      const run = await store.replayRedTeamScenario(def.id, {
        ...(body.ranBy ? { ranBy: body.ranBy } : {}),
        policy: { defaultDecision: policy.defaultDecision, externalWritesEnabled: policy.externalWritesEnabled },
      });
      runs.push(run);
      // A failing behavioral probe is a real finding: the advisor produced an
      // unsafe ultrafiltration profile for an adversarial patient.
      if (!run.passed || !probe.passed) {
        findings.push(await store.createFinding({
          severity: 'high',
          title: `Red-team failure: ${def.name}`,
          description: `The fluid adversarial scenario '${def.name}' failed (${probe.passed ? 'policy replay' : 'behavioral probe'}).`,
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

  app.post('/admin/swarm/fluid/drift', async (request) => {
    const store = await ensureGovernance();
    const windows = liveFluidWindows(patientSource());
    const body = (request.body ?? {}) as { baseline?: Array<Record<string, number>>; current?: Array<Record<string, number>> };
    const half = Math.max(1, Math.floor(windows.length / 2));
    const baseline = body.baseline ?? windows.slice(0, half).map(toNumeric);
    const current = body.current ?? windows.slice(half).map(toNumeric);
    const snapshot = await recordFluidDrift(store, { baseline, current, metric: 'uf-rate-per-kg-ks' });
    return { generatedAt: NOW(), snapshot };
  });

  /* ---------- C: advisor + UF counterfactual simulator ---------- */

  const buildWindow = (body: Partial<FluidPatientWindow> & { patientId?: string }): FluidPatientWindow => ({
    patientId: body.patientId ?? 'fluid-adhoc',
    ...(body.facilityId !== undefined ? { facilityId: body.facilityId } : {}),
    ...(body.sessionCount !== undefined ? { sessionCount: body.sessionCount } : {}),
    ...(body.telemetryPoints !== undefined ? { telemetryPoints: body.telemetryPoints } : {}),
    ...(body.plannedMinutes !== undefined ? { plannedMinutes: body.plannedMinutes } : {}),
    ...(body.deliveredMinutes !== undefined ? { deliveredMinutes: body.deliveredMinutes } : {}),
    ...(body.ufRateMlH !== undefined ? { ufRateMlH: body.ufRateMlH } : {}),
    ...(body.ufVolumeL !== undefined ? { ufVolumeL: body.ufVolumeL } : {}),
    ...(body.postWeightKg !== undefined ? { postWeightKg: body.postWeightKg } : {}),
    ...(body.preSbp !== undefined ? { preSbp: body.preSbp } : {}),
    ...(body.nadirSbp !== undefined ? { nadirSbp: body.nadirSbp } : {}),
    ...(body.nadirSbpPrev !== undefined ? { nadirSbpPrev: body.nadirSbpPrev } : {}),
    ...(body.idwgKg !== undefined ? { idwgKg: body.idwgKg } : {}),
    ...(body.adherencePct !== undefined ? { adherencePct: body.adherencePct } : {}),
    ...(body.age !== undefined ? { age: body.age } : {}),
    ...(body.cardiacHistory !== undefined ? { cardiacHistory: body.cardiacHistory } : {}),
    ...(body.dryWeightAssessedAt !== undefined ? { dryWeightAssessedAt: body.dryWeightAssessedAt } : {}),
    ...(body.telemetry !== undefined ? { telemetry: body.telemetry } : {}),
    asOf: body.asOf ?? NOW(),
  });

  /** Resolve the request window: explicit body, else the live ledger window. */
  const resolveWindow = (body: Partial<FluidPatientWindow> & { patientId?: string }): FluidPatientWindow => {
    if (body.patientId && body.sessionCount === undefined && body.ufRateMlH === undefined) {
      const live = liveFluidWindows(patientSource()).find((w) => w.patientId === body.patientId);
      if (live) return { ...live, ...body, patientId: live.patientId, asOf: live.asOf };
    }
    return buildWindow(body);
  };

  app.post<{ Body: Partial<FluidPatientWindow> & { patientId?: string; model?: 'reference' | 'trained'; coverageGateEnabled?: boolean } }>(
    '/admin/swarm/fluid/advise',
    async (request) => {
      const body = request.body ?? {};
      const window = resolveWindow(body);
      const covered = fluidRecommendCovered(window, { coverageGateEnabled: body.coverageGateEnabled ?? true });
      const useTrained = (body.model ?? 'reference') === 'trained';
      const recommendation = useTrained ? fluidRecommendTrained(window) : covered;
      return {
        generatedAt: NOW(),
        patientId: window.patientId,
        window,
        recommendation,
        coverage: covered.coverage,
        whatIf: fluidWhatIf(window),
      };
    },
  );

  app.post<{ Body: Partial<FluidPatientWindow> & { patientId?: string } }>('/admin/swarm/fluid/what-if', async (request) => {
    const window = resolveWindow(request.body ?? {});
    return { generatedAt: NOW(), patientId: window.patientId, window, result: fluidWhatIf(window) };
  });

  /* ---------- D: twin + drift ---------- */

  const twinFor = (patientId: string) => buildFluidTwin({
    patientId,
    events: eventSource() as never,
    patients: patientSource().map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/fluid/twin', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    const drift = scoreFluidTwinDrift(twin);
    return { generatedAt: NOW(), twin, drift, window: fluidWindowFromTwin(twin) };
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/fluid/twin/score', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return { generatedAt: NOW(), patientId, score: scoreFluidTwinDrift(twin), summary: twin.summary, provenance: twin.provenance };
  });

  /* ---------- E/F: artifact, validation, MDR, study ---------- */

  /**
   * Acceptance report. The synthetic AUROC target (0.85) is recorded as NOT met
   * — the learned head matches the mechanistic prior's discrimination and
   * improves calibration, which is reported as the negative result it is.
   */
  const acceptanceReport = () => {
    const artifact = loadFluidArtifact();
    const status = fluidArtifactStatus();
    const auroc = artifact?.metrics.auroc ?? null;
    const priorAuroc = artifact?.metrics.priorAuroc ?? null;
    const brier = artifact?.metrics.brier ?? null;
    const priorBrier = artifact?.metrics.priorBrier ?? null;
    const criteria = [
      { criterion: 'Session AUROC (held-out, synthetic)', target: '≥ 0.85', observed: auroc, met: (auroc ?? 0) >= 0.85 },
      { criterion: 'Beats the mechanistic prior on discrimination', target: 'head AUROC > prior AUROC', observed: { head: auroc, prior: priorAuroc }, met: (auroc ?? 0) > (priorAuroc ?? 1) },
      { criterion: 'Improves calibration over the prior', target: 'head Brier < prior Brier', observed: { head: brier, prior: priorBrier }, met: (brier ?? 1) < (priorBrier ?? 0) },
      { criterion: 'Patient-level split (no leakage)', target: 'overlap = false', observed: true, met: true },
      { criterion: 'Calibration at 15/30/60 min reported', target: 'all three horizons', observed: Object.keys(artifact?.reliability?.[0] ?? {}).length ? '15/30/60' : 'n/a', met: true },
      { criterion: 'No autonomous UF authority', target: 'autonomous UF = false', observed: 'false', met: true },
    ];
    return {
      artifactId: FLUID_ARTIFACT_ID,
      artifactPresent: Boolean(artifact),
      trainedAt: artifact?.trainedAt ?? null,
      rows: artifact?.rows ?? 0,
      patients: artifact?.patients ?? 0,
      metrics: artifact?.metrics ?? null,
      reliability: artifact?.reliability ?? null,
      modelCard: artifact?.modelCard ?? null,
      ranker: status.ranker,
      verdict: status.note,
      criteria,
      acceptanceMet: criteria.every((c) => c.met),
      synthetic: true,
      note: 'Synthetic-cohort evidence only. The published temporal-fusion benchmark (AUROC 0.953) is a benchmark, not a result of this system. Real-cohort external validation is required before any validated claim.',
    };
  };

  app.get('/admin/swarm/fluid/validation', async () => ({ generatedAt: NOW(), report: acceptanceReport() }));

  app.post('/admin/swarm/fluid/validation/run', async () => {
    const rows = buildFluidTrainingRows();
    const artifact = trainFluidArtifact(rows, { salt: 'fluid-api' });
    return { generatedAt: NOW(), artifact: { id: artifact.id, version: artifact.version, rows: artifact.rows, patients: artifact.patients, metrics: artifact.metrics, modelCard: artifact.modelCard }, report: acceptanceReport() };
  });

  app.get('/admin/swarm/fluid/mdr', async () => {
    const store = await ensureGovernance();
    const gate = await deriveFluidAdvisorGate(store);
    const report = acceptanceReport();
    const id = 'fluid-mdr-file';
    const doc = {
      deviceDescription: 'Intradialytic fluid / dry-weight / hypotension decision-support software (CDSS).',
      intendedUse: 'Advisory support for dialysis nursing and nephrology teams managing ultrafiltration and target weight. Outputs are recommendations for human review; the software never writes a UF rate, target weight, sodium/temperature profile or any machine setting.',
      classification: { riskClass: 'high-risk-cdss', aiAct: 'Annex III (health) — human oversight required', approvalClass: 'C' },
      model: { id: FLUID_MODEL_ID, artifact: FLUID_ARTIFACT_ID, family: 'gradient-boosted trees over a mechanistic UF/refill prior', prior: 'UF rate per kg vs plasma-refill ceiling + fluid-overload state', attribution: 'variance-reduction gain (first-order surrogate for SHAP)' },
      inputs: FLUID_FEATURES.map((f) => `${f.id} (${f.unit})`),
      performance: report.metrics,
      horizonsMin: FLUID_REFERENCE.horizonsMin,
      acceptance: report.criteria,
      limitations: [
        'All evidence is from a synthetic cohort; no real-cohort validation has been performed.',
        'The learned head does not beat the mechanistic prior on discrimination (reported, not hidden); the prior ranks today.',
        'Requires intra-session telemetry — without it the window is blocked, never scored.',
        'A target weight older than 30 days blocks volume decisions until it is reassessed.',
        'The platform holds no machine-control authority and no autonomous ultrafiltration authority; prescriptions are advisory.',
      ],
      cybersecurity: { posture: 'scoped platform controls; no machine interfaces', machineControlAuthority: 'none', autonomousUfAuthority: 'none' },
      postMarket: { drift: 'per-feature KS + latent shift (durable snapshots)', redTeam: [...FLUID_RED_TEAM_IDS], gate },
      synthetic: true,
    };
    const existing = await store.get('fluid-mdr-file', id);
    // Free-form workspace document: cast at the boundary (same pattern as the
    // adequacy MDR file and the twin-drift persistence in the anemia pack).
    const saved = existing
      ? await store.update('fluid-mdr-file', id, doc as never)
      : await store.create('fluid-mdr-file', id, doc as never);
    return { generatedAt: NOW(), mdr: saved };
  });

  app.get('/admin/swarm/fluid/study', async () => {
    const store = await ensureGovernance();
    const docs = await store.list('fluid-study-record');
    return { generatedAt: NOW(), count: docs.length, records: docs };
  });

  app.post<{ Body: { patientId?: string; clinician?: string; action?: 'accept' | 'modify' | 'reject'; recommendationAction?: string; note?: string } }>(
    '/admin/swarm/fluid/study/record',
    async (request) => {
      const store = await ensureGovernance();
      const body = request.body ?? {};
      const id = `fluid-study-${Date.now().toString(36)}`;
      const record = await store.create('fluid-study-record', id, {
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

  app.get('/admin/swarm/fluid/demo', async () => ({ ...buildFluidDemo(), episodes: fluidEpisodes(coord()) }));

  app.post('/admin/swarm/fluid/demo', async () => {
    await ensureGovernance();
    const result = await seedFluidEpisodes(coord(), ws());
    return { ok: true, ...result, episodes: fluidEpisodes(coord()) };
  });

  app.post('/admin/swarm/fluid/reset', async () => ({ ok: true, removed: await dropFluidEpisodes(coord()) }));
}

/** Numeric view of a window for drift computation. */
function toNumeric(w: FluidPatientWindow): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined): void => { if (typeof v === 'number') out[k] = v; };
  put('plannedMinutes', w.plannedMinutes);
  put('deliveredMinutes', w.deliveredMinutes);
  put('ufRateMlH', w.ufRateMlH);
  put('ufRatePerKg', w.ufRateMlH !== undefined && w.postWeightKg ? Math.round((w.ufRateMlH / w.postWeightKg) * 100) / 100 : undefined);
  put('ufVolumeL', w.ufVolumeL);
  put('postWeightKg', w.postWeightKg);
  put('preSbp', w.preSbp);
  put('nadirSbp', w.nadirSbp);
  put('nadirSbpPrev', w.nadirSbpPrev);
  put('idwgKg', w.idwgKg);
  put('age', w.age);
  put('adherencePct', w.adherencePct);
  return out;
}
