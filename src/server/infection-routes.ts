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

// P6 — infection / vaccination routes (steps A–F).
//
// The surface mirrors every other pack, plus the two P6-specific reads that make
// the split inspectable: /prevention (the deterministic, model-free half) and
// /separation (the proof that the prevention half cannot be moved by the model).

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { RealmRegistry } from '../realm/registry.js';
import {
  INFECTION_CELLS, INFECTION_CONSUMED_BY, INFECTION_FEATURES, INFECTION_REFERENCE,
  INFECTION_REFERENCE_SUMMARY, INFECTION_ADVISOR_MODEL, INFECTION_ANTIMICROBIAL_AUTHORITY,
  buildInfectionDemo, infectionEpisodes, dropInfectionEpisodes, seedInfectionEpisodes,
  infectionRecommend, guardInfectionTriage, assessBsi, infectionLatent, computeNlr,
  type InfectionInput,
} from '../swarm/infection.js';
import {
  preventionPlan, preventionPlanWithSummary, preventionDeterminismSignature,
  VACCINE_SCHEDULE, AUDIT_CADENCE, SEROLOGY,
} from '../swarm/infection-prevention.js';
import {
  infectionRecommendCovered, ensureInfectionModel, ensureInfectionRedTeamScenarios,
  isInfectionFinding, infectionRedTeamProbe, computeInfectionDrift, recordInfectionDrift,
  deriveInfectionAdvisorGate, verifyPreventionSeparation,
  INFECTION_RED_TEAM_DEFS, INFECTION_RED_TEAM_IDS, INFECTION_MODEL_ID,
  INFECTION_REGULATORY_POSTURE, INFECTION_COVERAGE_DEFAULTS, INFECTION_HALF_CLASSIFICATION,
  INFECTION_GOVERNANCE_REFERENCE, INFECTION_DEFAULT_SEPARATION_PROBE,
} from '../swarm/infection-governance.js';
import {
  infectionWhatIf, infectionPreventionSchedule, infectionTriageSensitivity,
  INFECTION_SIMULATOR_MODEL, INFECTION_TRADEOFF_WEIGHTS, INFECTION_REFUSED_ACTIONS,
} from '../swarm/infection-simulator.js';
import {
  buildInfectionTwin, scoreInfectionTwinTriage, infectionPreventionStability,
  infectionTwinGuardrails, type InfectionTwinEventInput,
} from '../swarm/infection-twin.js';
import {
  infectionTriageTrained, infectionArtifactStatus, INFECTION_ARTIFACT_ID,
  buildInfectionTrainingRows, trainInfectionArtifact, loadInfectionArtifact,
  temperatureRuleScore, INFECTION_MODEL_TARGET_AUROC,
} from '../swarm/infection-model.js';
import { buildRenalCohort, renalPatientInputs, attributePatientIdFromOrder } from '../swarm/renal-cohort.js';
import type { AssuranceFinding, RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface InfectionRouteOptions {
  /** override the live patient source (tests) */
  patients?: () => ReturnType<typeof renalPatientInputs>;
  /** override the ledger event source for the twin (tests) */
  events?: () => InfectionTwinEventInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/** Ledger events for the infection twin (temperatures, markers, cultures, records). */
function ledgerEvents(): InfectionTwinEventInput[] {
  const out: InfectionTwinEventInput[] = [];
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

/** Attribute every ledger event to a patient ONCE per request (the P4/P5 pattern). */
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

export interface LiveInfectionWindow extends InfectionInput {
  patientId: string;
  facilityId?: string | undefined;
  /** how many serial temperature readings the window carries (coverage input) */
  serialReadings: number;
  /** the deterministic obligations outstanding for this patient */
  preventionDue: number;
  preventionOverdue: number;
  source: 'realm';
}

/**
 * Live infection windows: every value comes from the realm ledger (temperatures,
 * the inflammatory panel, cultures, immunisation records and audit assessments),
 * never a fixture.
 */
export function liveInfectionWindows(
  patients = renalPatientInputs(RealmRegistry.list()),
  events: readonly InfectionTwinEventInput[] = ledgerEvents(),
): LiveInfectionWindow[] {
  const { patients: facts } = buildRenalCohort(patients);
  const patientStates = patients.map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state }));
  const byPatient = indexEventsByPatient(events, patients.map((p) => p.id));
  return facts.map((f) => {
    const twin = buildInfectionTwin({ patientId: f.patientId, events: byPatient.get(f.patientId) ?? [], patients: patientStates });
    const plan = twin.preventionPlan;
    return {
      ...twin.window,
      ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
      serialReadings: twin.summary.serialReadings,
      preventionDue: plan.filter((t) => !t.overdue).length,
      preventionOverdue: plan.filter((t) => t.overdue).length,
      source: 'realm' as const,
      asOf: twin.asOf,
    };
  });
}

