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

async function build() {
  // adminApiAuth: true → the /admin/* surface requires a session + role.
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

async function login(app: Awaited<ReturnType<typeof build>>, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
  expect(res.statusCode).toBe(200);
  return cookie;
}

describe('admin API security guard', () => {
  it('unauthenticated /admin/* (non-public) returns 401', async () => {
    const app = await build();
    for (const url of ['/admin/swarm/cells', '/admin/realms', '/admin/measures', '/admin/audit', '/admin/agents']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toBe('not-authenticated');
    }
  });

  it('public admin paths stay open: console shell + console-access + auth meta', async () => {
    const app = await build();
    const shell = await app.inject({ method: 'GET', url: '/admin/ui/' });
    expect(shell.statusCode).toBe(200);
    const access = await app.inject({ method: 'GET', url: '/admin/console-access' });
    expect(access.statusCode).toBe(200);
    expect(access.json().authenticated).toBe(false);
  });

  it('admin can read swarm + ops endpoints', async () => {
    const app = await build();
    const cookie = await login(app, 'admin', 'admin123');
    const swarm = await app.inject({ method: 'GET', url: '/admin/swarm/cells', headers: { cookie } });
    expect(swarm.statusCode).toBe(200);
    expect(swarm.json().cells).toHaveLength(12);
    const ops = await app.inject({ method: 'GET', url: '/admin/realms', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
  });

  it('executive-only role (md) can read /admin/swarm/* but NOT ops endpoints', async () => {
    const app = await build();
    const cookie = await login(app, 'admin', 'admin123'); // no md seed user — create one via admin API
    const created = await app.inject({
      method: 'POST', url: '/admin/auth/users', headers: { cookie },
      payload: { username: 'med', password: 'med123', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'] },
    });
    expect(created.statusCode).toBe(200);
    const mdCookie = await login(app, 'med', 'med123');
    const swarm = await app.inject({ method: 'GET', url: '/admin/swarm/cells', headers: { cookie: mdCookie } });
    expect(swarm.statusCode).toBe(200);
    const ops = await app.inject({ method: 'GET', url: '/admin/realms', headers: { cookie: mdCookie } });
    expect(ops.statusCode).toBe(403);
    expect(ops.json().console).toBe('ops');
  });

  it('nurse (ops role) can read ops endpoints but /admin/swarm/* is 403', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const ops = await app.inject({ method: 'GET', url: '/admin/realms', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
    const swarm = await app.inject({ method: 'GET', url: '/admin/swarm/cells', headers: { cookie } });
    expect(swarm.statusCode).toBe(403);
    expect(swarm.json().console).toBe('exec');
  });

  it('non-admin cannot manage users', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const res = await app.inject({ method: 'GET', url: '/admin/auth/users', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('admin-required');
  });
});
