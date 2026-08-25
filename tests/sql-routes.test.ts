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

// Durable storage routes + M25 nudge ledger + CQL scoring over the HTTP surface.
//
// NODE_ENV=test routes the getSqlStore() singleton to an in-memory SQLite, so these
// assertions exercise the same SqlStore → SqlDb seam production uses (swap for Postgres
// purely via HH_STORAGE).

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

const actor: ActorContext = { actorRef: 'user:ops-1', scopeIds: ['scope:facility-1'], purposeOfUse: 'operations', clearance: 'internal' };

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('Durable storage + M25 routes', () => {
  it('persists a realm snapshot on create and serves it back', async () => {
    const app = await makeApp();
    const create = await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:sql-a', mode: 'sim' } });
    expect(create.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/admin/sql/realms' });
    expect(list.statusCode).toBe(200);
    const realms = (list.json() as { realms: Array<{ realmId: string; mode: string }> }).realms;
    expect(realms.some((r) => r.realmId === 'realm:sql-a' && r.mode === 'sim')).toBe(true);

    const one = await app.inject({ method: 'GET', url: '/admin/sql/realms/realm:sql-a' });
    expect(one.statusCode).toBe(200);
    const row = one.json() as { realmId: string; snapshotJson: string };
    // persisted snapshot is the portable format → id lives under `.realm.id`
    const snap = JSON.parse(row.snapshotJson) as { realm?: { id?: string }; version?: string };
    expect(snap.version).toBe('hh-realm-snapshot@1');
    expect(snap.realm?.id).toBe('realm:sql-a');
    await app.close();
  });

  it('persists billing usage on meter read', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:sql-b', mode: 'sim' } });
    const bill = await app.inject({ method: 'GET', url: '/admin/realms/realm:sql-b/billing' });
    expect(bill.statusCode).toBe(200);

    const rows = await app.inject({ method: 'GET', url: '/admin/sql/billing?realmId=realm:sql-b' });
    const billing = (rows.json() as { billing: Array<{ realmId: string; plan: string }> }).billing;
    expect(billing.some((b) => b.realmId === 'realm:sql-b' && b.plan === 'plan.dialysis-basic')).toBe(true);
    await app.close();
  });

  it('persists counterfactual runs to the SQL store', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:cf-sql', mode: 'sim' } });
    const run = await app.inject({
      method: 'POST', url: '/admin/counterfactual/run',
      payload: {
        realmId: 'realm:cf-sql',
        facility: { facilityId: 'f1', kind: 'dialysis', name: 'CF', units: ['A'], patientCount: 1 },
        interventions: [], timeline: [], label: 'sql-persist-check',
      },
    });
    expect(run.statusCode).toBe(200);
    const rows = await app.inject({ method: 'GET', url: '/admin/sql/counterfactuals' });
    const runs = (rows.json() as { runs: Array<{ label: string }> }).runs;
    expect(runs.some((r) => r.label === 'sql-persist-check')).toBe(true);
    await app.close();
  });

  it('delivers + lists + observes a nudge over HTTP (M25)', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/admin/realms', payload: { id: 'realm:nudge-r', mode: 'sim', seed: { facilityId: 'f1', kind: 'dialysis', name: 'R', units: ['A'], patientCount: 1 } } });
    const patients = await app.inject({ method: 'GET', url: '/admin/realms/realm:nudge-r/patients' });
    const pid = ((patients.json() as { patients: Array<{ id: string }> }).patients[0]!.id);

    const deliver = await app.inject({
      method: 'POST', url: '/admin/nudges',
      payload: { realmId: 'realm:nudge-r', patientId: pid, channel: 'in-app', nudgeKind: 'dietitian-nudge', expectedEffect: { diet_phosphate_violation: -0.2 }, rehearsalId: 'cf-r1', variantId: 'gentle' },
    });
    expect(deliver.statusCode).toBe(200);
    const nudge = (deliver.json() as { nudge: { id: string; status: string; channelReceipt: string } }).nudge;
    expect(nudge.status).toBe('delivered');
    expect(nudge.channelReceipt).toMatch(/^in-app-/);

    const list = await app.inject({ method: 'GET', url: '/admin/nudges?realmId=realm:nudge-r' });
    expect(((list.json() as { nudges: unknown[] }).nudges).length).toBe(1);

    const obs = await app.inject({ method: 'POST', url: `/admin/nudges/${nudge.id}/observe`, payload: { outcome: { phosphate: 0.4 } } });
    expect(obs.statusCode).toBe(200);
    const observed = (obs.json() as { nudge: { status: string; observedOutcome?: Record<string, unknown> } }).nudge;
    expect(observed.status).toBe('observed');
    expect(observed.observedOutcome?.['phosphate']).toBe(0.4);
    await app.close();
  });

  it('liquid score degrades when no measure store is loaded', async () => {
    // Force the evaluator to look at a non-existent root so the test is deterministic
    // even when .harness/measures/ has been seeded (npm run measures:seed).
    const prev = process.env.HH_MEASURES_ROOT;
    process.env.HH_MEASURES_ROOT = '/nonexistent/hh-measures';
    try {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: '/admin/liquid/score',
        payload: { measureId: 'ecqm:M21Basic/1.0.0', patients: [{ id: 'p1', labs: { K: 4.2, HGB: 11.5, URR: 68, PHOS: 5.1 }, hypertension: true }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ scored: false, reason: 'measure-store-not-loaded' });
      await app.close();
    } finally {
      if (prev === undefined) delete process.env.HH_MEASURES_ROOT;
      else process.env.HH_MEASURES_ROOT = prev;
    }
  });
});
