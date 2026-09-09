/******************************************************************************
 * Anemia / ESA CDSS routes — P0 reference decision support.
 *
 *   GET  /admin/swarm/anemia/cells     — bounded anemia cells (CellManifest)
 *   GET  /admin/swarm/anemia/features  — clinical feature catalog + target band
 *   GET  /admin/swarm/anemia/state     — reference boundary + live episodes
 *   POST /admin/swarm/anemia/advise    — CDSS: recommend an ESA dose for a
 *                                        patient window (surrogate, deterministic)
 *   POST /admin/swarm/anemia/demo      — seed durable anemia episodes (Class C)
 *   POST /admin/swarm/anemia/reset     — remove only anemia episodes
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
  ESA_CELLS, ESA_FEATURES, esaRecommend, HGB_TARGET, ESA_ADVISOR_MODEL,
  type EsaPatientWindow,
} from '../swarm/anemia.js';
import type { SwarmWorkspaceStore } from '../swarm/workspace.js';

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
   *  recommendation + latent position + drivers + guardrail verdicts. */
  app.post<{ Body: EsaPatientWindow }>('/admin/swarm/anemia/advise', async (req, reply) => {
    const body = req.body ?? ({} as Partial<EsaPatientWindow>);
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
    return { recommendation: esaRecommend(window) };
  });

  app.post('/admin/swarm/anemia/demo', async () => {
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
}
