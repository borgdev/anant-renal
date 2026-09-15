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

/**
 * The certification surface over HTTP (Phase 2).
 *
 * These tests exist to hold one property steady, because it is the property a
 * live patient write path depends on: a probe of our own conformance double
 * must never appear in the set of certified vendors. Everything else here
 * (matrix shape, refusals, redaction) is ordinary route coverage.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { resetSwarmRuntime } from '../src/server/swarm-routes.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore() {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = {
  actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations',
} as ActorContext;

type App = Awaited<ReturnType<typeof build>>;
async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

interface MatrixRow {
  vendor: string; verdict: string; mode: string; headline: string;
  essentialBlocked: string[]; flows: Array<{ flow: { id: string }; verdict: string; reason: string }>;
}
interface MatrixBody {
  matrix: {
    total: number; certified: number; harnessVerified: number; failed: number; notRun: number;
    anyCertified: boolean; headline: string;
    vendors: MatrixRow[]; sandboxCertified: string[];
  };
  certifiedVendors: string[];
}

describe('vendor certification (/admin/platform/certification)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app?.close(); resetSwarmRuntime(); });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookie(admin) } });
  const run = (vendor: string, mode: string) => app.inject({
    method: 'POST', url: `/admin/platform/certification/${vendor}/run`,
    headers: { cookie: cookie(admin) }, payload: { mode },
  });

  it('is session-scoped like the rest of the platform admin surface', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/certification' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('not-authenticated');
  });

  it('reports every certifiable vendor, including the ones nobody has run', async () => {
    const res = await get('/admin/platform/certification');
    expect(res.statusCode).toBe(200);
    const body = res.json() as MatrixBody;
    // The matrix is exhaustive by design: an absent vendor is listed as not-run,
    // because a vendor missing from the report is indistinguishable from one that
    // was never considered.
    expect(body.matrix.vendors.map((v) => v.vendor).sort()).toEqual(['athena', 'cerner', 'epic', 'generic']);
    expect(body.matrix.total).toBe(4);
    expect(body.matrix.vendors.every((v) => v.verdict === 'not-run')).toBe(true);
    expect(body.matrix.anyCertified).toBe(false);
    expect(body.matrix.sandboxCertified).toEqual([]);
    expect(body.certifiedVendors).toEqual([]);
    // The headline must not imply progress. "No vendor has been certified" is the
    // honest state before any sandbox run, and it has to say so in words.
    expect(body.matrix.headline).toMatch(/no vendor has been certified/i);
  });

  it('refuses an unknown vendor and an unknown mode rather than guessing', async () => {
    expect((await get('/admin/platform/certification/fax-machine')).statusCode).toBe(400);
    const bad = await run('epic', 'wishful');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid-mode');
  });

  it('proves the Epic client against the double and calls it what it is', async () => {
    const res = await run('epic', 'double');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { certification: { verdict: string; mode: string; essentialBlocked: string[]; requestCount: number }; requests: unknown[] };
    // The harness can sign a real RS384 assertion and reconcile discovery, so the
    // client is right — but we wrote both ends of this conversation, so the
    // strongest honest verdict is harness-verified.
    expect(body.certification.mode).toBe('double');
    expect(body.certification.verdict).toBe('harness-verified');
    expect(body.certification.essentialBlocked).toEqual([]);
    expect(body.certification.requestCount).toBeGreaterThan(0);
    // The raw exchange is returned so an operator can see what the double answered.
    expect(Array.isArray(body.requests)).toBe(true);
    expect(body.requests.length).toBeGreaterThan(0);
  });

  it('records the run durably, and the double still does not certify the vendor', async () => {
    const res = await get('/admin/platform/certification');
    const body = res.json() as MatrixBody;
    const epic = body.matrix.vendors.find((v) => v.vendor === 'epic');
    expect(epic?.verdict).toBe('harness-verified');
    expect(epic?.mode).toBe('double');
    // This is the whole point of the phase. `certifiedVendors` feeds the
    // fail-closed write-policy check, so if a double run leaked into it, a bound
    // effect kind would unlock a live write to a patient chart on the strength of
    // our own test server.
    expect(body.certifiedVendors).toEqual([]);
    expect(body.matrix.sandboxCertified).toEqual([]);
    expect(body.matrix.anyCertified).toBe(false);
    expect(body.matrix.harnessVerified).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the Athena blocker as a failed verdict, not a soft warning', async () => {
    const res = await run('athena', 'double');
    expect(res.statusCode).toBe(200);
    const cert = (res.json() as { certification: { verdict: string; essentialBlocked: string[] } }).certification;
    // Athena declares no create, so discovery confirms the episode Encounter
    // cannot be opened. That is a product blocker, and it must read as one.
    expect(cert.verdict).toBe('failed');
    expect(cert.essentialBlocked).toContain('episode-encounter-write');

    const matrix = (await get('/admin/platform/certification')).json() as MatrixBody;
    expect(matrix.matrix.failed).toBeGreaterThanOrEqual(1);
    expect(matrix.certifiedVendors).toEqual([]);
  });

  it('refuses to certify against a sandbox it does not have instead of probing the double', async () => {
    const res = await run('cerner', 'sandbox');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no-sandbox-connection');
    // A silent downgrade to the double would be the worst available outcome: it
    // would report a vendor certification won against a system we control.
    expect(res.json().detail).toMatch(/cerner/);
  });

  it('returns the full history for one vendor, newest first', async () => {
    const res = await get('/admin/platform/certification/epic');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { vendor: string; latest: { verdict: string } | null; records: Array<{ vendor: string; mode: string }> };
    expect(body.vendor).toBe('epic');
    expect(body.latest?.verdict).toBe('harness-verified');
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records.every((r) => r.vendor === 'epic')).toBe(true);
    const at = body.records.map((r) => (r as unknown as { ranAt: string }).ranAt);
    expect([...at].sort().reverse()).toEqual(at);
  });

  it('never carries a credential back to the browser', async () => {
    const res = await run('epic', 'double');
    // The double run mints an ephemeral RSA key and presents it through the auth
    // flow; none of that may end up in the response body.
    const raw = res.body;
    expect(raw).not.toMatch(/PRIVATE KEY/);
    expect(raw).not.toMatch(/"privateKey/);
    expect(raw).not.toMatch(/access_token/i);
  });
});
