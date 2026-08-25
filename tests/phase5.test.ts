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

// Phase 5 — admin console & analytics: FHIR EHR-bridge (client + subscription
// pump + CDS-Hooks), hypergraph graph endpoint, compliance inventory, and the
// multi-realm SSE command-center stream.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { FhirClient } from '../src/fhir/client.js';
import { FhirSubscriptionPump, subscriptionNotificationToEvents } from '../src/fhir/subscription.js';
import { cdsHooksToCards } from '../src/fhir/cds-hooks.js';
import type { FhirCtx } from '../src/fhir/types.js';

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

const actor: ActorContext = { actorRef: 'user:ops', scopeIds: ['realm:r1', 'scope:*'], purposeOfUse: 'operations', clearance: 'restricted-phi' };

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

function makeRealm(id = 'realm:r1'): string {
  if (RealmRegistry.get(id)) return id;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Anant Dialysis', units: ['U1'], patientCount: 1 });
  realm.start();
  const md = realm.spawnPresence({ agentSpecId: 'md', runId: 'r', role: 'md', clearance: 'restricted-phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' } });
  realm.emit(md.presenceId, { kind: 'admit-patient', patientId: 'p1', facilityId: 'f1', unitId: 'U1' });
  realm.emit(md.presenceId, { kind: 'order-lab', patientId: 'p1', code: '17861-6', priority: 'routine', encounterId: 'enc1' });
  const orderId = realm.graph.listKind('order')[0]!.id;
  realm.emit(md.presenceId, { kind: 'result-lab', orderId, code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' });
  realm.emit(md.presenceId, { kind: 'order-med', patientId: 'p1', code: '853653', dose: '50 mg', route: 'PO', frequency: 'Q8H' });
  return id;
}

function ctx(): FhirCtx { return { realmId: 'realm:r1', facilityId: 'f1', scopeId: 'realm:r1', sourceId: 'test', ingestedAt: '2026-08-16T00:00:00Z' }; }

describe('Phase 5 — FHIR EHR-bridge', () => {
  it('FhirClient get/search/push against an injected transport', async () => {
    const calls: Array<{ url: string; method: string; body?: string | undefined }> = [];
    const client = new FhirClient({
      baseUrl: 'https://fhir.example.com',
      bearerToken: 'tok',
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        if (url.endsWith('/Patient/p1')) return { ok: true, status: 200, json: async () => ({ resourceType: 'Patient', id: 'p1' }) };
        if (url.includes('Observation?')) return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'o1' } }] }) };
        return { ok: true, status: 201, json: async () => ({ resourceType: 'Patient', id: 'p-new' }) };
      },
    });
    const p = await client.get('Patient', 'p1');
    expect(p.id).toBe('p1');
    const b = await client.search('Observation', { code: '17861-6' });
    expect(b.entry?.[0]?.resource?.resourceType).toBe('Observation');
    await client.push({ resourceType: 'Patient', id: 'p-new' });
    expect(calls[2]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://fhir.example.com/Patient/p1');
  });

  it('subscription pump hydrates changed resources to canonical events', async () => {
    const client = new FhirClient({
      baseUrl: 'https://fhir.example.com',
      fetch: async (url) => {
        if (url.includes('Patient?')) return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'p9', meta: { lastUpdated: '2026-08-16T10:00:00Z' } } }] }) };
        return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', entry: [] }) };
      },
    });
    const pump = new FhirSubscriptionPump({ client, ctx: ctx(), resourceTypes: ['Patient', 'Observation'] });
    const result = await pump.poll();
    expect(result.events.length).toBe(1);
    expect(result.events[0]!.payload['fhir']).toMatchObject({ resourceType: 'Patient' });
    expect(result.events[0]!.classification).toBe('phi');
    expect(pump.cursor()).toBe('2026-08-16T10:00:00Z');
  });

  it('CDS-Hooks returns deterministic cards from a live realm', () => {
    makeRealm();
    const realm = RealmRegistry.get('realm:r1')!;
    const resp = cdsHooksToCards({ hook: 'patient-view', hookInstance: 'h1', context: { patientId: 'p1' } }, realm);
    expect(resp.cards.length).toBeGreaterThanOrEqual(2);
    // abnormal result → warning card
    expect(resp.cards.some((c) => c.indicator === 'warning' && /abnormal/i.test(c.summary))).toBe(true);
    // active medication → reconciliation hint
    expect(resp.cards.some((c) => /active medication/i.test(c.summary))).toBe(true);
    const noPatient = cdsHooksToCards({ hook: 'patient-view', hookInstance: 'h2', context: {} }, realm);
    expect(noPatient.cards[0]!.indicator).toBe('info');
  });
});

describe('Phase 5 — admin routes', () => {
  it('hypergraph graph endpoint returns nodes + edges arrays', async () => {
    makeRealm();
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/hypergraph/realm/realm:r1/graph' });
    expect(res.statusCode).toBe(200);
    const g = res.json() as { nodes: Array<{ id: string; type: string }>; edges: Array<{ id: string; type: string }>; live: boolean };
    expect(g.live).toBe(true);
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.nodes.some((n) => n.type === 'patient')).toBe(true);
    expect(g.nodes.some((n) => n.type === 'effect')).toBe(true);
    expect(g.edges.some((e) => e.type === 'effect-attribution')).toBe(true);
  });

  it('CDS-Hooks route returns cards over HTTP', async () => {
    makeRealm();
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/fhir/cds-hooks?realmId=realm:r1', payload: { hook: 'patient-view', hookInstance: 'h1', context: { patientId: 'p1' } } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cards: Array<{ summary: string }> };
    expect(body.cards.length).toBeGreaterThan(0);
  });

  it('compliance endpoint reports audit + retention + PHI inventory', async () => {
    makeRealm();
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/compliance' });
    expect(res.statusCode).toBe(200);
    const c = res.json() as { audit: { total: number }; retention: unknown[]; phiInventory: { fhirResources: number; byType: Record<string, number> } };
    expect(c.audit.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(c.retention)).toBe(true);
    expect(typeof c.phiInventory.fhirResources).toBe('number');
  });

  it('command-center stream returns an SSE response with a hello event', async () => {
    makeRealm();
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/stream?once=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body as string;
    expect(body).toContain('data: ');
    expect(body).toContain('"type":"hello"');
    expect(body).toContain('realm:r1');
    expect(body).toContain('"type":"snapshot"');
  });
});
