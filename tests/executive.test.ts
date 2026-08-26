/******************************************************************************
 * Journey N — Executive outcomes and delegation.
 *
 * Proves: executives sponsor/delegate analysis to an owner with an SLA (durable
 * `delegated-work`), the delegate returns a verified outcome, and the outcomes
 * endpoint reports verified value (resolved episodes with met measures) — not
 * activity counts.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
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

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

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
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

describe('Executive outcomes + delegation (Journey N)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('blocks unauthenticated /admin/executive calls (401)', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/executive/outcomes' })).statusCode).toBe(401);
  });

  it('sponsors/delegates analysis to an owner with an SLA (durable)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/executive/delegate', headers: { cookie: cookie(admin) }, payload: { title: 'Analyze network-access variance', reason: 'Material referral drift in Nashville', sourceId: 'episode:network.access', owner: 'Network Operations Leader', sla: 'By Friday', delegatedBy: 'executive' } });
    expect(res.statusCode).toBe(200);
    const d = res.json().delegation;
    expect(d.status).toBe('open');
    expect(d.owner).toBe('Network Operations Leader');
    expect(d.sla).toBe('By Friday');
    // Missing owner → 400.
    const bad = await app.inject({ method: 'POST', url: '/admin/executive/delegate', headers: { cookie: cookie(admin) }, payload: { title: 'x' } });
    expect(bad.statusCode).toBe(400);
    return d.id;
  });

  it('the delegate returns a verified outcome; delegation completes', async () => {
    const create = await app.inject({ method: 'POST', url: '/admin/executive/delegate', headers: { cookie: cookie(admin) }, payload: { title: 'Verify authorization backlog', owner: 'Utilization Manager', delegatedBy: 'executive' } });
    const id = create.json().delegation.id;
    const done = await app.inject({ method: 'POST', url: `/admin/executive/delegations/${id}/status`, headers: { cookie: cookie(admin) }, payload: { status: 'done', verified: true, value: 12500, note: 'Backlog cleared; 12 authorizations expedited' } });
    expect(done.json().delegation.status).toBe('done');
    expect(done.json().delegation.outcome.verified).toBe(true);
    expect(done.json().delegation.outcome.value).toBe(12500);
    expect(done.json().delegation.doneAt).toBeTruthy();
    const list = await app.inject({ method: 'GET', url: '/admin/executive/delegations', headers: { cookie: cookie(admin) } });
    expect(list.json().delegations.length).toBeGreaterThanOrEqual(2);
  });

  it('verified-value rollup reports resolved outcomes, not activity counts', async () => {
    // Seed the payer demo → a network.access episode resolves with a met measure.
    await app.inject({ method: 'POST', url: '/admin/swarm/payer/demo', headers: { cookie: cookie(admin) } });
    const res = await app.inject({ method: 'GET', url: '/admin/executive/outcomes', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const o = res.json().outcomes;
    expect(typeof o.verifiedEpisodes).toBe('number');
    expect(o.verifiedEpisodes).toBeGreaterThanOrEqual(1);
    expect(o.met).toBeGreaterThanOrEqual(1);
    expect(o.realizedValue).toBeGreaterThan(0);
  });
});
