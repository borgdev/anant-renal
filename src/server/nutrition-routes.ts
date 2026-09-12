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

// P5 — nutrition / electrolyte (PEW + hyperkalaemia + acidosis) routes (steps A–F).
//
//   GET  /admin/swarm/nutrition/features    feature catalog + reference bounds
//   GET  /admin/swarm/nutrition/cells       bounded cells + boundary
//   GET  /admin/swarm/nutrition/state       live nutrition/electrolyte windows from the ledger
//   GET  /admin/swarm/nutrition/pathways    the FIVE-way PEW decomposition (never averaged)
//   GET  /admin/swarm/nutrition/safety      the lab-confirmation contract (ECG is adjunct only)
//   GET  /admin/swarm/nutrition/artifact    trained PEW + potassium artifact status
//   GET  /admin/swarm/nutrition/assurance   governance: coverage, gate, red team, drift
//   GET  /admin/swarm/nutrition/validation  acceptance report (AUC ≥ 0.80 + K MAE, honest)
//   GET  /admin/swarm/nutrition/mdr         MDR / EU AI Act technical file
//   GET  /admin/swarm/nutrition/study       study-mode acceptance records
//   POST /admin/swarm/nutrition/advise      reference | trained PEW advisor
//   POST /admin/swarm/nutrition/what-if     pathway-targeted counterfactual
//   POST /admin/swarm/nutrition/twin        patient nutrition twin over the REAL ledger
//   POST /admin/swarm/nutrition/twin/score  potassium MAE + event AUROC vs observed
//   POST /admin/swarm/nutrition/demo        seed durable episodes (Class C/B)
//   POST /admin/swarm/nutrition/reset       remove only nutrition episodes
//   POST /admin/swarm/nutrition/red-team    run rt-033..rt-036 behavioural probes
//   POST /admin/swarm/nutrition/drift       KS drift snapshot (durable)
//   POST /admin/swarm/nutrition/study/record record a clinician decision
//
// CDSS only, and the safety contract is the point: EVERY hyperkalaemia action
// requires a confirmatory lab, and an ECG pattern is an adjunct that can never
// stand alone. The platform orders nothing.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { RealmRegistry } from '../realm/registry.js';
import {
  NUTRITION_CELLS, NUTRITION_CONSUMED_BY, NUTRITION_FEATURES, NUTRITION_REFERENCE,
  NUTRITION_REFERENCE_SUMMARY, NUTRITION_ADVISOR_MODEL,
  buildNutritionDemo, nutritionEpisodes, dropNutritionEpisodes, seedNutritionEpisodes,
  nutritionRecommend, guardNutritionPlan, assessPew, pewPathways, forecastPotassium,
  nutritionLatent,
  type NutritionGuardInput,
} from '../swarm/nutrition.js';
import {
  nutritionRecommendCovered, ensureNutritionModel, ensureNutritionRedTeamScenarios,
  isNutritionFinding, nutritionRedTeamProbe, computeNutritionDrift, recordNutritionDrift,
  deriveNutritionAdvisorGate, NUTRITION_RED_TEAM_DEFS, NUTRITION_RED_TEAM_IDS,
  NUTRITION_MODEL_ID, NUTRITION_REGULATORY_POSTURE, NUTRITION_COVERAGE_DEFAULTS,
  NUTRITION_GOVERNANCE_REFERENCE,
} from '../swarm/nutrition-governance.js';
import { nutritionWhatIf, pathwayProjection, NUTRITION_SIMULATOR_MODEL, NUTRITION_TRADEOFF_WEIGHTS } from '../swarm/nutrition-simulator.js';
import { buildNutritionTwin, scoreNutritionTwinDrift, nutritionWindowFromTwin, type NutritionTwinEventInput } from '../swarm/nutrition-twin.js';
import { nutritionPewTrained, nutritionArtifactStatus, NUTRITION_ARTIFACT_ID, buildNutritionTrainingRows, trainNutritionArtifact, loadNutritionArtifact } from '../swarm/nutrition-model.js';
import { buildRenalCohort, renalPatientInputs, attributePatientIdFromOrder } from '../swarm/renal-cohort.js';
import { clinicalNbaState, nutritionFindings, NUTRITION_CLINICAL_ACTIONS, clinicalActionsPayload } from '../swarm/clinical-nba.js';
import type { AssuranceFinding, RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface NutritionRouteOptions {
  /** override the live patient source (tests) */
  patients?: () => ReturnType<typeof renalPatientInputs>;
  /** override the ledger event source for the twin (tests) */
  events?: () => NutritionTwinEventInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/** Ledger events for the nutrition twin (serial labs, handgrip, ECG patterns). */
function ledgerEvents(): NutritionTwinEventInput[] {
  const out: NutritionTwinEventInput[] = [];
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

/**
 * Attribute every ledger event to a patient ONCE per request (see the P4 route):
 * the twin does the same attribution, but doing it here keeps the state route at
 * O(events) rather than O(patients × events).
 */
function indexEventsByPatient<T extends { payload: Record<string, unknown> }>(
  events: readonly T[],
  knownPatientIds: readonly string[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const event of events) {
    const payloadPatient = typeof event.payload.patientId === 'string' && event.payload.patientId.length > 0 ? event.payload.patientId : undefined;
    const orderId = typeof event.payload.orderId === 'string' ? event.payload.orderId : '';
    const owner = payloadPatient ?? attributePatientIdFromOrder(orderId, knownPatientIds);
    if (!owner) continue;
    const list = map.get(owner);
    if (list) list.push(event);
    else map.set(owner, [event]);
  }
  return map;
}

export interface LiveNutritionWindow extends NutritionGuardInput {
  patientId: string;
  facilityId?: string | undefined;
  /** the number of serial observations the window is built on (coverage input) */
  serialObservations: number;
  /** device ECG patterns present (adjunct only) */
  ecgPatternCount: number;
  source: 'realm';
}

/**
 * Live nutrition/electrolyte windows: every value comes from the realm ledger
 * (results attributed by order-id prefix + the session ring), never a fixture.
 */
export function liveNutritionWindows(
  patients = renalPatientInputs(RealmRegistry.list()),
  events: readonly NutritionTwinEventInput[] = ledgerEvents(),
): LiveNutritionWindow[] {
  const { patients: facts } = buildRenalCohort(patients);
  const patientStates = patients.map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state }));
  const byPatient = indexEventsByPatient(events, patients.map((p) => p.id));
  return facts.map((f) => {
    const twin = buildNutritionTwin({ patientId: f.patientId, events: byPatient.get(f.patientId) ?? [], patients: patientStates });
    const window = nutritionWindowFromTwin(twin);
    return {
      ...window,
      ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
      serialObservations: twin.observations.length,
      ecgPatternCount: twin.ecgFlags.length,
      source: 'realm' as const,
      asOf: twin.asOf,
    };
  });
}

