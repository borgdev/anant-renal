/******************************************************************************
 * Anemia / ESA CDSS routes — P0 reference decision support + P1 governance.
 *
 *   GET  /admin/swarm/anemia/cells       — bounded anemia cells (CellManifest)
 *   GET  /admin/swarm/anemia/features    — clinical feature catalog + target band
 *   GET  /admin/swarm/anemia/state       — reference boundary + live episodes
 *   POST /admin/swarm/anemia/advise      — CDSS: recommend an ESA dose for a
 *                                          patient window (coverage-gated; the
 *                                          surrogate is deterministic). Body
 *                                          model: 'reference' | 'trained' | 'mpc'
 *                                          ('mpc' = slice-2 dose optimizer)
 *   POST /admin/swarm/anemia/what-if     — slice-1/2: project the 12-week Hb path
 *                                          under each candidate dose + MPC choice
 *   POST /admin/swarm/anemia/exposure    — slice-3 (Paper A): PK cumulative /
 *                                          time-weighted exposure readout
 *   POST /admin/swarm/anemia/twin        — slice-4: patient twin from the REAL
 *                                          ledger + patient state, with what-if
 *                                          and ONLINE forecast-vs-observed drift
 *   POST /admin/swarm/anemia/twin/score  — persist the online drift snapshot
 *   GET  /admin/swarm/anemia/twin/drift  — durable drift snapshots
 *   POST /admin/swarm/anemia/phenotype   — slice-5 (Paper B): ESA responsiveness
 *                                          phenotype + recommended workup
 *   POST /admin/swarm/anemia/demo        — seed durable anemia episodes (Class C)
 *   POST /admin/swarm/anemia/reset       — remove only anemia episodes
 *   GET  /admin/swarm/anemia/assurance   — P1: coverage config + advisor gate +
 *                                          red-team runs + findings + drift
 *   POST /admin/swarm/anemia/red-team    — P1: run rt-013..rt-016 vs live policy
 *   POST /admin/swarm/anemia/drift       — P1: KS drift snapshot (durable)
 *   GET  /admin/swarm/anemia/validation  — P3: external validation report
 *   POST /admin/swarm/anemia/validation/run — P3: run external validation
 *   GET  /admin/swarm/anemia/study       — P3: study-mode acceptance records/stats
 *   POST /admin/swarm/anemia/study/record  — P3: record a clinician decision
 *   GET  /admin/swarm/anemia/mdr         — P3: MDR / EU-AI-Act technical file
 *
 * Everything runs through the same durable workspace, outcome coordinator and
 * generic platform contracts as renal/payer. Episodes flow into My Work for the
 * medical role. This is a CDSS — it recommends, it never orders; the dose is
 * Class C human-approved before any command. Exec-guarded by /admin/swarm/*.
 ******************************************************************************/

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import {
  buildAnemiaDemo, dropAnemiaEpisodes, anemiaEpisodes, seedAnemiaEpisodes,
  ESA_CELLS, ESA_FEATURES, HGB_TARGET, ESA_ADVISOR_MODEL,
  type EsaPatientWindow,
} from '../swarm/anemia.js';
import {
  ESA_COVERAGE_DEFAULTS, ESA_MODEL_ID, ESA_REGULATORY_POSTURE, ESA_RED_TEAM_DEFS,
  deriveEsaAdvisorGate, ensureEsaModel, ensureEsaRedTeamScenarios, esaRecommendCovered,
  esaRedTeamProbe, isEsaFinding, recordEsaDrift,
} from '../swarm/anemia-governance.js';
import { esaRecommendTrained, loadEsaArtifact } from '../swarm/anemia-model.js';
import { esaRecommendMpc, esaWhatIf } from '../swarm/anemia-forecast.js';
import { esaExposure, ESA_EXPOSURE_CATALOG, type EsaExposureOptions } from '../swarm/anemia-exposure.js';
import { esaResponsiveness, ESA_PHENOTYPE_CATALOG } from '../swarm/anemia-phenotype.js';
import { esaSuggestionDst } from '../swarm/anemia-dst.js';
import {
  buildEsaTwin, scoreEsaTwinDrift,
  type EsaTwin, type EsaTwinDriftScore, type EsaTwinEventInput, type EsaTwinPatientInput, type EsaTwinProvenance,
} from '../swarm/anemia-twin.js';
import {
  ensureEsaMdrFile, esaAcceptanceStats, getEsaMdrFile, getEsaValidationReport,
  listEsaStudyRecords, recordEsaStudyDecision, runEsaValidation,
  type EsaClinicianAction,
} from '../swarm/anemia-validation.js';
import type { RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface AnemiaRouteOptions {
  /** Seed the durable anemia episodes on POST /demo. Default true. */
  seed?: boolean;
  /** Real realm ledger events for the patient twin (defaults to none). */
  events?: () => EsaTwinEventInput[];
  /** Live patient twin state for the patient twin (defaults to none). */
  patients?: () => EsaTwinPatientInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });

