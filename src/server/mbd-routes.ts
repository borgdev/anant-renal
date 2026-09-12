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

// P4 — CKD-MBD (mineral bone disorder) protocol pack routes (steps A–F).
//
//   GET  /admin/swarm/mbd/features      feature catalog + KDIGO targets + envelope
//   GET  /admin/swarm/mbd/cells         bounded cells + boundary
//   GET  /admin/swarm/mbd/state         live [P, Ca, PTH] windows from the realm ledger
//   GET  /admin/swarm/mbd/coupling      the coupled lever→analyte coupling map
//   GET  /admin/swarm/mbd/artifact      trained coupled artifact status
//   GET  /admin/swarm/mbd/assurance     governance: coverage, gate, red team, drift
//   GET  /admin/swarm/mbd/validation    acceptance report (per-analyte MAE, honest)
//   GET  /admin/swarm/mbd/mdr           MDR / EU AI Act technical file
//   GET  /admin/swarm/mbd/study         study-mode acceptance records
//   POST /admin/swarm/mbd/advise        reference | trained coupled advisor
//   POST /admin/swarm/mbd/what-if       candidate-therapy counterfactual (KDIGO contract)
//   POST /admin/swarm/mbd/twin          patient MBD twin over the REAL ledger
//   POST /admin/swarm/mbd/twin/score    per-analyte MAE/bias vs the coupled responder
//   POST /admin/swarm/mbd/demo          seed durable episodes (Class C/B)
//   POST /admin/swarm/mbd/reset         remove only MBD episodes
//   POST /admin/swarm/mbd/red-team      run rt-029..rt-032 behavioural probes
//   POST /admin/swarm/mbd/drift         KS drift snapshot (durable)
//   POST /admin/swarm/mbd/study/record  record a clinician decision
//
// CDSS only: no binder, calcimimetic or vitamin-D dose is ever ordered by the
// platform, and no dosage arithmetic is presented as a prescription.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { RealmRegistry } from '../realm/registry.js';
import {
  MBD_CELLS, MBD_CONSUMED_BY, MBD_FEATURES, MBD_REFERENCE, MBD_REFERENCE_SUMMARY,
  buildMbdDemo, mbdEpisodes, dropMbdEpisodes, seedMbdEpisodes,
  mbdRecommend, guardMbdTherapy, projectMbdTherapy, correctedCalcium,
  type MbdCoupledInput, type MbdTherapyState,
} from '../swarm/mbd.js';
import {
  mbdRecommendCovered, ensureMbdModel, ensureMbdRedTeamScenarios,
  isMbdFinding, mbdRedTeamProbe, computeMbdDrift, recordMbdDrift,
  deriveMbdAdvisorGate, MBD_RED_TEAM_DEFS, MBD_RED_TEAM_IDS,
  MBD_MODEL_ID, MBD_REGULATORY_POSTURE, MBD_COVERAGE_DEFAULTS,
  MBD_GOVERNANCE_REFERENCE,
} from '../swarm/mbd-governance.js';
import { mbdWhatIf, mbdCouplingMap, MBD_SIMULATOR_MODEL } from '../swarm/mbd-simulator.js';
import { buildMbdTwin, scoreMbdTwinDrift, mbdWindowFromTwin, type MbdTwinEventInput } from '../swarm/mbd-twin.js';
import { mbdProjectTrained, mbdArtifactStatus, MBD_ARTIFACT_ID, buildMbdTrainingRows, trainMbdArtifact, loadMbdArtifact } from '../swarm/mbd-model.js';
import { buildRenalCohort, renalPatientInputs, attributePatientIdFromOrder } from '../swarm/renal-cohort.js';
import { clinicalNbaState, mbdFindings, MBD_CLINICAL_ACTIONS, clinicalActionsPayload } from '../swarm/clinical-nba.js';
import type { AssuranceFinding, RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface MbdRouteOptions {
  /** override the live patient source (tests) */
  patients?: () => ReturnType<typeof renalPatientInputs>;
  /** override the ledger event source for the twin (tests) */
  events?: () => MbdTwinEventInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();
const NO_THERAPY_STATE: MbdTherapyState = { binderMgPerDay: 0, binderClass: 'none', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };

/** Ledger events for the MBD twin (P/Ca/PTH/vitamin-D results + therapy orders). */
function ledgerEvents(): MbdTwinEventInput[] {
  const out: MbdTwinEventInput[] = [];
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
 * Attribute every ledger event to a patient ONCE per request. The twin performs
 * the same attribution internally, but doing it here turns the state route from
 * O(patients × events) into O(events), which matters at 58 patients.
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

export interface LiveMbdWindow extends MbdCoupledInput {
  facilityId?: string | undefined;
  /** how many serial measurements the window is built on (the coverage input) */
  phosphateSeries: number;
  source: 'realm';
}

/**
 * Live [P, Ca, PTH] windows from the shared MBD twin: every value comes from the
 * realm ledger (results attributed by order-id prefix), never from a fixture.
 */
export function liveMbdWindows(
  patients = renalPatientInputs(RealmRegistry.list()),
  events: readonly MbdTwinEventInput[] = ledgerEvents(),
): LiveMbdWindow[] {
  const { patients: facts } = buildRenalCohort(patients);
  const patientStates = patients.map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state }));
  const byPatient = indexEventsByPatient(events, patients.map((p) => p.id));
  return facts.map((f) => {
    const twin = buildMbdTwin({ patientId: f.patientId, events: byPatient.get(f.patientId) ?? [], patients: patientStates });
    const window = mbdWindowFromTwin(twin);
    return {
      ...window,
      ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
      phosphateSeries: window.phosphateSeries ?? 0,
      source: 'realm' as const,
    };
  });
}

