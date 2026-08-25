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

// Durable storage + M25 nudge delivery + CQL scoring of learned trajectories.
//
//   GET  /admin/sql/realms            — persisted realm snapshots (durable local realms)
//   GET  /admin/sql/realms/:id        — one persisted realm snapshot
//   GET  /admin/sql/billing           — persisted billing usage (durable local billing)
//   GET  /admin/sql/counterfactuals   — persisted counterfactual runs
//   POST /admin/nudges                — deliver a rehearsed nudge through a channel adapter
//   GET  /admin/nudges                — durable nudge ledger (survives restarts)
//   POST /admin/nudges/:id/observe    — close the loop (expected vs observed)
//   POST /admin/liquid/score          — score liquid-lab patients with the real CQL evaluator
//
// All reads/writes go through the SqlStore → SqlDb seam, so swapping SQLite for Postgres is
// purely a `buildSqlDb()` concern.

import type { FastifyInstance } from 'fastify';
import { getSqlStore } from './sql/index.js';
import { InAppNudgeChannel, NudgeLedger, StubNudgeChannel, sqliteNudgePersistence, type NudgeSpec } from '../realm/index.js';
import { RealmRegistry } from '../realm/index.js';
import { scoreLabs, type LabPatient } from '../liquid/index.js';
import { getMeasureEvaluator } from './admin-routes.js';

export async function registerSqlRoutes(app: FastifyInstance): Promise<void> {
  const store = await getSqlStore();

  // ---- Durable local realms ----
  app.get('/admin/sql/realms', async () => ({ realms: await store.listRealmSnapshots() }));
  app.get<{ Params: { id: string } }>('/admin/sql/realms/:id', async (req, reply) => {
    const row = await store.getRealmSnapshot(req.params.id);
    if (!row) return reply.code(404).send({ error: 'realm-snapshot-not-found' });
    return row;
  });

  // ---- Durable local billing ----
  app.get<{ Querystring: { realmId?: string } }>('/admin/sql/billing', async (req) => ({
    billing: await store.listBilling(req.query.realmId),
  }));

  // ---- Durable counterfactual runs ----
  app.get('/admin/sql/counterfactuals', async () => ({ runs: await store.listCounterfactuals() }));

  // ---- M25 Nudge Ledger ----
  const ledger = new NudgeLedger(sqliteNudgePersistence(store));

  app.post<{ Body: NudgeSpec }>('/admin/nudges', async (req, reply) => {
    const spec = req.body;
    if (!spec?.realmId || !spec?.patientId || !spec?.channel || !spec?.nudgeKind) {
      return reply.code(400).send({ error: 'realmId, patientId, channel, nudgeKind required' });
    }
    let adapter;
    if (spec.channel === 'in-app') {
      const realm = RealmRegistry.get(spec.realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      adapter = new InAppNudgeChannel(realm);
    } else {
      adapter = new StubNudgeChannel(spec.channel);
    }
    const nudge = await ledger.deliver(spec, adapter);
    return { nudge };
  });

  app.get<{ Querystring: { realmId?: string } }>('/admin/nudges', async (req) => ({
    nudges: await store.listNudges(req.query.realmId),
  }));

  app.post<{ Params: { id: string }; Body: { outcome?: Record<string, unknown> } }>('/admin/nudges/:id/observe', async (req, reply) => {
    const outcome = req.body?.outcome ?? {};
    const rec = await ledger.observe(req.params.id, outcome);
    if (rec) return { nudge: rec };
    // Ledger is session-scoped; still close the loop durably for a restarted process.
    const ok = await store.updateNudgeObserved(req.params.id, new Date().toISOString(), JSON.stringify(outcome));
    if (!ok) return reply.code(404).send({ error: 'nudge-not-found' });
    return { ok: true, fallback: 'store' };
  });

  // ---- CQL scoring of learned trajectories ----
  app.post<{ Body: { measureId: string; patients: LabPatient[]; measurementPeriod?: { start: string; end: string } } }>(
    '/admin/liquid/score',
    async (req, reply) => {
      if (!req.body?.measureId || !Array.isArray(req.body?.patients)) {
        return reply.code(400).send({ error: 'measureId and patients required' });
      }
      return scoreLabs(getMeasureEvaluator()?.evaluator, req.body.measureId, req.body.patients, req.body.measurementPeriod);
    },
  );
}
