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
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
  return store;
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

describe('Admin API (M6)', () => {
  it('GET /admin/summary returns rollup counts', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: { total: number }; measures: { total: number }; assessments: { total: number }; lifecycleStages: number; researchSources: number };
    expect(body.agents.total).toBeGreaterThanOrEqual(170);
    expect(body.measures.total).toBeGreaterThanOrEqual(30);
    expect(body.assessments.total).toBe(13);
    expect(body.lifecycleStages).toBe(11);
    expect(body.researchSources).toBe(21);
    await app.close();
  });

  it('GET /admin/agents filters by pack', async () => {
    const app = await makeApp();
    const dial = await app.inject({ method: 'GET', url: '/admin/agents?pack=dialysis-deep' });
    expect((dial.json() as { count: number }).count).toBe(60);
    const prim = await app.inject({ method: 'GET', url: '/admin/agents?pack=primary-care-deep' });
    expect((prim.json() as { count: number }).count).toBe(50);
    const urg = await app.inject({ method: 'GET', url: '/admin/agents?pack=urgent-care-deep' });
    expect((urg.json() as { count: number }).count).toBe(40);
    await app.close();
  });

  it('GET /admin/agents/:id 404s on unknown id, returns spec on known id', async () => {
    const app = await makeApp();
    const missing = await app.inject({ method: 'GET', url: '/admin/agents/does-not-exist' });
    expect(missing.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/admin/agents?pack=dialysis-deep' });
    const firstId = (list.json() as { agents: Array<{ id: string }> }).agents[0]!.id;
    const found = await app.inject({ method: 'GET', url: `/admin/agents/${firstId}` });
    expect(found.statusCode).toBe(200);
    expect((found.json() as { spec: { id: string } }).spec.id).toBe(firstId);
    await app.close();
  });

  it('GET /admin/measures, /admin/assessments, /admin/lifecycle, /admin/research/sources', async () => {
    const app = await makeApp();
    for (const [url, min] of [
      ['/admin/measures', 30],
      ['/admin/assessments', 13],
      ['/admin/research/sources', 21],
    ] as const) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { count: number }).count).toBeGreaterThanOrEqual(min);
    }
    const life = await app.inject({ method: 'GET', url: '/admin/lifecycle' });
    expect((life.json() as { stages: unknown[] }).stages.length).toBe(11);
    await app.close();
  });
});

describe('console document redirects', () => {
  it('redirects the bare console paths to their trailing-slash documents', async () => {
    const app = await makeApp();
    const ui = await app.inject({ method: 'GET', url: '/admin/ui' });
    expect(ui.statusCode).toBe(302);
    expect(ui.headers.location).toBe('/admin/ui/');
    const exec = await app.inject({ method: 'GET', url: '/exec' });
    expect(exec.statusCode).toBe(302);
    expect(exec.headers.location).toBe('/exec/');
    // The trailing-slash documents themselves resolve (static shell or exec build).
    const uiDoc = await app.inject({ method: 'GET', url: '/admin/ui/' });
    expect(uiDoc.statusCode).toBe(200);
    const execDoc = await app.inject({ method: 'GET', url: '/exec/' });
    expect(execDoc.statusCode).toBe(200);
    await app.close();
  });
});
