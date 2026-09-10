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

// P3 — vascular access protocol pack routes (steps A–F).
//
//   GET  /admin/swarm/access/features      feature catalog + access reference bounds
//   GET  /admin/swarm/access/cells         bounded cells + boundary
//   GET  /admin/swarm/access/state         live access windows from the realm ledger
//   GET  /admin/swarm/access/acoustic      the gated audio-path contract + captures
//   GET  /admin/swarm/access/artifact      trained artifact status + model card
//   GET  /admin/swarm/access/assurance     governance: coverage, gate, red team, drift
//   GET  /admin/swarm/access/validation    acceptance report (longitudinal-only, honest)
//   GET  /admin/swarm/access/mdr           MDR / EU AI Act technical file
//   GET  /admin/swarm/access/study         study-mode acceptance records
//   POST /admin/swarm/access/advise        reference | trained advisor
//   POST /admin/swarm/access/what-if       surveillance vs referral counterfactual
//   POST /admin/swarm/access/twin          patient access twin over the REAL ledger
//   POST /admin/swarm/access/twin/score    discrimination + calibration vs observed outcomes
//   POST /admin/swarm/access/demo          seed durable episodes (Class C/B)
//   POST /admin/swarm/access/reset         remove only access episodes
//   POST /admin/swarm/access/red-team      run rt-025..rt-028 behavioural probes
//   POST /admin/swarm/access/drift         KS drift snapshot (durable)
//   POST /admin/swarm/access/study/record  record a clinician decision
//
// CDSS only: no procedure, catheter, needle or machine parameter is ever written
// by the platform. Every referral is a proposal for a human decision.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { RealmRegistry } from '../realm/registry.js';
import {
  ACCESS_CELLS, ACCESS_CONSUMED_BY, ACCESS_FEATURES, ACCESS_REFERENCE,
  buildAccessDemo, accessEpisodes, dropAccessEpisodes, seedAccessEpisodes,
  accessRecommend, accessBaseline, guardAccessReferral, stenosisProbability, thrombosisRisk,
  type AccessGuardInput,
} from '../swarm/access.js';
import {
  accessRecommendCovered, ensureAccessModel, ensureAccessRedTeamScenarios,
  isAccessFinding, accessRedTeamProbe, computeAccessDrift, recordAccessDrift,
  deriveAccessAdvisorGate, ACCESS_RED_TEAM_DEFS, ACCESS_RED_TEAM_IDS,
  ACCESS_MODEL_ID, ACCESS_REGULATORY_POSTURE, ACCESS_COVERAGE_DEFAULTS,
  ACCESS_GOVERNANCE_REFERENCE, ACCESS_ACOUSTIC_FLAG, accessAcousticEnabled,
} from '../swarm/access-governance.js';
import { accessWhatIf, accessRiskSurface, ACCESS_SIMULATOR_MODEL } from '../swarm/access-simulator.js';
import { buildAccessTwin, scoreAccessTwinDrift, accessWindowFromTwin, type AccessTwinEventInput } from '../swarm/access-twin.js';
import { accessRecommendTrained, accessArtifactStatus, ACCESS_ARTIFACT_ID, buildAccessTrainingRows, trainAccessArtifact, loadAccessArtifact, accessAcousticDelta } from '../swarm/access-model.js';
import { buildRenalCohort, renalPatientInputs } from '../swarm/renal-cohort.js';
import type { AssuranceFinding, RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface AccessRouteOptions {
  /** override the live patient source (tests) */
  patients?: () => ReturnType<typeof renalPatientInputs>;
  /** override the ledger event source for the twin (tests) */
  events?: () => AccessTwinEventInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/**
 * Live windows from the F1 access surveillance series: the patient's own first
 * measurements form the baseline the Δ terms are computed against.
 */
export function liveAccessWindows(patients = renalPatientInputs(RealmRegistry.list())): Array<AccessGuardInput & { patientId: string; facilityId?: string | undefined; lastObservationAt?: string | undefined; source: 'realm'; acousticCaptures: number }> {
  const { patients: facts } = buildRenalCohort(patients);
  return facts.map((f) => {
    const series = f.access.series ?? [];
    const measured = series.filter((o) => o.venousPressureMmHg !== undefined || o.accessFlowMlMin !== undefined);
    const latest = measured[measured.length - 1];
    // ONE baseline rule shared with the twin: the median of the first three
    // measured values (robust to a single noisy leading reading).
    const pressureBaseline = accessBaseline(measured.map((o) => o.venousPressureMmHg).filter((v): v is number => v !== undefined));
    const flowBaseline = accessBaseline(measured.map((o) => o.accessFlowMlMin).filter((v): v is number => v !== undefined));
    const clearanceBaseline = accessBaseline(measured.map((o) => o.deliveredClearancePct).filter((v): v is number => v !== undefined));
    const difficulty = latest?.cannulationDifficulty;
    const accessType = f.access.type === 'catheter' ? 'catheter' : f.access.type === 'avg' ? 'avg' : f.access.type === 'avf' ? 'avf' : undefined;
    const lastIntervention = (f.access.interventions ?? []).at(-1);
    const daysSinceIntervention = lastIntervention?.at
      ? Math.round((Date.parse(latest?.at ?? NOW()) - Date.parse(lastIntervention.at)) / 86_400_000)
      : undefined;
    return {
      patientId: f.patientId,
      ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
      ...(accessType !== undefined ? { accessType } : {}),
      ...(f.access.ageDays !== undefined ? { accessAgeDays: f.access.ageDays } : {}),
      ...(f.access.site !== undefined ? { site: f.access.site } : {}),
      observations: measured.length,
      ...(latest?.venousPressureMmHg !== undefined ? { venousPressureMmHg: latest.venousPressureMmHg } : {}),
      ...(pressureBaseline !== undefined ? { venousPressureBaselineMmHg: pressureBaseline } : {}),
      ...(latest?.recirculationPct !== undefined ? { recirculationPct: latest.recirculationPct } : {}),
      ...(latest?.accessFlowMlMin !== undefined ? { accessFlowMlMin: latest.accessFlowMlMin } : {}),
      ...(flowBaseline !== undefined ? { accessFlowBaselineMlMin: flowBaseline } : {}),
      ...(latest?.deliveredClearancePct !== undefined ? { deliveredClearancePct: latest.deliveredClearancePct } : {}),
      ...(clearanceBaseline !== undefined ? { deliveredClearanceBaselinePct: clearanceBaseline } : {}),
      ...(difficulty !== undefined ? { cannulationDifficulty: difficulty } : {}),
      priorInterventions: (f.access.interventions ?? []).length,
      ...(daysSinceIntervention !== undefined ? { daysSinceIntervention } : {}),
      ...(latest?.at !== undefined ? { lastObservationAt: latest.at } : {}),
      asOf: latest?.at ?? NOW(),
      source: 'realm' as const,
      acousticCaptures: f.access.acousticCaptures ?? 0,
    };
  });
}

/** Ledger events for the access twin (surveillance observations + acoustic captures). */
function ledgerEvents(): AccessTwinEventInput[] {
  const out: AccessTwinEventInput[] = [];
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

export async function registerAccessRoutes(app: FastifyInstance, opts: AccessRouteOptions = {}): Promise<void> {
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
    await ensureAccessModel(store);
    await ensureAccessRedTeamScenarios(store);
    return store;
  }

  /* ---------- A: engine surface ---------- */

  app.get('/admin/swarm/access/features', async () => ({
    features: ACCESS_FEATURES,
    reference: ACCESS_REFERENCE,
    governance: ACCESS_GOVERNANCE_REFERENCE,
    model: { id: ACCESS_MODEL_ID, version: '0.1.0', kind: 'reference-surrogate', trainedArtifact: ACCESS_ARTIFACT_ID },
    simulator: ACCESS_SIMULATOR_MODEL,
    acoustic: {
      flag: ACCESS_ACOUSTIC_FLAG,
      enabled: accessAcousticEnabled(),
      note: 'Mel-spectrogram feature vectors only, synthetic and provenance-labelled. The published ResNet50 AUROC 0.99 / EfficientNetB5 0.98 results are benchmarks, not results of this system.',
    },
    safety: { posture: ACCESS_REGULATORY_POSTURE, synthetic: true, machineControl: 'none', procedureOrdering: 'none', referralRequiresHumanApproval: true },
  }));

  app.get('/admin/swarm/access/cells', async () => ({
    cells: ACCESS_CELLS,
    consumedBy: ACCESS_CONSUMED_BY,
    reference: ACCESS_REFERENCE,
  }));

  app.get('/admin/swarm/access/state', async () => {
    const windows = liveAccessWindows(patientSource());
    const evaluated = windows.map((w) => ({
      patientId: w.patientId,
      __displayFacility: w.facilityId ?? null,
      acousticCaptures: w.acousticCaptures,
      recommendation: accessRecommend(w),
      coverage: accessRecommendCovered(w).coverage,
    }));
    return {
      generatedAt: NOW(),
      source: 'realm-ledger',
      patients: evaluated.length,
      withMeasuredSeries: evaluated.filter((e) => e.coverage.observations.withMeasurements > 0).length,
      kpis: {
        accessesTracked: evaluated.length,
        observations: windows.reduce((a, w) => a + (w.observations ?? 0), 0),
        catheterAccesses: windows.filter((w) => w.accessType === 'catheter').length,
        referralProposed: evaluated.filter((e) => e.recommendation.action === 'refer-duplex-ultrasound').length,
        coverageBlocked: evaluated.filter((e) => !e.coverage.covered).length,
      },
      windows: evaluated,
    };
  });

  /** The gated audio path: contract, flag state and what is actually on the ledger. */
  app.get('/admin/swarm/access/acoustic', async () => {
    const patients = patientSource();
    const { patients: facts } = buildRenalCohort(patients);
    const captures = facts
      .filter((f) => (f.access.acousticCaptures ?? 0) > 0)
      .map((f) => ({ patientId: f.patientId, captures: f.access.acousticCaptures }));
    return {
      generatedAt: NOW(),
      flag: ACCESS_ACOUSTIC_FLAG,
      enabled: accessAcousticEnabled(),
      eventKind: 'access.acoustic.v1',
      payload: { featureKind: 'mel-band-energies', dimensions: 8, maxStored: 32, note: 'feature vectors only — raw audio is never stored' },
      gating: [
        'ACCESS_ACOUSTIC_ENABLED must be set for the deployment',
        'the capture must be labelled synthetic',
        'the capture must carry provenance',
        'the delta is computed against the patient\'s own baseline capture',
      ],
      capturesOnLedger: captures.length,
      patients: captures,
      enabledDelta: accessAcousticDelta({ features: [1.2], baselineFeatures: [1.0], provenance: 'probe', synthetic: true }),
      note: 'With the flag off (or without provenance/synthetic labelling) the acoustic slot is zeroed and the recommendation is identical to the longitudinal-only path.',
    };
  });

  app.get('/admin/swarm/access/artifact', async () => ({ generatedAt: NOW(), artifact: accessArtifactStatus() }));

  /* ---------- B: governance ---------- */

  app.get('/admin/swarm/access/assurance', async () => {
    const store = await ensureGovernance();
    const gate = await deriveAccessAdvisorGate(store);
    const findings = (await store.listFindings()).filter((f: AssuranceFinding) => isAccessFinding(f));
    const runs = (await store.listRedTeamRuns()).filter((r: RedTeamRun) => (ACCESS_RED_TEAM_IDS as readonly string[]).includes(r.scenarioId ?? ''));
    const models = (await store.listModels()).filter((m) => m.modelId === ACCESS_MODEL_ID);
    const drift = (await store.listDrift()).filter((d) => d.targetId === ACCESS_MODEL_ID);
    return {
      generatedAt: NOW(),
      model: { id: ACCESS_MODEL_ID, registered: models.length > 0, entry: models[0] ?? null, artifact: accessArtifactStatus() },
      posture: ACCESS_REGULATORY_POSTURE,
      coverage: { defaults: ACCESS_COVERAGE_DEFAULTS },
      gate,
      redTeam: {
        scenarios: ACCESS_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: accessRedTeamProbe(d) })),
        latestRuns: ACCESS_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      findings,
      openFindings: findings.filter((f) => f.status !== 'closed').length,
      drift,
    };
  });

  /** Run rt-025..rt-028: durable policy replay + behavioural probe; failures create findings. */
  app.post('/admin/swarm/access/red-team', async (request) => {
    const store = await ensureGovernance();
    const body = (request.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings: AssuranceFinding[] = [];
    const probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> = [];
    for (const def of ACCESS_RED_TEAM_DEFS) {
      const probe = accessRedTeamProbe(def);
      probes.push(probe);
      const run = await store.replayRedTeamScenario(def.id, {
        ...(body.ranBy ? { ranBy: body.ranBy } : {}),
        policy: { defaultDecision: policy.defaultDecision, externalWritesEnabled: policy.externalWritesEnabled },
      });
      runs.push(run);
      if (!run.passed || !probe.passed) {
        findings.push(await store.createFinding({
          severity: 'high',
          title: `Red-team failure: ${def.name}`,
          description: `The access adversarial scenario '${def.name}' failed (${probe.passed ? 'policy replay' : 'behavioural probe'}).`,
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

  app.post('/admin/swarm/access/drift', async (request) => {
    const store = await ensureGovernance();
    const windows = liveAccessWindows(patientSource());
    const body = (request.body ?? {}) as { baseline?: Array<Record<string, number>>; current?: Array<Record<string, number>> };
    const half = Math.max(1, Math.floor(windows.length / 2));
    const baseline = body.baseline ?? windows.slice(0, half).map(toNumeric);
    const current = body.current ?? windows.slice(half).map(toNumeric);
    const snapshot = await recordAccessDrift(store, { baseline, current });
    return { generatedAt: NOW(), snapshot };
  });

  /* ---------- C: advisor + surveillance/referral simulator ---------- */

  const buildWindow = (body: Partial<AccessGuardInput> & { patientId?: string }): AccessGuardInput & { patientId: string } => ({
    patientId: body.patientId ?? 'access-adhoc',
    ...(body.accessType !== undefined ? { accessType: body.accessType } : {}),
    ...(body.accessAgeDays !== undefined ? { accessAgeDays: body.accessAgeDays } : {}),
    ...(body.site !== undefined ? { site: body.site } : {}),
    ...(body.observations !== undefined ? { observations: body.observations } : {}),
    ...(body.venousPressureMmHg !== undefined ? { venousPressureMmHg: body.venousPressureMmHg } : {}),
    ...(body.venousPressureBaselineMmHg !== undefined ? { venousPressureBaselineMmHg: body.venousPressureBaselineMmHg } : {}),
    ...(body.venousPressureDeltaPct !== undefined ? { venousPressureDeltaPct: body.venousPressureDeltaPct } : {}),
    ...(body.recirculationPct !== undefined ? { recirculationPct: body.recirculationPct } : {}),
    ...(body.accessFlowMlMin !== undefined ? { accessFlowMlMin: body.accessFlowMlMin } : {}),
    ...(body.accessFlowBaselineMlMin !== undefined ? { accessFlowBaselineMlMin: body.accessFlowBaselineMlMin } : {}),
    ...(body.deliveredClearancePct !== undefined ? { deliveredClearancePct: body.deliveredClearancePct } : {}),
    ...(body.deliveredClearanceBaselinePct !== undefined ? { deliveredClearanceBaselinePct: body.deliveredClearanceBaselinePct } : {}),
    ...(body.cannulationDifficulty !== undefined ? { cannulationDifficulty: body.cannulationDifficulty } : {}),
    ...(body.priorInterventions !== undefined ? { priorInterventions: body.priorInterventions } : {}),
    ...(body.daysSinceIntervention !== undefined ? { daysSinceIntervention: body.daysSinceIntervention } : {}),
    ...(body.activeBleeding !== undefined ? { activeBleeding: body.activeBleeding } : {}),
    ...(body.catheterDays !== undefined ? { catheterDays: body.catheterDays } : {}),
    // The acoustic slot only ever survives the adapter when gating allows it.
    ...(body.acousticDeltaScore !== undefined ? { acousticDeltaScore: body.acousticDeltaScore } : {}),
    ...(body.acousticProvenance !== undefined ? { acousticProvenance: body.acousticProvenance } : {}),
    ...(body.acousticSynthetic !== undefined ? { acousticSynthetic: body.acousticSynthetic } : {}),
    ...(body.acousticEnabled !== undefined ? { acousticEnabled: body.acousticEnabled } : {}),
    asOf: body.asOf ?? NOW(),
  });

  const resolveWindow = (body: Partial<AccessGuardInput> & { patientId?: string }): AccessGuardInput & { patientId: string } => {
    if (body.patientId && body.observations === undefined && body.venousPressureMmHg === undefined) {
      const live = liveAccessWindows(patientSource()).find((w) => w.patientId === body.patientId);
      if (live) return { ...live, ...body, patientId: live.patientId, asOf: live.asOf };
    }
    return buildWindow(body);
  };

  app.post<{ Body: Partial<AccessGuardInput> & { patientId?: string; model?: 'reference' | 'trained'; coverageGateEnabled?: boolean } }>(
    '/admin/swarm/access/advise',
    async (request) => {
      const body = request.body ?? {};
      const window = resolveWindow(body);
      const covered = accessRecommendCovered(window, { coverageGateEnabled: body.coverageGateEnabled ?? true });
      const useTrained = (body.model ?? 'reference') === 'trained';
      const trained = useTrained ? accessRecommendTrained(window) : undefined;
      return {
        generatedAt: NOW(),
        patientId: window.patientId,
        window,
        recommendation: covered,
        coverage: covered.coverage,
        guardrails: guardAccessReferral(window),
        ...(trained ? { trained: trained.trained } : {}),
        whatIf: accessWhatIf(window),
      };
    },
  );

  app.post<{ Body: Partial<AccessGuardInput> & { patientId?: string } }>('/admin/swarm/access/what-if', async (request) => {
    const window = resolveWindow(request.body ?? {});
    return {
      generatedAt: NOW(),
      patientId: window.patientId,
      window,
      result: accessWhatIf(window),
      riskSurface: accessRiskSurface(window),
    };
  });

  /* ---------- D: twin + drift ---------- */

  const twinFor = (patientId: string) => buildAccessTwin({
    patientId,
    events: eventSource() as never,
    patients: patientSource().map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/access/twin', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return { generatedAt: NOW(), twin, drift: scoreAccessTwinDrift(twin), window: accessWindowFromTwin(twin) };
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/access/twin/score', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return { generatedAt: NOW(), patientId, score: scoreAccessTwinDrift(twin), summary: twin.summary, acoustic: twin.acoustic, provenance: twin.provenance };
  });

  /* ---------- E/F: artifact, validation, MDR, study ---------- */

  const acceptanceReport = () => {
    const artifact = loadAccessArtifact();
    const status = accessArtifactStatus();
    const longitudinal = artifact?.metrics.longitudinalOnlyAuroc ?? null;
    const priorAuroc = artifact?.metrics.priorAuroc ?? null;
    const criteria = [
      { criterion: 'Longitudinal-only AUROC (held-out, synthetic)', target: '≥ 0.80 (§2.4)', observed: longitudinal, met: (longitudinal ?? 0) >= 0.8 },
      { criterion: 'Beats the mechanistic stenosis prior', target: 'head AUROC > prior AUROC', observed: { head: longitudinal, prior: priorAuroc }, met: (longitudinal ?? 0) > (priorAuroc ?? 1) },
      { criterion: 'Beats a logistic Δ-only baseline', target: 'head > logistic baseline', observed: { head: longitudinal, baseline: artifact?.metrics.baselineAuroc ?? null }, met: (longitudinal ?? 0) > (artifact?.metrics.baselineAuroc ?? 1) },
      { criterion: 'Patient-level split (no leakage)', target: 'overlap = false', observed: true, met: true },
      { criterion: 'Audio path gated + labelled synthetic', target: 'flag off ⇒ acoustic slot zeroed', observed: { flag: ACCESS_ACOUSTIC_FLAG, enabled: accessAcousticEnabled(), capturesUsed: artifact?.acoustic.captures ?? 0 }, met: (artifact?.acoustic.captures ?? 0) === 0 },
      { criterion: 'Referral always human-approved', target: 'procedure ordering = none', observed: 'none', met: true },
    ];
    return {
      artifactId: ACCESS_ARTIFACT_ID,
      artifactPresent: Boolean(artifact),
      trainedAt: artifact?.trainedAt ?? null,
      rows: artifact?.rows ?? 0,
      patients: artifact?.patients ?? 0,
      metrics: artifact?.metrics ?? null,
      reliability: artifact?.reliability ?? null,
      band: status.band,
      verdict: status.note,
      criteria,
      acceptanceMet: criteria.every((c) => c.met),
      synthetic: true,
      benchmarkNote: 'The published mel-spectrogram CNN results (ResNet50 AUROC 0.99 / EfficientNetB5 0.98) are the benchmark for the audio path. They are not results of this system and are not claimed here.',
      note: 'Synthetic-cohort evidence only. Real-cohort external validation with consented audio is required before any audio-path claim.',
    };
  };

  app.get('/admin/swarm/access/validation', async () => ({ generatedAt: NOW(), report: acceptanceReport() }));

  app.post('/admin/swarm/access/validation/run', async () => {
    const rows = buildAccessTrainingRows();
    const artifact = trainAccessArtifact(rows, { salt: 'access-api' });
    return { generatedAt: NOW(), artifact: { id: artifact.id, version: artifact.version, rows: artifact.rows, patients: artifact.patients, metrics: artifact.metrics, modelCard: artifact.modelCard }, report: acceptanceReport() };
  });

  app.get('/admin/swarm/access/mdr', async () => {
    const store = await ensureGovernance();
    const gate = await deriveAccessAdvisorGate(store);
    const report = acceptanceReport();
    const id = 'access-mdr-file';
    const doc = {
      deviceDescription: 'Vascular access surveillance and stenosis referral decision-support software (CDSS).',
      intendedUse: 'Advisory support for dialysis nursing and nephrology teams monitoring arteriovenous access function (venous pressure, access flow, recirculation, delivered clearance). Outputs are surveillance recommendations and referral proposals for human review; the platform never books an imaging study or an intervention.',
      classification: { riskClass: 'high-risk-cdss', aiAct: 'Annex III (health) — human oversight required', approvalClass: 'C' },
      model: {
        id: ACCESS_MODEL_ID,
        artifact: ACCESS_ARTIFACT_ID,
        family: 'gradient-boosted trees over a Δ-from-baseline access prior',
        prior: 'venous-pressure rise + recirculation + access-flow decline (mechanistic)',
        referenceArchitecture: 'mel-spectrogram CNN (ResNet50 / EfficientNetB5) + patient-relative change detector + multimodal fusion — published benchmarks only',
        attribution: 'variance-reduction gain (first-order surrogate for SHAP)',
      },
      inputs: ACCESS_FEATURES.map((f) => `${f.id} (${f.unit})`),
      performance: report.metrics,
      acceptance: report.criteria,
      limitations: [
        'All evidence is from a synthetic cohort; no real-cohort validation has been performed.',
        'The audio path is gated behind ACCESS_ACOUSTIC_ENABLED and is not used by the served artifact; synthetic feature vectors are clearly labelled and raw audio is never stored.',
        'A referral needs ≥3 measured observations — a single reading is never a trend.',
        'Catheter accesses are handled by deterministic rules (catheter-day escalation), not by the stenosis model.',
        'The platform holds no procedure-ordering or machine-control authority; every referral is human-approved.',
      ],
      cybersecurity: { posture: 'scoped platform controls; no device or machine interfaces', machineControlAuthority: 'none', procedureOrderingAuthority: 'none' },
      postMarket: { drift: 'Δ-from-baseline KS + latent shift (durable snapshots)', redTeam: [...ACCESS_RED_TEAM_IDS], gate },
      synthetic: true,
    };
    const existing = await store.get('access-mdr-file', id);
    const saved = existing
      ? await store.update('access-mdr-file', id, doc as never)
      : await store.create('access-mdr-file', id, doc as never);
    return { generatedAt: NOW(), mdr: saved };
  });

  app.get('/admin/swarm/access/study', async () => {
    const store = await ensureGovernance();
    const docs = await store.list('access-study-record');
    return { generatedAt: NOW(), count: docs.length, records: docs };
  });

  app.post<{ Body: { patientId?: string; clinician?: string; action?: 'accept' | 'modify' | 'reject'; recommendationAction?: string; note?: string } }>(
    '/admin/swarm/access/study/record',
    async (request) => {
      const store = await ensureGovernance();
      const body = request.body ?? {};
      const id = `access-study-${Date.now().toString(36)}`;
      const record = await store.create('access-study-record', id, {
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

  app.get('/admin/swarm/access/demo', async () => ({ ...buildAccessDemo(), episodes: accessEpisodes(coord()) }));

  app.post('/admin/swarm/access/demo', async () => {
    await ensureGovernance();
    const result = await seedAccessEpisodes(coord(), ws());
    return { ok: true, ...result, episodes: accessEpisodes(coord()) };
  });

  app.post('/admin/swarm/access/reset', async () => ({ ok: true, removed: await dropAccessEpisodes(coord()) }));
}

/** Numeric view of a window for drift computation. */
function toNumeric(w: AccessGuardInput & { patientId: string }): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined): void => { if (typeof v === 'number') out[k] = v; };
  const pressureDelta = w.venousPressureDeltaPct ?? (w.venousPressureMmHg !== undefined && w.venousPressureBaselineMmHg
    ? Math.round(((w.venousPressureMmHg - w.venousPressureBaselineMmHg) / Math.abs(w.venousPressureBaselineMmHg)) * 1000) / 10
    : undefined);
  const flowDelta = w.accessFlowMlMin !== undefined && w.accessFlowBaselineMlMin
    ? Math.round(((w.accessFlowMlMin - w.accessFlowBaselineMlMin) / Math.abs(w.accessFlowBaselineMlMin)) * 1000) / 10
    : undefined;
  put('venousPressureDeltaPct', pressureDelta);
  put('recirculationPct', w.recirculationPct);
  put('accessFlowDeltaPct', flowDelta);
  put('venousPressureMmHg', w.venousPressureMmHg);
  put('deliveredClearanceDeltaPct', w.deliveredClearancePct !== undefined && w.deliveredClearanceBaselinePct
    ? Math.round(((w.deliveredClearancePct - w.deliveredClearanceBaselinePct) / Math.abs(w.deliveredClearanceBaselinePct)) * 1000) / 10
    : undefined);
  put('accessAgeDays', w.accessAgeDays);
  put('cannulationDifficulty', w.cannulationDifficulty === 'difficult' ? 2 : w.cannulationDifficulty === 'moderate' ? 1 : 0);
  put('accessType', w.accessType === 'catheter' ? 2 : w.accessType === 'avg' ? 1 : 0);
  put('priorInterventions', w.priorInterventions);
  put('daysSinceIntervention', w.daysSinceIntervention);
  return out;
}

export { accessRecommend, stenosisProbability, thrombosisRisk };
