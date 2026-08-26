/******************************************************************************
 * Payer proof routes — Phase 5 / Epic 7.
 *
 *   GET  /admin/swarm/payer/cells   — 6 payer bounded cells
 *   GET  /admin/swarm/payer/state   — payer reference boundary + live episodes
 *   POST /admin/swarm/payer/demo    — install the payer org (lens) + seed durable
 *                                     payer episodes on the SHARED coordinator
 *   POST /admin/swarm/payer/reset   — remove only payer episodes
 *
 * Everything runs through the same durable workspace, outcome coordinator and
 * generic platform contracts as renal — the payer proof is configuration + a
 * second pack, not a runtime fork. Episodes seeded here flow into My Work
 * (/api/work) and the exec console exactly like renal episodes.
 ******************************************************************************/

import type { FastifyInstance } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import { buildPayerDemo, dropPayerEpisodes, payerEpisodes, seedPayerEpisodes, PAYER_CELLS, PAYER_ORG } from '../swarm/payer.js';
import type { SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface PayerRouteOptions {
  /** Persist the payer org (flips /api/context lens to payer). Default true. */
  installOrg?: boolean;
}

export async function registerPayerRoutes(app: FastifyInstance, opts: PayerRouteOptions = {}): Promise<void> {
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

  app.get('/admin/swarm/payer/cells', async () => ({ cells: PAYER_CELLS }));

  app.get('/admin/swarm/payer/state', async () => {
    const reference = buildPayerDemo();
    return {
      ...reference,
      episodes: payerEpisodes(coord()),
      org: (await ws().getPlatformOrganization()) ?? null,
    };
  });

  app.post('/admin/swarm/payer/demo', async () => {
    const installOrg = opts.installOrg ?? true;
    if (installOrg) {
      await ws().savePlatformOrganization(PAYER_ORG);
    }
    const { opened, existing, closed } = await seedPayerEpisodes(coord(), ws());
    const reference = buildPayerDemo();
    return {
      ok: true,
      installed: installOrg,
      lens: 'payer',
      opened,
      existing,
      closed,
      episodes: payerEpisodes(coord()),
      org: await ws().getPlatformOrganization(),
      reference,
    };
  });

  app.post('/admin/swarm/payer/reset', async () => {
    const removed = await dropPayerEpisodes(coord());
    return { ok: true, removed };
  });
}