export async function registerAnemiaRoutes(app: FastifyInstance, opts: AnemiaRouteOptions = {}): Promise<void> {
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

  /** P1 — register the advisor in the model registry + ensure rt-013..016 exist. */
  const ensureEsaGovernance = async (): Promise<void> => {
    await ensureEsaRedTeamScenarios(ws());
    await ensureEsaModel(ws());
  };

  /** Build the patient window from a request body (shared by advise/what-if/exposure). */
  const buildWindow = (body: Partial<EsaPatientWindow>): EsaPatientWindow => ({
    patientId: body.patientId as string,
    ...(body.facilityId ? { facilityId: body.facilityId } : {}),
    currentHgb: body.currentHgb as number,
    ...(body.mcv !== undefined ? { mcv: body.mcv } : {}),
    ...(body.ferritin !== undefined ? { ferritin: body.ferritin } : {}),
    ...(body.transferrinSat !== undefined ? { transferrinSat: body.transferrinSat } : {}),
    ...(body.crp !== undefined ? { crp: body.crp } : {}),
    ...(body.calcium !== undefined ? { calcium: body.calcium } : {}),
    ...(body.pth !== undefined ? { pth: body.pth } : {}),
    onESA: body.onESA as boolean,
    currentDose: body.currentDose ?? 0,
    hgbTrendLast90d: body.hgbTrendLast90d ?? [],
    esaEscalationsLast90d: body.esaEscalationsLast90d ?? 0,
    ...(body.lastIronPanelAt ? { lastIronPanelAt: body.lastIronPanelAt } : {}),
    ...(body.esaDosingHistory ? { esaDosingHistory: body.esaDosingHistory } : {}),
    ...(body.ivIronHistory ? { ivIronHistory: body.ivIronHistory } : {}),
    asOf: body.asOf ?? new Date().toISOString(),
  });

  const missingWindow = (body: Partial<EsaPatientWindow>): boolean =>
    !body.patientId || body.currentHgb === undefined || body.onESA === undefined;

  const twinEvents = (): EsaTwinEventInput[] => opts.events?.() ?? [];
  const twinPatients = (): EsaTwinPatientInput[] => opts.patients?.() ?? [];

  /** Persist a durable drift snapshot for one patient (idempotent per patient). */
  const persistTwinDrift = async (patientId: string, twin: EsaTwin, drift: EsaTwinDriftScore): Promise<boolean> => {
    const store = ws();
    const id = `esa-twin-drift:${patientId}`;
    const now = new Date().toISOString();
    const doc = {
      id,
      createdAt: now,
      updatedAt: now,
      patientId,
      realmId: twin.realmId,
      asOf: twin.asOf,
      provenance: twin.provenance as EsaTwinProvenance,
      score: drift,
      recordedAt: now,
    };
    const existing = (await store.list('esa-twin-drift')).find((row) => row.id === id);
    if (existing) {
      await store.update('esa-twin-drift', id, doc);
    } else {
      await store.create('esa-twin-drift', id, doc);
    }
    return true;
  };

  app.get('/admin/swarm/anemia/cells', async () => ({ cells: ESA_CELLS }));

  app.get('/admin/swarm/anemia/features', async () => ({
    features: ESA_FEATURES,
    exposureFeatures: ESA_EXPOSURE_CATALOG,
    hgbTarget: HGB_TARGET,
    model: ESA_ADVISOR_MODEL,
    safety: { posture: 'cdss-human-in-the-loop', approvalClass: 'C', synthetic: true },
  }));

  app.get('/admin/swarm/anemia/state', async () => {
    const reference = buildAnemiaDemo();
    return {
      ...reference,
      episodes: anemiaEpisodes(coord()),
    };
  });

  /** CDSS advise — given a patient's weekly feature window, return the dose
   *  recommendation + latent position + drivers + guardrail verdicts. The body
   *  may select `model: 'reference'` (default surrogate) or `'trained'` (the P2
   *  exported latent model, served under the SAME contract + gates). */
  app.post<{ Body: EsaPatientWindow & { model?: 'reference' | 'trained' | 'mpc' } }>('/admin/swarm/anemia/advise', async (req, reply) => {
    const body = req.body ?? ({} as Partial<EsaPatientWindow & { model?: 'reference' | 'trained' | 'mpc' }>);
    if (missingWindow(body)) return error(reply, 400, 'patientId, currentHgb and onESA are required');
    const window = buildWindow(body);
    // Paper-A PK-informed cumulative / time-weighted exposure (130 h decay).
    const exposure = esaExposure(window);
    // Paper-B responsiveness phenotype (routine-lab surrogates for the panel).
    const phenotype = esaResponsiveness(window);
    // DST-Q #3 — fuse the evidence this window actually carries into a Bel/Pl/K
    // readout for the Class-C suggestion (same D-S rule as My Work).
    const dst = esaSuggestionDst(window);
    if (body.model === 'mpc') {
      const { recommendation, whatIf } = esaRecommendMpc(window);
      return { recommendation: { ...recommendation, exposure, phenotype }, model: 'mpc', dst, whatIf };
    }
    if (body.model === 'trained') {
      const artifact = loadEsaArtifact();
      if (!artifact) return error(reply, 404, 'esa-trained-artifact-not-found');
      return { recommendation: { ...esaRecommendTrained(window, artifact), exposure, phenotype }, model: 'trained', dst };
    }
    return { recommendation: { ...esaRecommendCovered(window, { coverageGateEnabled: true }), exposure, phenotype }, model: 'reference', dst };
  });

  /** Slice 5 / Paper B — ESA responsiveness phenotype (functional iron
   *  deficiency / inflammatory resistance / refractory / responsive) from the
   *  routine-lab surrogates, plus the recommended workup. */
  app.post<{ Body: Partial<EsaPatientWindow> }>('/admin/swarm/anemia/phenotype', async (req, reply) => {
    const body = req.body ?? ({} as Partial<EsaPatientWindow>);
    if (missingWindow(body)) return error(reply, 400, 'patientId, currentHgb and onESA are required');
    return { phenotype: esaResponsiveness(buildWindow(body)), catalog: ESA_PHENOTYPE_CATALOG };
  });

  /** Slice 3 / Paper A — PK exposure features: 130 h-decayed cumulative and
   *  time-weighted ESA exposure, dose–time product, 14-day IV iron load, and the
   *  effective weekly dose implied by the dosing history. */
  app.post<{ Body: Partial<EsaPatientWindow> & { halfLifeHours?: number; intervalDays?: number } }>('/admin/swarm/anemia/exposure', async (req, reply) => {
    const body = req.body ?? ({} as Partial<EsaPatientWindow> & { halfLifeHours?: number; intervalDays?: number });
    if (missingWindow(body)) return error(reply, 400, 'patientId, currentHgb and onESA are required');
    const exposureOpts: EsaExposureOptions = {
      ...(body.asOf ? { asOf: body.asOf } : {}),
      ...(body.halfLifeHours !== undefined ? { halfLifeHours: body.halfLifeHours } : {}),
      ...(body.intervalDays !== undefined ? { intervalDays: body.intervalDays } : {}),
    };
    return { exposure: esaExposure(buildWindow(body), exposureOpts), catalog: ESA_EXPOSURE_CATALOG };
  });

  /** Slice 1/2 — dose what-if: project the weekly Hb path under each candidate
   *  dose (suspend / 50 / 75 / hold / 125 / 150%) and let the MPC objective pick
   *  the dose that keeps the patient in the 10–12 band with the least
   *  intervention. Advisory only — iron-first guardrails still apply. */
  app.post<{ Body: Partial<EsaPatientWindow> & { horizonWeeks?: number } }>('/admin/swarm/anemia/what-if', async (req, reply) => {
    const body = req.body ?? ({} as Partial<EsaPatientWindow> & { horizonWeeks?: number });
    if (missingWindow(body)) return error(reply, 400, 'patientId, currentHgb and onESA are required');
    const window = buildWindow(body);
    return { whatIf: esaWhatIf(window, { ...(body.horizonWeeks !== undefined ? { horizonWeeks: body.horizonWeeks } : {}) }) };
  });

  /** Slice 4 / Paper A — patient twin: derive the governed ESA window for a REAL
   *  patient from the realm event ledger + patient state, project the dose
   *  response, and score forecast-vs-observed drift ONLINE. */
  app.post<{ Body: { patientId?: string; horizonWeeks?: number; persist?: boolean } }>('/admin/swarm/anemia/twin', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.patientId) return error(reply, 400, 'patientId is required');
    const twin = buildEsaTwin({ patientId: body.patientId, events: twinEvents(), patients: twinPatients() });
    const whatIf = twin.window
      ? esaWhatIf(twin.window, { ...(body.horizonWeeks !== undefined ? { horizonWeeks: body.horizonWeeks } : {}) })
      : null;
    const drift = scoreEsaTwinDrift(twin);
    const persisted = body.persist ? await persistTwinDrift(body.patientId, twin, drift) : false;
    return { twin, whatIf, drift, persisted, phenotype: twin.window ? esaResponsiveness(twin.window) : null };
  });

  /** Slice 4 — persist / refresh the online forecast-vs-observed drift snapshot. */
  app.post<{ Body: { patientId?: string; persist?: boolean } }>('/admin/swarm/anemia/twin/score', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.patientId) return error(reply, 400, 'patientId is required');
    const twin = buildEsaTwin({ patientId: body.patientId, events: twinEvents(), patients: twinPatients() });
    const drift = scoreEsaTwinDrift(twin);
    const persisted = body.persist === false ? false : await persistTwinDrift(body.patientId, twin, drift);
    return { drift, persisted, provenance: twin.provenance, hasWindow: twin.window !== null };
  });

  /** Slice 4 — durable drift snapshots (optionally filtered by patient). */
  app.get<{ Querystring: { patientId?: string } }>('/admin/swarm/anemia/twin/drift', async (req) => {
    const rows = await ws().list('esa-twin-drift');
    const patientId = req.query?.patientId;
    const filtered = patientId ? rows.filter((row) => row.id === `esa-twin-drift:${patientId}`) : rows;
    return { rows: filtered };
  });

  app.post('/admin/swarm/anemia/demo', async () => {
    await ensureEsaGovernance();
    const seed = opts.seed ?? true;
    const { opened, existing, closed } = seed ? await seedAnemiaEpisodes(coord(), ws()) : { opened: [] as string[], existing: [] as string[], closed: [] as string[] };
    const reference = buildAnemiaDemo();
    return {
      ok: true,
      seeded: seed,
      lens: 'provider',
      opened,
      existing,
      closed,
      episodes: anemiaEpisodes(coord()),
      reference,
    };
  });

  app.post('/admin/swarm/anemia/reset', async () => {
    const removed = await dropAnemiaEpisodes(coord());
    return { ok: true, removed };
  });

  /** P2 — trained-model metadata (served through the same contract + gates). */
  app.get('/admin/swarm/anemia/trained-model', async () => {
    await ensureEsaGovernance();
    const artifact = loadEsaArtifact();
    if (!artifact) return { registered: false };
    return {
      registered: true,
      model: artifact.model,
      architecture: artifact.architecture,
      metrics: artifact.metrics,
      relevance: artifact.relevance,
      golden: { window: artifact.golden.window, prediction: artifact.golden.prediction },
      synthetic: artifact.synthetic,
    };
  });

  /* ==================================================================
   * P1 governance — safe by default
   * ================================================================== */

  /** Assurance dashboard: coverage config, advisor gate, red-team + drift. */
  app.get('/admin/swarm/anemia/assurance', async () => {
    await ensureEsaGovernance();
    const store = ws();
    const models = await store.listModels();
    const registeredModel = models.find((m) => m.modelId === ESA_MODEL_ID) ?? null;
    const runs = (await store.listRedTeamRuns()).filter((r) => (ESA_RED_TEAM_DEFS as readonly { id: string }[]).some((d) => d.id === r.scenarioId));
    const findings = (await store.listFindings()).filter((f) => isEsaFinding(f));
    const drift = (await store.listDrift()).filter((d) => d.targetId === ESA_MODEL_ID);
    return {
      source: 'anemia',
      model: { registered: Boolean(registeredModel), ...(registeredModel ? { record: registeredModel } : {}) },
      coverage: { enabled: true, defaults: ESA_COVERAGE_DEFAULTS, features: ESA_FEATURES.length },
      gate: await deriveEsaAdvisorGate(store),
      redTeam: {
        scenarios: ESA_RED_TEAM_DEFS.map((d) => ({ id: d.id, name: d.name, threatModel: d.threatModel, probeLabel: d.probeLabel, probe: esaRedTeamProbe(d) })),
        latestRuns: ESA_RED_TEAM_DEFS.map((d) => {
          const last = runs.find((r) => r.scenarioId === d.id);
          return last ? { scenarioId: d.id, passed: last.passed, at: last.updatedAt } : null;
        }).filter(Boolean),
      },
      drift,
      findings,
      posture: ESA_REGULATORY_POSTURE,
      validation: await getEsaValidationReport(store),
      study: esaAcceptanceStats(await listEsaStudyRecords(store)),
      mdr: await ensureEsaMdrFile(store),
    };
  });

  /** Run the four ESA red-team scenarios against the live policy; failing runs
   *  create durable findings (which then block the advisor gate). */
  app.post('/admin/swarm/anemia/red-team', async (req) => {
    await ensureEsaGovernance();
    const store = ws();
    const body = (req.body ?? {}) as { ranBy?: string; releaseId?: string };
    const policy = await store.getAdminPolicy();
    const runs: RedTeamRun[] = [];
    const findings = [];
    for (const def of ESA_RED_TEAM_DEFS) {
      const run = await store.replayRedTeamScenario(def.id, {
        ...(body.ranBy ? { ranBy: body.ranBy } : {}),
        policy: { defaultDecision: policy.defaultDecision, externalWritesEnabled: policy.externalWritesEnabled },
      });
      runs.push(run);
      if (!run.passed) {
        const failed = run.checks.filter((c) => !c.passed);
        findings.push(await store.createFinding({
          severity: 'high',
          title: `Red-team failure: ${def.name}`,
          description: `The ESA adversarial scenario '${def.name}' failed under the current runtime policy (${policy.defaultDecision}).`,
          threatModel: def.threatModel,
          scenarioId: def.id,
          runId: run.id,
          expectedControl: def.expected,
          observed: failed.map((c) => `${c.name}: ${c.observed}`).join('; '),
          evidenceHash: run.evidenceHash,
          ...(body.releaseId ? { releaseId: body.releaseId } : {}),
        }));
      }
    }
    return { ok: true, runs, findings, passed: findings.length === 0 };
  });

  /** Write a durable KS drift snapshot for the ESA model (per-feature). */
  app.post<{ Body: { baseline?: number[]; current?: number[]; metric?: string } }>('/admin/swarm/anemia/drift', async (req) => {
    await ensureEsaGovernance();
    const body = req.body ?? ({} as { baseline?: number[]; current?: number[]; metric?: string });
    const baseline = body.baseline ?? [10.0, 10.3, 10.5, 10.6, 10.8, 11.0, 11.1, 11.2, 11.4, 11.5];
    const current = body.current ?? baseline.map((v) => Number((v + 0.2).toFixed(1)));
    const snapshot = await recordEsaDrift(ws(), { baseline, current, metric: body.metric ?? 'hgb-distribution-ks' });
    return { ok: true, snapshot };
  });

  /* ==================================================================
   * P3 — external validation & regulatory readiness
   * ================================================================== */

  /** Durable external-validation report (consumed by assurance / gates). */
  app.get('/admin/swarm/anemia/validation', async () => {
    await ensureEsaGovernance();
    const report = await getEsaValidationReport(ws());
    return { registered: Boolean(report), ...(report ? { report } : {}) };
  });

  /** Run external validation of the trained model on the site-B cohort. */
  app.post<{ Body: { siteId?: string; seed?: number; cohortSize?: number } }>('/admin/swarm/anemia/validation/run', async (req, reply) => {
    await ensureEsaGovernance();
    const artifact = loadEsaArtifact();
    if (!artifact) return error(reply, 404, 'esa-trained-artifact-not-found');
    const body = req.body ?? ({} as { siteId?: string; seed?: number; cohortSize?: number });
    const report = await runEsaValidation(ws(), artifact, {
      ...(body.siteId ? { siteId: body.siteId } : {}),
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(body.cohortSize !== undefined ? { cohortSize: body.cohortSize } : {}),
    });
    return { ok: true, report };
  });

  /** Study-mode acceptance records + analytics (suggest, don't auto-act). */
  app.get('/admin/swarm/anemia/study', async () => {
    await ensureEsaGovernance();
    const records = await listEsaStudyRecords(ws());
    return { records, stats: esaAcceptanceStats(records) };
  });

  /** Record one clinician decision on a Class-C suggestion. */
  app.post<{ Body: { patientId: string; recommendedDose: number; clinicianAction: EsaClinicianAction; adjustedDose?: number; by?: string; note?: string; window: { currentHgb: number; currentDose: number }; modelId?: string; modelVersion?: string } }>('/admin/swarm/anemia/study/record', async (req, reply) => {
    await ensureEsaGovernance();
    const body = req.body ?? ({} as Partial<{ patientId: string; recommendedDose: number; clinicianAction: EsaClinicianAction; adjustedDose?: number; by?: string; note?: string; window: { currentHgb: number; currentDose: number }; modelId?: string; modelVersion?: string }>);
    if (!body.patientId || body.recommendedDose === undefined || !body.clinicianAction || !body.window) {
      return error(reply, 400, 'patientId, recommendedDose, clinicianAction and window are required');
    }
    const actions: EsaClinicianAction[] = ['accepted', 'adjusted', 'rejected', 'withheld'];
    if (!actions.includes(body.clinicianAction)) return error(reply, 400, `clinicianAction must be one of ${actions.join('|')}`);
    const record = await recordEsaStudyDecision(ws(), {
      patientId: body.patientId,
      modelId: body.modelId ?? 'anemia.esa-dose-v1',
      modelVersion: body.modelVersion ?? '1.0.0',
      recommendedDose: body.recommendedDose,
      clinicianAction: body.clinicianAction,
      ...(body.adjustedDose !== undefined ? { adjustedDose: body.adjustedDose } : {}),
      by: body.by ?? 'Dr. Alvarez (nephrology)',
      ...(body.note ? { note: body.note } : {}),
      window: body.window,
    });
    const records = await listEsaStudyRecords(ws());
    return { ok: true, record, stats: esaAcceptanceStats(records) };
  });

  /** MDR / EU-AI-Act technical file (risk class, intended use, XAI + HITL). */
  app.get('/admin/swarm/anemia/mdr', async () => {
    await ensureEsaGovernance();
    const file = await ensureEsaMdrFile(ws());
    return { file };
  });
}
