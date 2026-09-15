/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// The payer pack's own endpoints.
//
// This file used to be `src/server/payer-routes.ts` — a platform module that
// happened to serve payer. It lives here now because it IS the pack: the
// endpoints a specialty serves are part of the specialty, and a platform that
// registers them by name cannot claim a second specialty arrives without
// touching the platform.
//
//   GET  /admin/swarm/payer/cells   — 6 payer bounded cells
//   GET  /admin/swarm/payer/state   — payer reference boundary + live episodes
//   POST /admin/swarm/payer/demo    — install the payer org (lens) + seed durable
//                                     payer episodes on the SHARED coordinator
//   POST /admin/swarm/payer/reset   — remove only payer episodes
//
// Everything runs through the same durable workspace, outcome coordinator and
// generic platform contracts as renal — the payer proof is configuration + a
// second pack, not a runtime fork. Episodes seeded here flow into My Work
// (/api/work) and the exec console exactly like renal episodes.
//
// The workspace and the coordinator arrive as DEPENDENCIES rather than being
// imported. The pack must not capture a store the platform is free to rebuild,
// and it must not know how the platform resolves one.

import type { PackRouteContribution } from '../../src/control-plane/pack-contributions.js';
import {
  buildPayerDemo,
  dropPayerEpisodes,
  payerEpisodes,
  seedPayerEpisodes,
  PAYER_CELLS,
  PAYER_ORG,
} from '../../src/swarm/payer.js';

/** The payer pack's route surface. */
export const payerRoutes: readonly PackRouteContribution[] = Object.freeze([
  {
    id: 'payer',
    scope: 'exec',
    prefixes: ['/admin/swarm/payer'],
    register(app, deps) {
      const ws = deps.workspace;
      const coord = deps.coordinator;

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
        await ws().savePlatformOrganization(PAYER_ORG);
        const { opened, existing, closed } = await seedPayerEpisodes(coord(), ws());
        const reference = buildPayerDemo();
        return {
          ok: true,
          installed: true,
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
    },
  },
]);