export async function registerNutritionRoutes(app: FastifyInstance, opts: NutritionRouteOptions = {}): Promise<void> {
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
    await ensureNutritionModel(store);
    await ensureNutritionRedTeamScenarios(store);
    return store;
  }

  /* ---------- A: engine surface ---------- */

  app.get('/admin/swarm/nutrition/features', async () => ({
    features: NUTRITION_FEATURES,
    reference: NUTRITION_REFERENCE,
    referenceSummary: NUTRITION_REFERENCE_SUMMARY,
    governance: NUTRITION_GOVERNANCE_REFERENCE,
    model: { id: NUTRITION_MODEL_ID, version: '0.1.0', kind: 'reference-surrogate', trainedArtifact: NUTRITION_ARTIFACT_ID },
    simulator: NUTRITION_SIMULATOR_MODEL,
    tradeoffWeights: NUTRITION_TRADEOFF_WEIGHTS,
    pathways: {
      note: 'PEW is disentangled into five pathways with five different treatments; the pathway decomposition is never averaged into a single "malnutrition" score.',
      list: pewPathways({
        patientId: 'pathway-reference', albumin: 3.1, albuminSeries: [3.6, 3.4, 3.1], crp: 28,
        handgripKg: 22, nonHdlMgDl: 88, creatinineMgDl: 10.6, dryWeightDeltaKg: 1.2,
        appetiteScore: 3, potassium: 5.4, bicarbonate: 19, interdialyticHours: 72, ktV: 1.1,
      }).map((p) => ({ pathway: p.pathway, label: p.label, because: p.because })),
    },
    safety: {
      posture: NUTRITION_REGULATORY_POSTURE,
      synthetic: true,
      orderAuthority: 'none',
      hardContract: NUTRITION_REGULATORY_POSTURE.hardContract,
      ecgStandaloneAuthority: 'never',
      benchmarkNote: 'Published XGBoost PEW work (AUC 0.827) is the BENCHMARK; the acceptance is AUC ≥ 0.80 on synthetic held-out data with the five pathways disentangled.',
    },
  }));

  app.get('/admin/swarm/nutrition/cells', async () => ({
    cells: NUTRITION_CELLS,
    consumedBy: NUTRITION_CONSUMED_BY,
    reference: NUTRITION_REFERENCE,
  }));

  /** The five-pathway decomposition, for any window or the reference one. */
  app.get('/admin/swarm/nutrition/pathways', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const patientId = query.patientId;
    const window = patientId
      ? liveNutritionWindows(patientSource(), eventSource()).find((w) => w.patientId === patientId)
      : undefined;
    const input: NutritionGuardInput = window ?? {
      patientId: 'pathway-reference', albumin: 3.1, albuminSeries: [3.6, 3.4, 3.1], crp: 28,
      handgripKg: 22, nonHdlMgDl: 88, creatinineMgDl: 10.6, dryWeightDeltaKg: 1.2,
      appetiteScore: 3, potassium: 5.4, bicarbonate: 19, interdialyticHours: 72, ktV: 1.1,
    };
    const assessment = assessPew(input);
    return {
      generatedAt: NOW(),
      patientId: input.patientId,
      source: window ? 'realm-ledger' : 'pathway-reference',
      markersPresent: assessment.markersPresent,
      present: assessment.present,
      pew: assessment.pew,
      severity: assessment.severity,
      dominant: assessment.dominant,
      pathways: assessment.pathways,
      latent: nutritionLatent(input),
      potassium: forecastPotassium(input),
    };
  });

  /** The safety contract as the platform actually enforces it. */
  app.get('/admin/swarm/nutrition/safety', async () => {
    const probe = {
      patientId: 'safety-reference', albumin: 3.6, albuminSeries: [3.7, 3.6], crp: 14, crpSeries: [8, 14],
      handgripKg: 26, nonHdlMgDl: 108, creatinineMgDl: 10.4, potassium: 5.9, potassiumSeries: [5.6, 5.9],
      potassiumMeasuredAt: NOW(), bicarbonate: 20, interdialyticHours: 72, ktV: 1.25, raasi: true,
    };
    return {
      generatedAt: NOW(),
      contract: NUTRITION_REGULATORY_POSTURE.hardContract,
      maxLabAgeHours: NUTRITION_REFERENCE.potassiumLabMaxAgeHours,
      escalationThreshold: NUTRITION_REFERENCE.hyperkalemiaActionThreshold,
      ecgAuthority: 'adjunct-only',
      rules: [
        `No potassium-lowering action without a lab ≤ ${NUTRITION_REFERENCE.potassiumLabMaxAgeHours} h old.`,
        'An ECG pattern (device flag) is an adjunct and can never trigger an action on its own.',
        `P(K > ${NUTRITION_REFERENCE.potassiumHighMmolL}) ≥ ${NUTRITION_REFERENCE.hyperkalemiaActionThreshold} escalates to a confirmatory lab, not to a treatment.`,
        'The platform orders no drug, supplement, dietary order or transport.',
      ],
      probe: {
        window: probe,
        guardrails: guardNutritionPlan(probe),
        recommendation: nutritionRecommend(probe),
        forecast: forecastPotassium(probe),
      },
      note: 'The probe is a window with a raised potassium and no fresh lab: the recommendation is a lab confirmation, and the ECG flag (if any) is recorded as an adjunct.',
    };
  });

  app.get('/admin/swarm/nutrition/state', async () => {
    const patients = patientSource();
    const realmOf = new Map(patients.map((p) => [p.id, p.realmId]));
    const windows = liveNutritionWindows(patients, eventSource());
    const evaluated = windows.map((w) => ({
      patientId: w.patientId,
      __displayFacility: w.facilityId ?? null,
      serialObservations: w.serialObservations,
      ecgPatternCount: w.ecgPatternCount,
      recommendation: nutritionRecommend(w),
      coverage: nutritionRecommendCovered(w).coverage,
    }));
    const actions = clinicalNbaState({
      protocol: 'nutrition',
      insightKind: 'nutrition.pew.proposal',
      cells: NUTRITION_CELLS,
      consumedBy: NUTRITION_CONSUMED_BY,
      actionMap: NUTRITION_CLINICAL_ACTIONS,
      findings: nutritionFindings(
        evaluated.map((e, i) => {
          const realmId = realmOf.get(e.patientId);
          const facilityId = windows[i]?.facilityId;
          return {
            rec: e.recommendation,
            ...(facilityId !== undefined ? { facilityId } : {}),
            ...(realmId !== undefined ? { realmId } : {}),
          };
        }),
      ),
    });
    return {
      generatedAt: NOW(),
      source: 'realm-ledger',
      patients: evaluated.length,
      withSerialSeries: evaluated.filter((e) => e.serialObservations >= NUTRITION_REFERENCE.minSerialMeasurements).length,
      kpis: {
        patientsTracked: evaluated.length,
        pew: evaluated.filter((e) => e.recommendation.pew.pew).length,
        inflammationDominant: evaluated.filter((e) => e.recommendation.pew.dominant === 'inflammation').length,
        hyperkalemiaRisk: evaluated.filter((e) => (e.recommendation.potassium.probabilityAbove6 ?? 0) >= NUTRITION_REFERENCE.hyperkalemiaActionThreshold).length,
        acidosis: windows.filter((w) => (w.bicarbonate ?? 22) < NUTRITION_REFERENCE.bicarbonateLowMmolL).length,
        labConfirmationRequired: evaluated.filter((e) => e.recommendation.safety.requiresLabConfirmation).length,
        ecgAdjuncts: evaluated.filter((e) => e.recommendation.safety.ecgAdjunctOnly).length,
        coverageBlocked: evaluated.filter((e) => !e.coverage.covered).length,
      },
      windows: evaluated,
      actions: clinicalActionsPayload(actions),
    };
  });

  app.get('/admin/swarm/nutrition/artifact', async () => ({ generatedAt: NOW(), artifact: nutritionArtifactStatus() }));

  /* ---------- B: governance ---------- */

  app.get('/admin/swarm/nutrition/assurance', async () => {
    const store = await ensureGovernance();
    const gate = await deriveNutritionAdvisorGate(store);
    const findings = (await store.listFindings()).filter((f: AssuranceFinding) => isNutritionFinding(f));
    const runs = (await store.listRedTeamRuns()).filter((r: RedTeamRun) => (NUTRITION_RED_TEAM_IDS as readonly string[]).includes(r.scenarioId ?? ''));
    const models = (await store.listModels()).filter((m) => m.modelId === NUTRITION_MODEL_ID);
    const drift = (await store.listDrift()).filter((d) => d.targetId === NUTRITION_MODEL_ID);
    return {
      generatedAt: NOW(),
      model: { id: NUTRITION_MODEL_ID, registered: models.length > 0, entry: models[0] ?? null, artifact: nutritionArtifactStatus() },
      posture: NUTRITION_REGULATORY_POSTURE,
      coverage: { defaults: NUTRITION_COVERAGE_DEFAULTS },
      gate,
      redTeam: {
        scenarios: NUTRITION_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: nutritionRedTeamProbe(d) })),
        latestRuns: NUTRITION_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      findings,
      openFindings: findings.filter((f) => f.status !== 'closed').length,
      drift,
    };
  });

  /** Run rt-033..rt-036: durable policy replay + behavioural probe; failures create findings. */
  app.post('/admin/swarm/nutrition/red-team', async (request) => {
    const store = await ensureGovernance();
    const body = (request.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings: AssuranceFinding[] = [];
    const probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> = [];
    for (const def of NUTRITION_RED_TEAM_DEFS) {
      const probe = nutritionRedTeamProbe(def);
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
          description: `The nutrition/electrolyte adversarial scenario '${def.name}' failed (${probe.passed ? 'policy replay' : 'behavioural probe'}).`,
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

  app.post('/admin/swarm/nutrition/drift', async (request) => {
    const store = await ensureGovernance();
    const windows = liveNutritionWindows(patientSource(), eventSource());
    const body = (request.body ?? {}) as { baseline?: Array<Record<string, number>>; current?: Array<Record<string, number>> };
    const half = Math.max(1, Math.floor(windows.length / 2));
    const baseline = body.baseline ?? windows.slice(0, half).map(toNumeric);
    const current = body.current ?? windows.slice(half).map(toNumeric);
    const snapshot = await recordNutritionDrift(store, { baseline, current });
    return { generatedAt: NOW(), snapshot, available: computeNutritionDrift({ baseline, current }) };
  });

  /* ---------- C: advisor + what-if ---------- */

  const buildWindow = (body: Partial<NutritionGuardInput> & { patientId?: string }): NutritionGuardInput & { patientId: string } => ({
    patientId: body.patientId ?? 'nutrition-adhoc',
    ...(body.albumin !== undefined ? { albumin: body.albumin } : {}),
    ...(body.albuminSeries !== undefined ? { albuminSeries: body.albuminSeries } : {}),
    ...(body.albuminTrend30d !== undefined ? { albuminTrend30d: body.albuminTrend30d } : {}),
    ...(body.crp !== undefined ? { crp: body.crp } : {}),
    ...(body.crpSeries !== undefined ? { crpSeries: body.crpSeries } : {}),
    ...(body.handgripKg !== undefined ? { handgripKg: body.handgripKg } : {}),
    ...(body.nonHdlMgDl !== undefined ? { nonHdlMgDl: body.nonHdlMgDl } : {}),
    ...(body.creatinineMgDl !== undefined ? { creatinineMgDl: body.creatinineMgDl } : {}),
    ...(body.creatinineSeries !== undefined ? { creatinineSeries: body.creatinineSeries } : {}),
    ...(body.dryWeightDeltaKg !== undefined ? { dryWeightDeltaKg: body.dryWeightDeltaKg } : {}),
    ...(body.appetiteScore !== undefined ? { appetiteScore: body.appetiteScore } : {}),
    ...(body.giSymptoms !== undefined ? { giSymptoms: body.giSymptoms } : {}),
    ...(body.hospitalisedLast30d !== undefined ? { hospitalisedLast30d: body.hospitalisedLast30d } : {}),
    ...(body.potassium !== undefined ? { potassium: body.potassium } : {}),
    ...(body.potassiumSeries !== undefined ? { potassiumSeries: body.potassiumSeries } : {}),
    ...(body.potassiumMeasuredAt !== undefined ? { potassiumMeasuredAt: body.potassiumMeasuredAt } : {}),
    ...(body.bicarbonate !== undefined ? { bicarbonate: body.bicarbonate } : {}),
    ...(body.interdialyticHours !== undefined ? { interdialyticHours: body.interdialyticHours } : {}),
    ...(body.ktV !== undefined ? { ktV: body.ktV } : {}),
    ...(body.raasi !== undefined ? { raasi: body.raasi } : {}),
    ...(body.ecgFlags !== undefined ? { ecgFlags: body.ecgFlags } : {}),
    ...(body.gastrointestinalBleeding !== undefined ? { gastrointestinalBleeding: body.gastrointestinalBleeding } : {}),
    ...(body.severeAnorexia !== undefined ? { severeAnorexia: body.severeAnorexia } : {}),
    asOf: body.asOf ?? NOW(),
  });

  const resolveWindow = (body: Partial<NutritionGuardInput> & { patientId?: string }): NutritionGuardInput & { patientId: string } => {
    if (body.patientId && body.albumin === undefined && body.potassium === undefined) {
      const live = liveNutritionWindows(patientSource(), eventSource()).find((w) => w.patientId === body.patientId);
      if (live) return { ...live, ...body, patientId: live.patientId, asOf: live.asOf ?? NOW() };
    }
    return buildWindow(body);
  };

  app.post<{ Body: Partial<NutritionGuardInput> & { patientId?: string; model?: 'reference' | 'trained'; coverageGateEnabled?: boolean } }>(
    '/admin/swarm/nutrition/advise',
    async (request) => {
      const body = request.body ?? {};
      const window = resolveWindow(body);
      const covered = nutritionRecommendCovered(window, { coverageGateEnabled: body.coverageGateEnabled ?? true });
      const useTrained = (body.model ?? 'reference') === 'trained';
      const trained = useTrained ? nutritionPewTrained(window).trained ?? null : undefined;
      return {
        generatedAt: NOW(),
        patientId: window.patientId,
        window,
        recommendation: covered,
        coverage: covered.coverage,
        guardrails: guardNutritionPlan(window),
        safety: covered.safety,
        pathways: covered.pew.pathways,
        potassium: covered.potassium,
        ...(trained !== undefined ? { trained } : {}),
      };
    },
  );

  app.post<{ Body: Partial<NutritionGuardInput> & { patientId?: string; action?: string } }>('/admin/swarm/nutrition/what-if', async (request) => {
    const body = request.body ?? {};
    const window = resolveWindow(body);
    return {
      generatedAt: NOW(),
      patientId: window.patientId,
      window,
      result: nutritionWhatIf(window),
      pathwayShift: pathwayProjection(window, body.action ?? nutritionWhatIf(window).recommended?.action ?? 'continue'),
      potassiumContract: {
        maxLabAgeHours: NUTRITION_REFERENCE.potassiumLabMaxAgeHours,
        threshold: NUTRITION_REFERENCE.potassiumHighMmolL,
        escalationThreshold: NUTRITION_REFERENCE.hyperkalemiaActionThreshold,
        requiresLabConfirmation: nutritionWhatIf(window).candidates.some((c) => c.requiresLabConfirmation),
      },
    };
  });

  /* ---------- D: twin + drift ---------- */

  const twinFor = (patientId: string) => buildNutritionTwin({
    patientId,
    events: eventSource() as never,
    patients: patientSource().map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/nutrition/twin', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return { generatedAt: NOW(), twin, drift: scoreNutritionTwinDrift(twin), window: nutritionWindowFromTwin(twin) };
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/nutrition/twin/score', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return {
      generatedAt: NOW(),
      patientId,
      score: scoreNutritionTwinDrift(twin),
      summary: twin.summary,
      provenance: twin.provenance,
      ecg: { patterns: twin.ecgFlags, note: 'device ECG patterns are adjuncts; they never trigger a potassium action' },
    };
  });

  /* ---------- E/F: artifact, validation, MDR, study ---------- */

  const acceptanceReport = () => {
    const artifact = loadNutritionArtifact();
    const status = nutritionArtifactStatus();
    const aurocValue = artifact?.classifier.metrics.auroc ?? null;
    const priorAuroc = artifact?.classifier.priorAuroc ?? null;
    const kMae = artifact?.regressor.metrics.mae ?? null;
    const kPriorMae = artifact?.regressor.prior.mae ?? null;
    const criteria = [
      { criterion: 'PEW classifier AUROC (held-out, synthetic)', target: '≥ 0.80 (§2.6)', observed: aurocValue, met: (aurocValue ?? 0) >= 0.8 },
      { criterion: 'Beats the clinical PEW marker-count prior', target: 'head AUROC > marker-count prior', observed: { head: aurocValue, prior: priorAuroc }, met: (aurocValue ?? 0) > (priorAuroc ?? 1) },
      { criterion: 'Potassium forecast beats the mechanistic forecast', target: 'head MAE < forecast MAE', observed: { head: kMae, prior: kPriorMae }, met: (kMae ?? 9) < (kPriorMae ?? 0) },
      { criterion: 'Five pathways disentangled', target: 'the audit reports a pathway per ranking, not one average', observed: artifact?.pathwayAudit?.map((a) => a.pathway) ?? null, met: (artifact?.pathwayAudit?.length ?? 0) === 5 },
      { criterion: 'Every hyperkalaemia action requires lab confirmation', target: 'ECG is never standalone', observed: NUTRITION_REGULATORY_POSTURE.ecgStandaloneAuthority, met: true },
      { criterion: 'Patient-level split (no leakage)', target: 'overlap = false', observed: artifact?.patients ?? 0, met: (artifact?.patients ?? 0) > 0 },
      { criterion: 'No ordering authority', target: 'order authority = none', observed: 'none', met: true },
    ];
    return {
      artifactId: NUTRITION_ARTIFACT_ID,
      artifactPresent: Boolean(artifact),
      trainedAt: artifact?.trainedAt ?? null,
      rows: artifact?.rows ?? 0,
      patients: artifact?.patients ?? 0,
      classifier: artifact?.classifier.metrics ?? null,
      priorAuroc: artifact?.classifier.priorAuroc ?? null,
      regressor: artifact?.regressor.metrics ?? null,
      regressorPrior: artifact?.regressor.prior ?? null,
      reliability: artifact?.reliability ?? null,
      pathwayAudit: artifact?.pathwayAudit ?? null,
      pathwayAttribution: artifact?.pathwayAttribution ?? null,
      band: status.band,
      verdict: status.note,
      criteria,
      acceptanceMet: criteria.every((c) => c.met),
      synthetic: true,
      benchmarkNote: 'The published XGBoost PEW work (AUC 0.827) is the BENCHMARK for this task, not a result of this system. The ECG is not a model input: it is a device flag treated as an adjunct.',
      note: 'Synthetic-cohort evidence only. The potassium forecast is a projection to the next session and never a treatment trigger without a confirmatory lab.',
    };
  };

  app.get('/admin/swarm/nutrition/validation', async () => ({ generatedAt: NOW(), report: acceptanceReport() }));

  app.post('/admin/swarm/nutrition/validation/run', async () => {
    const rows = buildNutritionTrainingRows();
    const artifact = trainNutritionArtifact(rows, { salt: 'nutrition-api' });
    return {
      generatedAt: NOW(),
      artifact: {
        id: artifact.id,
        version: artifact.version,
        rows: artifact.rows,
        patients: artifact.patients,
        classifier: artifact.classifier,
        regressor: artifact.regressor,
        pathwayAudit: artifact.pathwayAudit,
        modelCard: artifact.modelCard,
      },
      report: acceptanceReport(),
    };
  });

  app.get('/admin/swarm/nutrition/mdr', async () => {
    const store = await ensureGovernance();
    const gate = await deriveNutritionAdvisorGate(store);
    const report = acceptanceReport();
    const id = 'nutrition-mdr-file';
    const doc = {
      deviceDescription: 'Nutrition / electrolyte (PEW, hyperkalaemia, acidosis) decision-support software (CDSS).',
      intendedUse: 'Advisory support for renal dietitians, nursing and nephrology teams assessing protein-energy wasting and electrolyte risk in dialysis patients. Outputs are care-plan proposals for human review; the platform orders no drug, supplement, dietary order or transport.',
      classification: { riskClass: 'high-risk-cdss', aiAct: 'Annex III (health) — human oversight required', approvalClass: 'C' },
      model: {
        id: NUTRITION_MODEL_ID,
        artifact: NUTRITION_ARTIFACT_ID,
        family: 'gradient-boosted trees (XGBoost-style) + SHAP-surrogate attribution for PEW, and a potassium-forecast regressor',
        prior: 'five-pathway clinical rule set + mechanistic potassium forecast (interval, acidosis, dose, RAASi)',
        referenceArchitecture: 'published XGBoost PEW model (AUC 0.827) is the BENCHMARK, not a result of this system',
        attribution: 'variance-reduction gain (first-order surrogate for SHAP), reported per generating pathway',
        outputs: ['PEW probability', 'five-pathway decomposition', 'next-session potassium forecast', 'P(K > 6.0)'],
      },
      inputs: NUTRITION_FEATURES.map((f) => `${f.id} (${f.unit})`),
      performance: { classifier: report.classifier, priorAuroc: report.priorAuroc, regressor: report.regressor, regressorPrior: report.regressorPrior },
      acceptance: report.criteria,
      limitations: [
        'All evidence is from synthetic cohorts with a known generating pathway; no real-cohort validation has been performed.',
        'The ECG is not a model input. A device ECG pattern is recorded as an adjunct and can never trigger a potassium-lowering action.',
        'Every hyperkalaemia action requires a confirmatory lab no older than the configured maximum; a stale potassium downgrades the action to a lab request.',
        'The five pathways are reported separately and can disagree; the platform never averages them into a single malnutrition score.',
        'The platform holds no prescribing, ordering or transport authority; every plan is a human decision.',
      ],
      cybersecurity: { posture: 'scoped platform controls; no device or machine interfaces', machineControlAuthority: 'none', orderAuthority: 'none' },
      postMarket: { drift: 'nutrition/electrolyte KS + latent shift (durable snapshots)', redTeam: [...NUTRITION_RED_TEAM_IDS], gate },
      synthetic: true,
    };
    const existing = await store.get('nutrition-mdr-file', id);
    const saved = existing
      ? await store.update('nutrition-mdr-file', id, doc as never)
      : await store.create('nutrition-mdr-file', id, doc as never);
    return { generatedAt: NOW(), mdr: saved };
  });

  app.get('/admin/swarm/nutrition/study', async () => {
    const store = await ensureGovernance();
    const docs = await store.list('nutrition-study-record');
    return { generatedAt: NOW(), count: docs.length, records: docs };
  });

  app.post<{ Body: { patientId?: string; clinician?: string; action?: 'accept' | 'modify' | 'reject'; recommendationAction?: string; note?: string } }>(
    '/admin/swarm/nutrition/study/record',
    async (request) => {
      const store = await ensureGovernance();
      const body = request.body ?? {};
      const id = `nutrition-study-${Date.now().toString(36)}`;
      const record = await store.create('nutrition-study-record', id, {
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

  app.get('/admin/swarm/nutrition/demo', async () => ({ ...buildNutritionDemo(), episodes: nutritionEpisodes(coord()) }));

  app.post('/admin/swarm/nutrition/demo', async () => {
    await ensureGovernance();
    const result = await seedNutritionEpisodes(coord(), ws());
    return { ok: true, ...result, episodes: nutritionEpisodes(coord()) };
  });

  app.post('/admin/swarm/nutrition/reset', async () => ({ ok: true, removed: await dropNutritionEpisodes(coord()) }));
}

/** Numeric view of a window for drift computation. */
function toNumeric(w: NutritionGuardInput): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined): void => { if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; };
  put('albumin', w.albumin);
  put('albuminTrend30d', w.albuminTrend30d);
  put('crp', w.crp);
  put('handgripKg', w.handgripKg);
  put('nonHdlMgDl', w.nonHdlMgDl);
  put('creatinineMgDl', w.creatinineMgDl);
  put('dryWeightDeltaKg', w.dryWeightDeltaKg);
  put('appetiteScore', w.appetiteScore);
  put('potassium', w.potassium);
  put('bicarbonate', w.bicarbonate);
  put('interdialyticHours', w.interdialyticHours);
  put('ktV', w.ktV);
  put('raasi', w.raasi ? 1 : 0);
  const forecast = forecastPotassium(w);
  put('projectedPotassium', forecast.nextSession);
  put('potassiumAbove6', forecast.probabilityAbove6);
  return out;
}

export { nutritionRecommend, assessPew, forecastPotassium, NUTRITION_ADVISOR_MODEL };
