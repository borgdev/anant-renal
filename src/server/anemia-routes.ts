/******************************************************************************
 * Anemia / ESA CDSS routes — P0 reference decision support + P1 governance.
 *
 *   GET  /admin/swarm/anemia/cells       — bounded anemia cells (CellManifest)
 *   GET  /admin/swarm/anemia/features    — clinical feature catalog + target band
 *   GET  /admin/swarm/anemia/state       — reference boundary + live episodes
 *   POST /admin/swarm/anemia/advise      — CDSS: recommend an ESA dose for a
 *                                          patient window (coverage-gated; the
 *                                          surrogate is deterministic)
 *   POST /admin/swarm/anemia/demo        — seed durable anemia episodes (Class C)
 *   POST /admin/swarm/anemia/reset       — remove only anemia episodes
 *   GET  /admin/swarm/anemia/assurance   — P1: coverage config + advisor gate +
 *                                          red-team runs + findings + drift
 *   POST /admin/swarm/anemia/red-team    — P1: run rt-013..rt-016 vs live policy
 *   POST /admin/swarm/anemia/drift       — P1: KS drift snapshot (durable)
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
import type { RedTeamRun, SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface AnemiaRouteOptions {
  /** Seed the durable anemia episodes on POST /demo. Default true. */
  seed?: boolean;
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

  app.get('/admin/swarm/anemia/cells', async () => ({ cells: ESA_CELLS }));

  app.get('/admin/swarm/anemia/features', async () => ({
    features: ESA_FEATURES,
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
  app.post<{ Body: EsaPatientWindow & { model?: 'reference' | 'trained' } }>('/admin/swarm/anemia/advise', async (req, reply) => {
    const body = req.body ?? ({} as Partial<EsaPatientWindow & { model?: 'reference' | 'trained' }>);
    if (!body.patientId || body.currentHgb === undefined || body.onESA === undefined) {
      return error(reply, 400, 'patientId, currentHgb and onESA are required');
    }
    const window: EsaPatientWindow = {
      patientId: body.patientId,
      ...(body.facilityId ? { facilityId: body.facilityId } : {}),
      currentHgb: body.currentHgb,
      ...(body.mcv !== undefined ? { mcv: body.mcv } : {}),
      ...(body.ferritin !== undefined ? { ferritin: body.ferritin } : {}),
      ...(body.transferrinSat !== undefined ? { transferrinSat: body.transferrinSat } : {}),
      ...(body.crp !== undefined ? { crp: body.crp } : {}),
      ...(body.calcium !== undefined ? { calcium: body.calcium } : {}),
      ...(body.pth !== undefined ? { pth: body.pth } : {}),
      onESA: body.onESA,
      currentDose: body.currentDose ?? 0,
      hgbTrendLast90d: body.hgbTrendLast90d ?? [],
      esaEscalationsLast90d: body.esaEscalationsLast90d ?? 0,
      ...(body.lastIronPanelAt ? { lastIronPanelAt: body.lastIronPanelAt } : {}),
      asOf: body.asOf ?? new Date().toISOString(),
    };
    if (body.model === 'trained') {
      const artifact = loadEsaArtifact();
      if (!artifact) return error(reply, 404, 'esa-trained-artifact-not-found');
      return { recommendation: esaRecommendTrained(window, artifact), model: 'trained' };
    }
    return { recommendation: esaRecommendCovered(window, { coverageGateEnabled: true }), model: 'reference' };
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
}
