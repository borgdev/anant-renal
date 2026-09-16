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

// G3 — the cross-pack hand-off, made observable.
//
// The defect was not that the workflows were missing. It was that they existed as
// a data structure nothing ran, so a reader of `cross-pack-workflows.ts` saw three
// orchestrated hand-offs and a reader of the running system saw none. Making that
// visible is half the fix; the other half is that which ones run is now decided by
// the packs' own declarations rather than by the frozen list.

import type { FastifyInstance } from 'fastify';
import {
  crossPackRouterState,
  recentCrossPackFirings,
  type CrossPackSeedIssue,
} from '../control-plane/cross-pack-workflows.js';

export interface CrossPackRouteOptions {
  /** Every installed pack id, so the route can say what is missing rather than only what is present. */
  readonly installedPackIds?: readonly string[];
}

export async function registerCrossPackRoutes(
  app: FastifyInstance,
  opts: CrossPackRouteOptions = {},
): Promise<void> {
  /**
   * Exec-scoped: a hand-off between a provider and a payer is a clinical-operations
   * fact, not a configuration fact. `/admin/assurance/*` was in NEITHER namespace
   * and fell into the ops bucket, which is how the exec console's own assurance
   * page came to 403 for the two clinical roles — so this is scoped deliberately
   * from the start rather than by omission.
   */
  app.get('/admin/swarm/cross-pack', async () => {
    const state = crossPackRouterState();
    const notRunning: readonly CrossPackSeedIssue[] = state?.notRunning ?? [];
    return {
      generatedAt: new Date().toISOString(),
      installed: opts.installedPackIds ?? [],
      // Three lists, because they are three different facts: what runs, what a
      // pack declared that cannot run, and where every declaration routes.
      running: state?.running ?? [],
      notRunning,
      declared: (state?.router.all() ?? []).map((w) => ({
        id: w.id,
        trigger: w.trigger,
        actions: w.actions.map((a) => (a.kind === 'audit' ? { kind: a.kind, action: a.action } : { kind: a.kind, packId: a.packId })),
        ...(w.slaHours !== undefined ? { slaHours: w.slaHours } : {}),
      })),
      // Firings, most recent last. Bounded in-process: this answers "is the
      // hand-off actually running", and the audit line the `audit` action writes to
      // the process log is the record that outlives the process.
      firings: recentCrossPackFirings(),
      note: 'A workflow runs only when every pack its definition involves declares it. `notRunning` names the ones that cannot, with the reason.',
    };
  });
}
