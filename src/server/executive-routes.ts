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

/******************************************************************************
 * Journey N — Executive outcomes and delegation.
 *
 *   GET  /admin/executive/outcomes        — verified-value rollup (value, not
 *                                           activity counts), from resolved
 *                                           outcome episodes w/ met measures
 *   GET  /admin/executive/delegations     — durable delegations
 *   POST /admin/executive/delegate        — sponsor/delegate analysis to an
 *                                           owner with an SLA
 *   POST /admin/executive/delegations/:id/status — advance/complete + outcome
 *
 * Delegated work carries owner + SLA; the delegate returns a verified outcome.
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSwarmWorkspace, getSwarmCoordinator } from './swarm-routes.js';
import type { SwarmWorkspaceStore, DelegatedWork } from '../swarm/workspace.js';

export async function registerExecutiveRoutes(app: FastifyInstance): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };
  const error = (reply: FastifyReply, code: number, message: string): FastifyReply => reply.code(code).send({ error: message });

  app.get('/admin/executive/outcomes', async () => {
    const episodes = (getSwarmCoordinator()?.list() ?? []).map((e) => ({
      kind: e.kind,
      state: e.state,
      ...(e.measureResult ? { measureResult: e.measureResult } : {}),
    }));
    const rollup = await ws().verifiedOutcomes(episodes);
    return { outcomes: rollup, episodes: episodes.filter((e) => e.state === 'Resolved').map((e) => ({ kind: e.kind, state: e.state })) };
  });

  app.get('/admin/executive/delegations', async () => ({ delegations: await ws().listDelegations() }));

  app.post<{ Body: { title: string; reason?: string; sourceId?: string; owner: string; sla?: string; delegatedBy?: string } }>(
    '/admin/executive/delegate',
    async (req, reply) => {
      try {
        const delegation = await ws().createDelegation({
          title: req.body?.title ?? '',
          reason: req.body?.reason ?? '',
          sourceId: req.body?.sourceId ?? '',
          owner: req.body?.owner ?? '',
          sla: req.body?.sla ?? '',
          delegatedBy: req.body?.delegatedBy ?? '',
        });
        return { delegation };
      } catch (err) {
        return error(reply, 400, err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { status?: DelegatedWork['status']; verified?: boolean; value?: number; note?: string } }>(
    '/admin/executive/delegations/:id/status',
    async (req, reply) => {
      const delegation = await ws().updateDelegation(req.params.id, {
        ...(req.body?.status ? { status: req.body.status } : {}),
        ...(req.body?.verified !== undefined
          ? { outcome: { verified: Boolean(req.body.verified), ...(req.body.value !== undefined ? { value: req.body.value } : {}), ...(req.body.note ? { note: req.body.note } : {}) } }
          : {}),
      });
      if (!delegation) return error(reply, 404, 'delegation-not-found');
      return { delegation };
    },
  );
}
