/******************************************************************************
 * Payer proof pack (Phase 5 / Epic 7) — tests.
 *
 * Proves a second domain closes a payer loop through the SAME coordinator +
 * workspace contracts: payer org install flips the /api/context lens, durable
 * payer episodes seed into My Work, the reset is targeted, and no renal runtime
 * is forked.
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

describe('payer proof pack', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('exposes 6 payer bounded cells with the CellManifest contract', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/payer/cells', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const cells = res.json().cells;
    expect(cells.length).toBe(6);
    for (const c of cells) {
      expect(c.id).toBeTruthy();
      expect(c.displayName).toBeTruthy();
      expect(Array.isArray(c.consumes)).toBe(true);
      expect(Array.isArray(c.produces)).toBe(true);
      expect(Array.isArray(c.allowedActions)).toBe(true);
      expect(['A', 'B', 'C', 'D']).toContain(c.approvalClass);
      expect(typeof c.evalGate).toBe('number');
    }
    const ids = cells.map((c: { id: string }) => c.id);
    expect(ids).toContain('care-gap-closure');
    expect(ids).toContain('authorization-um');
    expect(ids).toContain('network-access');
  });

  it('payer demo installs the payer org (flips the lens) and seeds durable episodes', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/payer/demo', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.installed).toBe(true);
    expect(body.lens).toBe('payer');
    expect(body.opened.length).toBe(2); // care-gap + authorization (network-access closes)
    expect(body.closed.length).toBe(1); // network.access full loop

    // /api/context now reports the payer pack + lens.
    const ctx = await app.inject({ method: 'GET', url: '/api/context' });
    expect(ctx.json().pack.lens).toBe('payer');
    expect(ctx.json().pack.id).toBe('healthcare.payer');

    // Payer org persisted.
    const org = await app.inject({ method: 'GET', url: '/admin/platform/organization', headers: { cookie: cookie(admin) } });
    expect(org.json().organization.operatingModel).toBe('payer');
    expect(org.json().organization.scopePath.map((l: { level: string }) => l.level)).toContain('plan');
    expect(org.json().organization.scopePath.map((l: { level: string }) => l.level)).toContain('network');
  });

  it('payer state derives insights, NBAs and KPIs through the same aggregation', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/payer/state', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.source).toBe('payer');
    expect(s.insights.length).toBeGreaterThan(0);
    expect(s.nbas.length).toBeGreaterThan(0);
    expect(typeof s.kpis.careGaps).toBe('number');
    expect(s.episodes.some((e: { kind: string }) => e.kind === 'care-gap.closure')).toBe(true);
    expect(s.episodes.some((e: { kind: string; state: string }) => e.kind === 'network.access' && e.state === 'Resolved')).toBe(true);
  });

  it('payer episodes appear in My Work (/api/work) as role-scoped decisions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    // My Work titles render kind dashes as spaces ("care gap closure · member:m-1042").
    expect(items.some((i: { title: string }) => i.title.includes('care gap closure'))).toBe(true);
    expect(items.some((i: { title: string }) => i.title.includes('authorization review'))).toBe(true);
  });

  it('payer demo is idempotent — re-seeding does not churn episodes', async () => {
    const first = await app.inject({ method: 'GET', url: '/admin/swarm/payer/state', headers: { cookie: cookie(admin) } });
    const countBefore = first.json().episodes.length;
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/payer/demo', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.json().opened.length).toBe(0);
    expect(res.json().existing.length).toBeGreaterThan(0);
    const after = await app.inject({ method: 'GET', url: '/admin/swarm/payer/state', headers: { cookie: cookie(admin) } });
    expect(after.json().episodes.length).toBe(countBefore);
  });

  it('payer reset removes ONLY payer episodes (targeted, not all episodes)', async () => {
    // Open a non-payer episode so we can prove it survives the reset.
    const ep = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) }, payload: { kind: 'continuity', subject: 'pt-reset', scopeType: 'patient' } });
    expect(ep.statusCode).toBe(200);

    const reset = await app.inject({ method: 'POST', url: '/admin/swarm/payer/reset', headers: { cookie: cookie(admin) }, payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().removed).toBeGreaterThanOrEqual(3);

    const state = await app.inject({ method: 'GET', url: '/admin/swarm/payer/state', headers: { cookie: cookie(admin) } });
    expect(state.json().episodes.length).toBe(0); // all payer episodes gone

    // The non-payer continuity episode still exists.
    const episodes = await app.inject({ method: 'GET', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) } });
    const all = episodes.json().episodes;
    expect(all.some((e: { kind: string }) => e.kind === 'continuity')).toBe(true);

    // My Work no longer lists payer episodes.
    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } });
    expect(work.json().items.some((i: { title: string }) => i.title.includes('care gap closure'))).toBe(false);
  });

  it('unauth /admin/swarm/payer/* is blocked (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/payer/cells' });
    expect(res.statusCode).toBe(401);
  });
});