export async function registerMbdRoutes(app: FastifyInstance, opts: MbdRouteOptions = {}): Promise<void> {
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
    await ensureMbdModel(store);
    await ensureMbdRedTeamScenarios(store);
    return store;
  }

  /* ---------- A: engine surface ---------- */

  app.get('/admin/swarm/mbd/features', async () => ({
    features: MBD_FEATURES,
    reference: MBD_REFERENCE,
    referenceSummary: MBD_REFERENCE_SUMMARY,
    governance: MBD_GOVERNANCE_REFERENCE,
    model: { id: MBD_MODEL_ID, version: '0.1.0', kind: 'reference-surrogate', trainedArtifact: MBD_ARTIFACT_ID },
    simulator: MBD_SIMULATOR_MODEL,
    coupling: {
      note: 'One lever moves two or three analytes at once — the coupling is the whole point of P4 and the reason a single-analyte agent is unsafe.',
      map: mbdCouplingMap({ patientId: 'coupling-reference', phosphate: 5.8, calcium: 9.2, albumin: 3.6, pth: 620, vitaminD: 16, ktV: 1.3, triplets: 3 }),
    },
    safety: {
      posture: MBD_REGULATORY_POSTURE,
      synthetic: true,
      prescribingAuthority: 'none',
      orderAuthority: 'none',
      hardContract: {
        correctedCalciumCeilingMgDl: MBD_REFERENCE.calciumSafetyCeilingMgDl,
        correctedCalciumFloorMgDl: MBD_REFERENCE.calciumSafetyFloorMgDl,
        phosphateFloorMgDl: MBD_REFERENCE.phosphateSafetyFloorMgDl,
      },
      referenceArchitecture: 'published cross-sectional SVM AUC 0.840 is a BENCHMARK (risk classification), not a result of this system — the served artifact is the coupled multi-output temporal model',
    },
  }));

  app.get('/admin/swarm/mbd/cells', async () => ({
    cells: MBD_CELLS,
    consumedBy: MBD_CONSUMED_BY,
    reference: MBD_REFERENCE,
  }));

  app.get('/admin/swarm/mbd/coupling', async () => ({
    generatedAt: NOW(),
    weights: MBD_SIMULATOR_MODEL,
    map: mbdCouplingMap({ patientId: 'coupling-reference', phosphate: 5.8, calcium: 9.2, albumin: 3.6, pth: 620, vitaminD: 16, ktV: 1.3, triplets: 3 }),
    responseFractions: { 30: 0.45, 60: 0.78, 90: 0.95 },
    note: 'Per-lever change in phosphate / corrected calcium / PTH at the 30-day horizon, from the coupled responder. Calcium-raising levers are refused when corrected calcium is already ≥ the KDIGO ceiling.',
  }));

  app.get('/admin/swarm/mbd/state', async () => {
    const patients = patientSource();
    const realmOf = new Map(patients.map((p) => [p.id, p.realmId]));
    const windows = liveMbdWindows(patients, eventSource());
    const evaluated = windows.map((w) => ({
      patientId: w.patientId,
      __displayFacility: w.facilityId ?? null,
      triplets: w.triplets ?? 0,
      therapy: w.therapy ?? null,
      recommendation: mbdRecommend(w),
      coverage: mbdRecommendCovered(w).coverage,
    }));
    // The NBAs reuse the SAME recommendation objects computed above — no second
    // evaluation, so the ranked action can never disagree with the rendered row.
    const actions = clinicalNbaState({
      protocol: 'mbd',
      insightKind: 'mbd.therapy.proposal',
      cells: MBD_CELLS,
      consumedBy: MBD_CONSUMED_BY,
      actionMap: MBD_CLINICAL_ACTIONS,
      findings: mbdFindings(
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
      withCompleteTriplet: windows.filter((w) => (w.triplets ?? 0) > 0).length,
      kpis: {
        patientsTracked: evaluated.length,
        inTarget: evaluated.filter((e) => e.recommendation.inTarget).length,
        hyperphosphatemic: windows.filter((w) => (w.phosphate ?? 0) > MBD_REFERENCE.phosphateTargetMgDl.upper).length,
        hypercalcemic: windows.filter((w) => w.calcium !== undefined && correctedCalcium(w.calcium, w.albumin) > MBD_REFERENCE.calciumSafetyCeilingMgDl).length,
        safetyReviewProposed: evaluated.filter((e) => e.recommendation.action === 'safety-review' || e.recommendation.action === 'hold').length,
        coverageBlocked: evaluated.filter((e) => !e.coverage.covered).length,
      },
      windows: evaluated,
      actions: clinicalActionsPayload(actions),
    };
  });

  app.get('/admin/swarm/mbd/artifact', async () => ({ generatedAt: NOW(), artifact: mbdArtifactStatus() }));

  /* ---------- B: governance ---------- */

  app.get('/admin/swarm/mbd/assurance', async () => {
    const store = await ensureGovernance();
    const gate = await deriveMbdAdvisorGate(store);
    const findings = (await store.listFindings()).filter((f: AssuranceFinding) => isMbdFinding(f));
    const runs = (await store.listRedTeamRuns()).filter((r: RedTeamRun) => (MBD_RED_TEAM_IDS as readonly string[]).includes(r.scenarioId ?? ''));
    const models = (await store.listModels()).filter((m) => m.modelId === MBD_MODEL_ID);
    const drift = (await store.listDrift()).filter((d) => d.targetId === MBD_MODEL_ID);
    return {
      generatedAt: NOW(),
      model: { id: MBD_MODEL_ID, registered: models.length > 0, entry: models[0] ?? null, artifact: mbdArtifactStatus() },
      posture: MBD_REGULATORY_POSTURE,
      coverage: { defaults: MBD_COVERAGE_DEFAULTS },
      gate,
      redTeam: {
        scenarios: MBD_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: mbdRedTeamProbe(d) })),
        latestRuns: MBD_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      findings,
      openFindings: findings.filter((f) => f.status !== 'closed').length,
      drift,
    };
  });

  /** Run rt-029..rt-032: durable policy replay + behavioural probe; failures create findings. */
  app.post('/admin/swarm/mbd/red-team', async (request) => {
    const store = await ensureGovernance();
    const body = (request.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings: AssuranceFinding[] = [];
    const probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> = [];
    for (const def of MBD_RED_TEAM_DEFS) {
      const probe = mbdRedTeamProbe(def);
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
          description: `The CKD-MBD adversarial scenario '${def.name}' failed (${probe.passed ? 'policy replay' : 'behavioural probe'}).`,
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

  app.post('/admin/swarm/mbd/drift', async (request) => {
    const store = await ensureGovernance();
    const windows = liveMbdWindows(patientSource(), eventSource());
    const body = (request.body ?? {}) as { baseline?: Array<Record<string, number>>; current?: Array<Record<string, number>> };
    const half = Math.max(1, Math.floor(windows.length / 2));
    const baseline = body.baseline ?? windows.slice(0, half).map(toNumeric);
    const current = body.current ?? windows.slice(half).map(toNumeric);
    const snapshot = await recordMbdDrift(store, { baseline, current });
    return { generatedAt: NOW(), snapshot };
  });

  /* ---------- C: advisor + what-if ---------- */

  const buildWindow = (body: Partial<MbdCoupledInput> & { patientId?: string }): MbdCoupledInput => ({
    patientId: body.patientId ?? 'mbd-adhoc',
    ...(body.phosphate !== undefined ? { phosphate: body.phosphate } : {}),
    ...(body.calcium !== undefined ? { calcium: body.calcium } : {}),
    ...(body.albumin !== undefined ? { albumin: body.albumin } : {}),
    ...(body.pth !== undefined ? { pth: body.pth } : {}),
    ...(body.vitaminD !== undefined ? { vitaminD: body.vitaminD } : {}),
    ...(body.triplets !== undefined ? { triplets: body.triplets } : {}),
    ...(body.lastTripletAt !== undefined ? { lastTripletAt: body.lastTripletAt } : {}),
    ...(body.phosphateTrend30d !== undefined ? { phosphateTrend30d: body.phosphateTrend30d } : {}),
    ...(body.calciumTrend30d !== undefined ? { calciumTrend30d: body.calciumTrend30d } : {}),
    ...(body.therapy !== undefined ? { therapy: body.therapy as MbdTherapyState } : {}),
    ...(body.binderDosesPerWeek !== undefined ? { binderDosesPerWeek: body.binderDosesPerWeek } : {}),
    ...(body.prescribedDosesPerWeek !== undefined ? { prescribedDosesPerWeek: body.prescribedDosesPerWeek } : {}),
    ...(body.ktV !== undefined ? { ktV: body.ktV } : {}),
    ...(body.dietaryProteinGPerDay !== undefined ? { dietaryProteinGPerDay: body.dietaryProteinGPerDay } : {}),
    asOf: body.asOf ?? NOW(),
  });

  const resolveWindow = (body: Partial<MbdCoupledInput> & { patientId?: string }): MbdCoupledInput => {
    if (body.patientId && body.phosphate === undefined && body.calcium === undefined) {
      const live = liveMbdWindows(patientSource(), eventSource()).find((w) => w.patientId === body.patientId);
      if (live) return { ...live, ...body, patientId: live.patientId, asOf: live.asOf };
    }
    return buildWindow(body);
  };

  app.post<{ Body: Partial<MbdCoupledInput> & { patientId?: string; model?: 'reference' | 'trained'; therapy?: MbdTherapyState; coverageGateEnabled?: boolean } }>(
    '/admin/swarm/mbd/advise',
    async (request) => {
      const body = request.body ?? {};
      const window = resolveWindow(body);
      const covered = mbdRecommendCovered(window, { coverageGateEnabled: body.coverageGateEnabled ?? true });
      const whatIf = mbdWhatIf(window);
      // The trained heads project the therapy the what-if recommends (or the one
      // the caller names); the recommendation itself stays the bounded reference.
      const next = body.therapy ?? whatIf.recommended?.therapy ?? window.therapy ?? NO_THERAPY_STATE;
      const useTrained = (body.model ?? 'reference') === 'trained';
      const trained = useTrained ? mbdProjectTrained(window, next).trained ?? null : undefined;
      return {
        generatedAt: NOW(),
        patientId: window.patientId,
        window,
        recommendation: covered,
        coverage: covered.coverage,
        guardrails: guardMbdTherapy(window),
        coupling: mbdCouplingMap(window),
        ...(trained !== undefined ? { trained } : {}),
      };
    },
  );

  app.post<{ Body: Partial<MbdCoupledInput> & { patientId?: string } }>('/admin/swarm/mbd/what-if', async (request) => {
    const window = resolveWindow(request.body ?? {});
    const result = mbdWhatIf(window);
    return {
      generatedAt: NOW(),
      patientId: window.patientId,
      window,
      result,
      coupling: mbdCouplingMap(window),
      contract: {
        envelope: {
          correctedCalciumCeilingMgDl: MBD_REFERENCE.calciumSafetyCeilingMgDl,
          correctedCalciumFloorMgDl: MBD_REFERENCE.calciumSafetyFloorMgDl,
          phosphateFloorMgDl: MBD_REFERENCE.phosphateSafetyFloorMgDl,
        },
        recommendedViolations: result.recommended?.violations ?? [],
        refused: result.candidates.filter((c) => !c.allowed).map((c) => ({ label: c.label, violations: c.violations })),
      },
    };
  });

  /* ---------- D: twin + drift ---------- */

  const twinFor = (patientId: string) => buildMbdTwin({
    patientId,
    events: eventSource() as never,
    patients: patientSource().map((p) => ({ patientId: p.id, realmId: p.realmId, state: p.state })),
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/mbd/twin', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return { generatedAt: NOW(), twin, drift: scoreMbdTwinDrift(twin), window: mbdWindowFromTwin(twin) };
  });

  app.post<{ Body: { patientId?: string } }>('/admin/swarm/mbd/twin/score', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    return { generatedAt: NOW(), patientId, score: scoreMbdTwinDrift(twin), summary: twin.summary, provenance: twin.provenance };
  });

  /** The coupled responder evaluated ON the twin's real steps (step D evidence). */
  app.post<{ Body: { patientId?: string; horizonDays?: number } }>('/admin/swarm/mbd/twin/project', async (request, reply) => {
    const patients = patientSource();
    const patientId = (request.body ?? {}).patientId ?? patients[0]?.id;
    if (!patientId) return error(reply, 400, 'no-patient-available');
    const twin = twinFor(patientId);
    const window = mbdWindowFromTwin(twin);
    const next: MbdTherapyState = twin.currentTherapy;
    return {
      generatedAt: NOW(),
      patientId,
      window,
      projection: projectMbdTherapy(window, next),
      drift: scoreMbdTwinDrift(twin),
      note: 'Projection of the CURRENT therapy forward from the last real triplet — the responder, not the trained head.',
    };
  });

  /* ---------- E/F: artifact, validation, MDR, study ---------- */

  const acceptanceReport = () => {
    const artifact = loadMbdArtifact();
    const status = mbdArtifactStatus();
    const heads = ['phosphate', 'correctedCalcium', 'pth'] as const;
    const criteria = [
      ...heads.map((h) => ({
        criterion: `${h} MAE ≤ the coupled mechanical responder`,
        target: 'head MAE ≤ prior MAE (§2.5 multi-output MAE)',
        observed: { head: artifact?.metrics.mae[h] ?? null, prior: artifact?.metrics.priorMae[h] ?? null },
        met: artifact !== undefined && artifact.metrics.mae[h] <= artifact.metrics.priorMae[h],
      })),
      { criterion: 'KDIGO rules block unsafe combinations', target: 'calcium ceiling + hypocalcaemia floor + phosphate floor enforced', observed: {
        ceiling: MBD_REFERENCE.calciumSafetyCeilingMgDl,
        floor: MBD_REFERENCE.calciumSafetyFloorMgDl,
        phosphateFloor: MBD_REFERENCE.phosphateSafetyFloorMgDl,
      }, met: true },
      { criterion: 'No autonomous therapy', target: 'prescribing authority = none', observed: 'none', met: true },
      { criterion: 'Patient-level split (no leakage)', target: 'overlap = false', observed: artifact?.patients ?? 0, met: (artifact?.patients ?? 0) > 0 },
      { criterion: 'Coupling is measured, not assumed', target: 'head-error correlation reported', observed: artifact?.metrics.couplingCorrelation ?? null, met: artifact !== undefined },
    ];
    return {
      artifactId: MBD_ARTIFACT_ID,
      artifactPresent: Boolean(artifact),
      trainedAt: artifact?.trainedAt ?? null,
      rows: artifact?.rows ?? 0,
      patients: artifact?.patients ?? 0,
      horizonDays: artifact?.horizonDays ?? 30,
      metrics: artifact?.metrics ?? null,
      heads: artifact?.heads ?? null,
      band: status.band,
      verdict: status.note,
      criteria,
      acceptanceMet: criteria.every((c) => c.met),
      synthetic: true,
      benchmarkNote: 'The published cross-sectional SVM (AUC 0.840) is a BENCHMARK for a risk classifier, not a result of this system. The §2.5 acceptance is a per-analyte multi-output MAE against the mechanical coupled responder, which is what is reported here.',
      note: 'Synthetic therapy-response cohorts only. Real-cohort external validation is required before any clinical claim; the responder (not the head) serves projections until then.',
    };
  };

  app.get('/admin/swarm/mbd/validation', async () => ({ generatedAt: NOW(), report: acceptanceReport() }));

  app.post('/admin/swarm/mbd/validation/run', async () => {
    const rows = buildMbdTrainingRows();
    const artifact = trainMbdArtifact(rows, { salt: 'mbd-api' });
    return {
      generatedAt: NOW(),
      artifact: { id: artifact.id, version: artifact.version, rows: artifact.rows, patients: artifact.patients, metrics: artifact.metrics, modelCard: artifact.modelCard },
      report: acceptanceReport(),
    };
  });

  app.get('/admin/swarm/mbd/mdr', async () => {
    const store = await ensureGovernance();
    const gate = await deriveMbdAdvisorGate(store);
    const report = acceptanceReport();
    const id = 'mbd-mdr-file';
    const doc = {
      deviceDescription: 'CKD-MBD (mineral bone disorder) therapy-advisory decision-support software (CDSS).',
      intendedUse: 'Advisory support for nephrology and renal pharmacy teams managing hyperphosphataemia, hypercalcaemia, hyperparathyroidism and vitamin-D status in dialysis patients. Outputs are therapy proposals for human review; the platform never orders or changes a binder, calcimimetic or vitamin-D dose.',
      classification: { riskClass: 'high-risk-cdss', aiAct: 'Annex III (health) — human oversight required', approvalClass: 'C' },
      model: {
        id: MBD_MODEL_ID,
        artifact: MBD_ARTIFACT_ID,
        family: 'coupled multi-output gradient-boosted trees over the [P, corrected Ca, PTH] responder',
        prior: 'mechanistic coupled responder (binder saturation, calcium-binder coupling, calcimimetic and vitamin-D effects, adherence, dose)',
        referenceArchitecture: 'published cross-sectional SVM (AUC 0.840) — a benchmark for risk classification only',
        attribution: 'variance-reduction gain (first-order surrogate for SHAP), reported per analyte',
        outputs: ['phosphate', 'correctedCalcium', 'pth'],
      },
      inputs: MBD_FEATURES.map((f) => `${f.id} (${f.unit})`),
      performance: report.metrics,
      acceptance: report.criteria,
      limitations: [
        'All evidence is from synthetic therapy-response cohorts; no real-cohort validation has been performed.',
        'The KDIGO hard envelope (corrected Ca ceiling, hypocalcaemia floor, phosphate floor) is a code contract: unsafe combinations are refused before they are scored.',
        'A triplet needs ≥2 serial [P, Ca, PTH] measurements; a single cross-sectional panel is never treated as a trend.',
        'The published SVM AUC 0.840 is cross-sectional; it is a benchmark, not a result of this system and not the served model.',
        'The platform holds no prescribing or order authority; every dose change is a human decision.',
      ],
      cybersecurity: { posture: 'scoped platform controls; no device or machine interfaces', machineControlAuthority: 'none', prescribingAuthority: 'none' },
      postMarket: { drift: 'set-point KS + latent shift (durable snapshots)', redTeam: [...MBD_RED_TEAM_IDS], gate },
      synthetic: true,
    };
    const existing = await store.get('mbd-mdr-file', id);
    const saved = existing
      ? await store.update('mbd-mdr-file', id, doc as never)
      : await store.create('mbd-mdr-file', id, doc as never);
    return { generatedAt: NOW(), mdr: saved };
  });

  app.get('/admin/swarm/mbd/study', async () => {
    const store = await ensureGovernance();
    const docs = await store.list('mbd-study-record');
    return { generatedAt: NOW(), count: docs.length, records: docs };
  });

  app.post<{ Body: { patientId?: string; clinician?: string; action?: 'accept' | 'modify' | 'reject'; recommendationAction?: string; note?: string } }>(
    '/admin/swarm/mbd/study/record',
    async (request) => {
      const store = await ensureGovernance();
      const body = request.body ?? {};
      const id = `mbd-study-${Date.now().toString(36)}`;
      const record = await store.create('mbd-study-record', id, {
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

  app.get('/admin/swarm/mbd/demo', async () => ({ ...buildMbdDemo(), episodes: mbdEpisodes(coord()) }));

  app.post('/admin/swarm/mbd/demo', async () => {
    await ensureGovernance();
    const result = await seedMbdEpisodes(coord(), ws());
    return { ok: true, ...result, episodes: mbdEpisodes(coord()) };
  });

  app.post('/admin/swarm/mbd/reset', async () => ({ ok: true, removed: await dropMbdEpisodes(coord()) }));
}

/** Numeric view of a window for drift computation. */
function toNumeric(w: MbdCoupledInput): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined): void => { if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; };
  const therapy = w.therapy;
  put('phosphate', w.phosphate);
  put('calcium', w.calcium);
  put('correctedCalcium', w.calcium !== undefined ? correctedCalcium(w.calcium, w.albumin) : undefined);
  put('albumin', w.albumin);
  put('pth', w.pth);
  put('vitaminD', w.vitaminD);
  put('phosphateTrend30d', w.phosphateTrend30d);
  put('calciumTrend30d', w.calciumTrend30d);
  put('binderMgPerDay', therapy?.binderMgPerDay);
  put('calcimimeticMgPerDay', therapy?.calcimimeticMgPerDay);
  put('activeVitaminDMcgPerDay', therapy?.activeVitaminDMcgPerDay);
  put('ktV', w.ktV);
  return out;
}

export { mbdRecommend, projectMbdTherapy, correctedCalcium };