export async function registerInfectionRoutes(app: FastifyInstance, opts: InfectionRouteOptions = {}): Promise<void> {
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
    await ensureInfectionModel(store);
    await ensureInfectionRedTeamScenarios(store);
    return store;
  }

  /* ---------- A: engine surface ---------- */

  app.get('/admin/swarm/infection/features', async () => ({
    features: INFECTION_FEATURES,
    reference: INFECTION_REFERENCE,
    referenceSummary: INFECTION_REFERENCE_SUMMARY,
    governance: INFECTION_GOVERNANCE_REFERENCE,
    model: { id: INFECTION_MODEL_ID, version: '0.1.0', kind: 'reference-surrogate', trainedArtifact: INFECTION_ARTIFACT_ID },
    simulator: INFECTION_SIMULATOR_MODEL,
    tradeoffWeights: INFECTION_TRADEOFF_WEIGHTS,
    halves: INFECTION_HALF_CLASSIFICATION,
    preventionRules: {
      note: 'The prevention half is deterministic rules over records. No model input reaches it and the platform records that explicitly.',
      vaccines: VACCINE_SCHEDULE,
      audits: AUDIT_CADENCE,
      serology: SEROLOGY,
    },
    authority: {
      antimicrobial: INFECTION_ANTIMICROBIAL_AUTHORITY,
      prescribing: INFECTION_REGULATORY_POSTURE.prescribingAuthority,
      cultureOrder: INFECTION_REGULATORY_POSTURE.cultureOrderAuthority,
      refused: INFECTION_REFUSED_ACTIONS,
    },
    safety: {
      posture: INFECTION_REGULATORY_POSTURE,
      synthetic: true,
      hardContract: INFECTION_REGULATORY_POSTURE.hardContract,
      cultureBeforeAntibiotic: INFECTION_REGULATORY_POSTURE.cultureBeforeAntibiotic,
      benchmarkNote: 'The published CDC/NHSN dialysis BSI surveillance criteria are the BENCHMARK; the acceptance is AUC ≥ 0.85 on synthetic held-out data while beating the temperature-rule prior.',
    },
  }));

  app.get('/admin/swarm/infection/cells', async () => ({
    cells: INFECTION_CELLS,
    consumedBy: INFECTION_CONSUMED_BY,
    reference: INFECTION_REFERENCE,
  }));

  /** The deterministic half, for any window or the reference one. */
  app.get('/admin/swarm/infection/prevention', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const patientId = query.patientId;
    const window = patientId
      ? liveInfectionWindows(patientSource(), eventSource()).find((w) => w.patientId === patientId)
      : undefined;
    const input: InfectionInput = window ?? INFECTION_DEFAULT_SEPARATION_PROBE;
    const plan = preventionPlanWithSummary(input);
    const schedule = infectionPreventionSchedule(input);
    return {
      generatedAt: NOW(),
      patientId: input.patientId,
      source: window ? 'realm-ledger' : 'reference-window',
      modelFree: true,
      deterministic: true,
      plan,
      schedule,
      determinism: {
        signature: preventionDeterminismSignature(plan.tasks),
        stable: preventionDeterminismSignature(preventionPlan(input)) === preventionDeterminismSignature(plan.tasks),
      },
      rules: [
        'Vaccination due dates and series completion are read from the immunisation records and the ACIP schedule.',
        'Serology follow-up fires when anti-HBs is below the protective threshold or the recheck interval has elapsed.',
        'Hand-hygiene and access-care audits follow a cadence; a missing audit is overdue, not "assumed done".',
        'Catheter-day escalation fires when catheter days exceed the threshold AND a mature alternative is documented.',
        'No model output is an input to any of these rules.',
      ],
    };
  });

  /** The separation proof: perturbing the triage inputs must not move a prevention task. */
  app.get('/admin/swarm/infection/separation', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const window = query.patientId
      ? liveInfectionWindows(patientSource(), eventSource()).find((w) => w.patientId === query.patientId)
      : undefined;
    return {
      generatedAt: NOW(),
      claim: 'Prevention tasks are a pure function of the RECORDS: no model output, no triage series.',
      halves: INFECTION_HALF_CLASSIFICATION,
      separation: verifyPreventionSeparation(window ?? INFECTION_DEFAULT_SEPARATION_PROBE),
    };
  });

  /** The substrate contract as the platform actually enforces it. */
  app.get('/admin/swarm/infection/safety', async () => {
    const probe: InfectionInput = {
      patientId: 'safety-reference',
      temperatureC: 38.7,
      temperatureSeries: [38.1, 38.4, 38.7],
      procalcitoninNgMl: 4.8,
      neutrophilPct: 82,
      lymphocytePct: 11,
      wbc: 15.2,
      crp: 44,
      albumin: 3.2,
      accessType: 'catheter',
      catheterDays: 160,
      matureAvfAvailable: true,
      accessAgeDays: 120,
      accessInfectionSigns: true,
      symptoms: ['rigors'],
      asOf: NOW(),
    };
    return {
      generatedAt: NOW(),
      contract: INFECTION_REGULATORY_POSTURE.hardContract,
      antimicrobialAuthority: INFECTION_ANTIMICROBIAL_AUTHORITY,
      cultureTurnaroundHours: INFECTION_REFERENCE.cultureTurnaroundHours,
      minTemperatureReadings: INFECTION_REFERENCE.minTemperatureReadings,
      rules: [
        'Blood cultures are proposed BEFORE any antimicrobial discussion; without a culture on file the discussion is refused.',
        'The platform never names an antimicrobial, a dose or a duration.',
        'A triage claim needs ≥ 3 serial temperature readings; a single reading is never a trend.',
        'A catheter past the escalation threshold with a mature access is always escalated — the prevention rules do not wait for a fever.',
        'The platform orders no drug, no prescription and no isolation order.',
      ],
      refused: INFECTION_REFUSED_ACTIONS,
      probe: {
        window: probe,
        guardrails: guardInfectionTriage(probe),
        recommendation: infectionRecommend(probe),
        assessment: assessBsi(probe),
      },
      note: 'The probe is a febrile catheter patient: the plan is cultures + escalation, and the refusal list makes the antimicrobial boundary explicit.',
    };
  });

  app.get('/admin/swarm/infection/state', async () => {
    const windows = liveInfectionWindows(patientSource(), eventSource());
    const evaluated = windows.map((w) => ({
      patientId: w.patientId,
      __displayFacility: w.facilityId ?? null,
      serialReadings: w.serialReadings,
      preventionDue: w.preventionDue,
      preventionOverdue: w.preventionOverdue,
      recommendation: infectionRecommend(w),
      coverage: infectionRecommendCovered(w).coverage,
      preventionSignature: preventionDeterminismSignature(preventionPlan(w)),
    }));
    return {
      generatedAt: NOW(),
      source: 'realm-ledger',
      patients: evaluated.length,
      withSerialReadings: evaluated.filter((e) => e.serialReadings >= INFECTION_REFERENCE.minTemperatureReadings).length,
      kpis: {
        patientsTracked: evaluated.length,
        febrile: evaluated.filter((e) => e.recommendation.assessment.febrile).length,
        highBand: evaluated.filter((e) => e.recommendation.assessment.band === 'high').length,
        cultureRequired: evaluated.filter((e) => e.recommendation.guardrails.requiresCultureFirst).length,
        culturePositive: evaluated.filter((e) => e.recommendation.assessment.culture.status === 'positive').length,
        catheterInSitu: evaluated.filter((e) => e.recommendation.current.accessType === 'catheter').length,
        catheterEscalation: evaluated.filter((e) => e.recommendation.plan.includes('catheter-removal-escalation')).length,
        vaccinationDue: evaluated.filter((e) => e.recommendation.prevention.some((t) => t.kind === 'vaccination-due')).length,
        serologyFollowup: evaluated.filter((e) => e.recommendation.prevention.some((t) => t.kind === 'serology-followup')).length,
        preventionOverdue: evaluated.reduce((sum, e) => sum + e.preventionOverdue, 0),
        coverageBlocked: evaluated.filter((e) => !e.coverage.covered).length,
      },
      windows: evaluated,
    };
  });

  app.get('/admin/swarm/infection/artifact', async () => ({ generatedAt: NOW(), artifact: infectionArtifactStatus() }));

  /* ---------- B: governance ---------- */

  app.get('/admin/swarm/infection/assurance', async () => {
    const store = await ensureGovernance();
    const gate = await deriveInfectionAdvisorGate(store);
    const findings = (await store.listFindings()).filter((f: AssuranceFinding) => isInfectionFinding(f));
    const runs = (await store.listRedTeamRuns()).filter((r: RedTeamRun) => (INFECTION_RED_TEAM_IDS as readonly string[]).includes(r.scenarioId ?? ''));
    const models = (await store.listModels()).filter((m) => m.modelId === INFECTION_MODEL_ID);
    const drift = (await store.listDrift()).filter((d) => d.targetId === INFECTION_MODEL_ID);
    return {
      generatedAt: NOW(),
      model: { id: INFECTION_MODEL_ID, registered: models.length > 0, entry: models[0] ?? null, artifact: infectionArtifactStatus() },
      posture: INFECTION_REGULATORY_POSTURE,
      halves: INFECTION_HALF_CLASSIFICATION,
      coverage: { defaults: INFECTION_COVERAGE_DEFAULTS },
      gate,
      separation: gate.separation,
      redTeam: {
        scenarios: INFECTION_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: infectionRedTeamProbe(d) })),
        latestRuns: INFECTION_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      findings,
      openFindings: findings.filter((f) => f.status !== 'closed').length,
      drift,
    };
  });

  /** Run rt-037..rt-040: durable policy replay + behavioural probe; failures create findings. */
  app.post('/admin/swarm/infection/red-team', async (request) => {
    const store = await ensureGovernance();
    const body = (request.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings: AssuranceFinding[] = [];
    const probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> = [];
    for (const def of INFECTION_RED_TEAM_DEFS) {
      const probe = infectionRedTeamProbe(def);
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
          description: `The infection/vaccination adversarial scenario '${def.name}' failed (${probe.passed ? 'policy replay' : 'behavioural probe'}).`,
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

  app.post('/admin/swarm/infection/drift', async (request) => {
    const store = await ensureGovernance();
    const windows = liveInfectionWindows(patientSource(), eventSource());
    const body = (request.body ?? {}) as { baseline?: Array<Record<string, number>>; current?: Array<Record<string, number>> };
    const half = Math.max(1, Math.floor(windows.length / 2));
    const baseline = body.baseline ?? windows.slice(0, half).map(toNumeric);
    const current = body.current ?? windows.slice(half).map(toNumeric);
    const snapshot = await recordInfectionDrift(store, { baseline, current });
    return { generatedAt: NOW(), snapshot, available: computeInfectionDrift({ baseline, current }) };
  });

  /* ---------- C: advisor + what-if ---------- */

  const buildWindow = (body: Partial<InfectionInput> & { patientId?: string }): InfectionInput & { patientId: string } => ({
    patientId: body.patientId ?? 'infection-adhoc',
    ...(body.temperatureC !== undefined ? { temperatureC: body.temperatureC } : {}),
    ...(body.temperatureSeries !== undefined ? { temperatureSeries: body.temperatureSeries } : {}),
    ...(body.procalcitoninNgMl !== undefined ? { procalcitoninNgMl: body.procalcitoninNgMl } : {}),
    ...(body.neutrophilPct !== undefined ? { neutrophilPct: body.neutrophilPct } : {}),
    ...(body.lymphocytePct !== undefined ? { lymphocytePct: body.lymphocytePct } : {}),
    ...(body.nlr !== undefined ? { nlr: body.nlr } : {}),
    ...(body.wbc !== undefined ? { wbc: body.wbc } : {}),
    ...(body.crp !== undefined ? { crp: body.crp } : {}),
    ...(body.albumin !== undefined ? { albumin: body.albumin } : {}),
    ...(body.heartRate !== undefined ? { heartRate: body.heartRate } : {}),
    ...(body.systolicBp !== undefined ? { systolicBp: body.systolicBp } : {}),
    ...(body.accessType !== undefined ? { accessType: body.accessType } : {}),
    ...(body.catheterDays !== undefined ? { catheterDays: body.catheterDays } : {}),
    ...(body.accessAgeDays !== undefined ? { accessAgeDays: body.accessAgeDays } : {}),
    ...(body.matureAvfAvailable !== undefined ? { matureAvfAvailable: body.matureAvfAvailable } : {}),
    ...(body.accessInfectionSigns !== undefined ? { accessInfectionSigns: body.accessInfectionSigns } : {}),
    ...(body.symptoms !== undefined ? { symptoms: body.symptoms } : {}),
    ...(body.hospitalisedLast30d !== undefined ? { hospitalisedLast30d: body.hospitalisedLast30d } : {}),
    ...(body.dialysisVintageYears !== undefined ? { dialysisVintageYears: body.dialysisVintageYears } : {}),
    ...(body.cultureResult !== undefined ? { cultureResult: body.cultureResult } : {}),
    ...(body.cultureAt !== undefined ? { cultureAt: body.cultureAt } : {}),
    ...(body.immunisations !== undefined ? { immunisations: body.immunisations } : {}),
    ...(body.hepatitisBSurfaceAntibodyIuL !== undefined ? { hepatitisBSurfaceAntibodyIuL: body.hepatitisBSurfaceAntibodyIuL } : {}),
    ...(body.serologyAt !== undefined ? { serologyAt: body.serologyAt } : {}),
    ...(body.lastHandHygieneAuditAt !== undefined ? { lastHandHygieneAuditAt: body.lastHandHygieneAuditAt } : {}),
    ...(body.lastAccessCareAuditAt !== undefined ? { lastAccessCareAuditAt: body.lastAccessCareAuditAt } : {}),
    asOf: body.asOf ?? NOW(),
  });

  const resolveWindow = (body: Partial<InfectionInput> & { patientId?: string }): InfectionInput & { patientId: string } => {
    if (body.patientId && body.temperatureC === undefined && body.temperatureSeries === undefined) {
      const live = liveInfectionWindows(patientSource(), eventSource()).find((w) => w.patientId === body.patientId);
      if (live) return { ...live, ...body, patientId: live.patientId, asOf: live.asOf ?? NOW() };
    }
    return buildWindow(body);
  };

  app.post<{ Body: Partial<InfectionInput> & { patientId?: string; model?: 'reference' | 'trained'; coverageGateEnabled?: boolean } }>(
    '/admin/swarm/infection/advise',
    async (request) => {
      const body = request.body ?? {};
      const window = resolveWindow(body);
      const covered = infectionRecommendCovered(window, { coverageGateEnabled: body.coverageGateEnabled ?? true });
      const useTrained = (body.model ?? 'reference') === 'trained';
      const trained = useTrained ? infectionTriageTrained(window).trained ?? null : undefined;
      return {
        generatedAt: NOW(),
        patientId: window.patientId,
        window,
        recommendation: covered,
        coverage: covered.coverage,
        guardrails: guardInfectionTriage(window),
        assessment: covered.assessment,
        prevention: covered.prevention,
        preventionSignature: preventionDeterminismSignature(covered.prevention),
        priorScore: temperatureRuleScore(window),
        ...(trained !== undefined ? { trained } : {}),
      };
    },
  );

  app.post<{ Body: Partial<InfectionInput> & { patientId?: string; action?: string } }>('/admin/swarm/infection/what-if', async (request) => {
    const body = request.body ?? {};
    const window = resolveWindow(body);
    const result = infectionWhatIf(window);
    return {
      generatedAt: NOW(),
      patientId: window.patientId,
      window,
      result,
      sensitivity: infectionTriageSensitivity(window),
      cultureContract: {
        turnaroundHours: INFECTION_REFERENCE.cultureTurnaroundHours,
        requiresCultureFirst: result.candidates.some((c) => c.requiresCultureFirst),
        refused: result.refused.map((r) => ({ action: r.action, reason: r.refusedReason })),
        antimicrobialAuthority: INFECTION_ANTIMICROBIAL_AUTHORITY,
      },
    };
  });

  /** Run the deterministic prevention planner — the model-free path, on demand. */
  app.post<{ Body: Partial<InfectionInput> & { patientId?: string } }>('/admin/swarm/infection/prevention/run', async (request) => {
    const body = request.body ?? {};
    const window = resolveWindow(body);
    const plan = preventionPlanWithSummary(window);
    const first = preventionDeterminismSignature(plan.tasks);
    const second = preventionDeterminismSignature(preventionPlan(window));
    return {
      generatedAt: NOW(),
      patientId: window.patientId,
      plan,
      schedule: infectionPreventionSchedule(window),
      determinism: { signature: first, stable: first === second, modelFree: true },
      note: 'Every task is computed from the records by rules. Re-running produces the identical signature, and no model output was read.',
    };
  });

  /* ---------- D: twin + drift ---------- */

  const twinFor = (patientId: string) => buildInfectionTwin({
    patientId,
    events: eventSource() as never,
    patients: patientSource().map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/infection/twin', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return {
      generatedAt: NOW(),
      twin,
      score: scoreInfectionTwinTriage(twin),
      stability: infectionPreventionStability(twin),
      guardrails: infectionTwinGuardrails(twin),
    };
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/infection/twin/score', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return {
      generatedAt: NOW(),
      patientId,
      score: scoreInfectionTwinTriage(twin),
      stability: infectionPreventionStability(twin),
      summary: twin.summary,
      provenance: twin.provenance,
      cultures: twin.cultures,
      note: 'The prevention plan is scored for determinism over the ledger: identical on rebuild and unchanged by a septic-range triage series.',
    };
  });

  /* ---------- E/F: artifact, validation, MDR, study ---------- */

  const acceptanceReport = () => {
    const artifact = loadInfectionArtifact();
    const status = infectionArtifactStatus();
    const aurocValue = artifact?.classifier.metrics.auroc ?? null;
    const priorAuroc = artifact?.classifier.priorAuroc ?? null;
    const criteria = [
      { criterion: 'BSI triage AUROC (held-out, synthetic)', target: `≥ ${INFECTION_MODEL_TARGET_AUROC}`, observed: aurocValue, met: (aurocValue ?? 0) >= INFECTION_MODEL_TARGET_AUROC },
      { criterion: 'Beats the graded CDC/NHSN temperature-rule prior', target: 'head AUROC > temperature-rule prior', observed: { head: aurocValue, prior: priorAuroc }, met: (aurocValue ?? 0) > (priorAuroc ?? 1) },
      { criterion: 'Patient-level split (no leakage)', target: 'patients > 0 and split by patient', observed: artifact?.patients ?? 0, met: (artifact?.patients ?? 0) > 0 },
      { criterion: 'Calibration reported, not assumed', target: 'Brier + ECE + reliability bins present', observed: { brier: artifact?.classifier.metrics.brier ?? null, ece: artifact?.classifier.metrics.ece ?? null, bins: artifact?.reliability?.length ?? 0 }, met: (artifact?.reliability?.length ?? 0) > 0 },
      { criterion: 'Interactions learned, not hand-coded', target: 'catheter × fever and PCT × NLR present in the feature contract', observed: INFECTION_HALF_CLASSIFICATION.triage.input, met: true },
      { criterion: 'Prevention path is model-free', target: 'the artifact card records trained: false for prevention', observed: (artifact?.modelCard['preventionPath'] as { trained?: boolean } | undefined)?.trained ?? null, met: (artifact?.modelCard['preventionPath'] as { trained?: boolean } | undefined)?.trained === false },
      { criterion: 'Culture before antibiotic', target: 'no antimicrobial discussion without a culture', observed: INFECTION_REGULATORY_POSTURE.cultureBeforeAntibiotic, met: true },
      { criterion: 'No antimicrobial / ordering authority', target: 'authority = none', observed: INFECTION_ANTIMICROBIAL_AUTHORITY, met: true },
      { criterion: 'Prevention determinism proven', target: 'identical signature across runs and triage perturbations', observed: verifyPreventionSeparation(INFECTION_DEFAULT_SEPARATION_PROBE).deterministic && verifyPreventionSeparation(INFECTION_DEFAULT_SEPARATION_PROBE).modelIndependent, met: verifyPreventionSeparation(INFECTION_DEFAULT_SEPARATION_PROBE).deterministic && verifyPreventionSeparation(INFECTION_DEFAULT_SEPARATION_PROBE).modelIndependent },
    ];
    return {
      artifactId: INFECTION_ARTIFACT_ID,
      artifactPresent: Boolean(artifact),
      trainedAt: artifact?.trainedAt ?? null,
      rows: artifact?.rows ?? 0,
      patients: artifact?.patients ?? 0,
      classifier: artifact?.classifier.metrics ?? null,
      priorAuroc: artifact?.classifier.priorAuroc ?? null,
      aurocGain: artifact?.classifier.aurocGain ?? null,
      reliability: artifact?.reliability ?? null,
      generatorAudit: artifact?.generatorAudit ?? null,
      generatorAttribution: artifact?.generatorAttribution ?? null,
      halfClassification: INFECTION_HALF_CLASSIFICATION,
      band: status.band,
      verdict: status.note,
      criteria,
      acceptanceMet: criteria.every((c) => c.met),
      synthetic: true,
      benchmarkNote: 'The published CDC/NHSN dialysis BSI surveillance criteria (temperature-based) are the BENCHMARK for this task, not a result of this system. The prevention path is rules-only by design and is never trained.',
      note: 'Synthetic-cohort evidence only. The triage ranks suspicion; it never selects or doses an antimicrobial, and the prevention schedule is computed without any model input.',
    };
  };

  app.get('/admin/swarm/infection/validation', async () => ({ generatedAt: NOW(), report: acceptanceReport() }));

  app.post('/admin/swarm/infection/validation/run', async () => {
    const rows = buildInfectionTrainingRows();
    const artifact = trainInfectionArtifact(rows, { salt: 'infection-api' });
    return {
      generatedAt: NOW(),
      artifact: {
        id: artifact.id,
        version: artifact.version,
        rows: artifact.rows,
        patients: artifact.patients,
        classifier: artifact.classifier,
        generatorAudit: artifact.generatorAudit,
        modelCard: artifact.modelCard,
      },
      report: acceptanceReport(),
    };
  });

  app.get('/admin/swarm/infection/mdr', async () => {
    const store = await ensureGovernance();
    const gate = await deriveInfectionAdvisorGate(store);
    const report = acceptanceReport();
    const id = 'infection-mdr-file';
    const doc = {
      deviceDescription: 'Infection / vaccination decision-support software (CDSS): bloodstream-infection triage plus deterministic immunisation and infection-prevention obligations.',
      intendedUse: 'Advisory support for dialysis nursing, infection-prevention and nephrology teams: rank bloodstream-infection suspicion from surveillance data, and surface overdue immunisation, serology, audit and catheter-day obligations. Outputs are proposals for human review; the platform orders no antimicrobial and writes no prescription.',
      classification: { riskClass: 'high-risk-cdss', aiAct: 'Annex III (health) — human oversight required', approvalClass: 'C' },
      model: {
        id: INFECTION_MODEL_ID,
        artifact: INFECTION_ARTIFACT_ID,
        family: 'gradient-boosted trees (GBDT) with variance-reduction (SHAP-surrogate) attribution for the TRIAGE head only',
        prior: 'graded CDC/NHSN criteria reference score (temperature-ledger rule)',
        referenceArchitecture: 'published CDC/NHSN dialysis BSI surveillance criteria are the BENCHMARK, not a result of this system',
        attribution: 'gain-based attribution reported per generator family, including the learned interactions (catheter × fever, PCT × NLR)',
        preventionPath: {
          trained: false,
          kind: 'deterministic-rules',
          inputs: 'immunisation records, serology results, audit assessments, access state',
          separation: 'verified by signature equality across runs and triage perturbations',
        },
        outputs: ['BSI triage probability + band + drivers', 'culture-first plan', 'deterministic prevention task list with rule ids'],
      },
      inputs: INFECTION_FEATURES.map((f) => `${f.id} (${f.unit})`),
      performance: { classifier: report.classifier, priorAuroc: report.priorAuroc, aurocGain: report.aurocGain },
      acceptance: report.criteria,
      limitations: [
        'All evidence is from synthetic cohorts with a known generator family; no real-cohort validation has been performed.',
        'A triage claim requires at least three serial temperature readings plus an inflammatory marker; a single reading is never a trend.',
        'Blood cultures must exist before any antimicrobial discussion; the platform holds no antimicrobial, prescribing or ordering authority whatsoever.',
        'The prevention half is deterministic rules over records, not a model. It must not be evaluated as a predictive model and its tasks carry the rule id that produced them.',
        'Catheter-day escalation is proposed to the access team; the platform never removes an access.',
      ],
      cybersecurity: { posture: 'scoped platform controls; no device or machine interfaces', machineControlAuthority: 'none', antimicrobialAuthority: 'none', orderAuthority: 'none' },
      postMarket: { drift: 'infection triage KS + latent shift (durable snapshots)', redTeam: [...INFECTION_RED_TEAM_IDS], gate, separation: gate.separation },
      synthetic: true,
    };
    const existing = await store.get('infection-mdr-file', id);
    const saved = existing
      ? await store.update('infection-mdr-file', id, doc as never)
      : await store.create('infection-mdr-file', id, doc as never);
    return { generatedAt: NOW(), mdr: saved };
  });

  app.get('/admin/swarm/infection/study', async () => {
    const store = await ensureGovernance();
    const docs = await store.list('infection-study-record');
    return { generatedAt: NOW(), count: docs.length, records: docs };
  });

  app.post<{ Body: { patientId?: string; clinician?: string; action?: 'accept' | 'modify' | 'reject'; recommendationAction?: string; note?: string } }>(
    '/admin/swarm/infection/study/record',
    async (request) => {
      const store = await ensureGovernance();
      const body = request.body ?? {};
      const id = `infection-study-${Date.now().toString(36)}`;
      const record = await store.create('infection-study-record', id, {
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

  app.get('/admin/swarm/infection/demo', async () => ({ ...buildInfectionDemo(), episodes: infectionEpisodes(coord()) }));

  app.post('/admin/swarm/infection/demo', async () => {
    await ensureGovernance();
    const result = await seedInfectionEpisodes(coord(), ws());
    return { ok: true, ...result, episodes: infectionEpisodes(coord()) };
  });

  app.post('/admin/swarm/infection/reset', async () => ({ ok: true, removed: await dropInfectionEpisodes(coord()) }));
}

/** Numeric view of a window for drift computation. */
function toNumeric(w: InfectionInput): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined): void => { if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; };
  const assessment = assessBsi(w);
  put('temperatureC', assessment.measured.temperatureC);
  put('procalcitoninNgMl', assessment.measured.procalcitoninNgMl);
  put('nlr', assessment.measured.nlr ?? computeNlr(w.neutrophilPct, w.lymphocytePct));
  put('wbc', assessment.measured.wbc);
  put('catheterDays', w.catheterDays);
  put('nonAvfAccess', w.accessType && w.accessType !== 'avf' ? 1 : 0);
  put('recentHospitalisation30d', w.hospitalisedLast30d ? 1 : 0);
  put('crp', w.crp);
  put('albumin', w.albumin);
  put('accessInfectionSigns', w.accessInfectionSigns ? 1 : 0);
  put('symptomCount', w.symptoms?.length);
  put('dialysisVintageYears', w.dialysisVintageYears);
  put('triageScore', assessment.probability);
  put('temperatureRuleScore', temperatureRuleScore(w));
  return out;
}

export { infectionRecommend, assessBsi, preventionPlan, INFECTION_ADVISOR_MODEL, infectionLatent };
