import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { CONSOLE_ROLES, consolesForRole, roleAllowsConsole } from '../src/server/console-gate.js';

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
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

async function login(app: Awaited<ReturnType<typeof build>>, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
  expect(res.statusCode).toBe(200);
  return cookie;
}

describe('console access gate (exec vs ops split)', () => {
  it('role → console mapping: admin both, decision/clinical exec, data/ops ops', () => {
    expect(consolesForRole('admin')).toEqual(['exec', 'ops']);
    expect(consolesForRole('md')).toEqual(['exec']);
    expect(consolesForRole('safety')).toEqual(['exec']);
    expect(consolesForRole('nurse')).toEqual(['ops']);
    expect(consolesForRole('coder')).toEqual(['ops']);
    expect(consolesForRole('facilities-tech')).toEqual(['ops']);
    expect(roleAllowsConsole('admin', 'exec')).toBe(true);
    expect(roleAllowsConsole('nurse', 'exec')).toBe(false);
    expect(CONSOLE_ROLES.exec).toContain('md');
  });

  it('pre-login requests may load either console (login screen renders client-side)', async () => {
    const app = await build();
    const exec = await app.inject({ method: 'GET', url: '/exec/' });
    expect(exec.statusCode).toBe(200);
    const ops = await app.inject({ method: 'GET', url: '/admin/ui/' });
    expect(ops.statusCode).toBe(200);
  });

  it('admin can load both consoles', async () => {
    const app = await build();
    const cookie = await login(app, 'admin', 'admin123');
    const exec = await app.inject({ method: 'GET', url: '/exec/', headers: { cookie } });
    expect(exec.statusCode).toBe(200);
    const ops = await app.inject({ method: 'GET', url: '/admin/ui/', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
    const access = await app.inject({ method: 'GET', url: '/admin/console-access', headers: { cookie } });
    expect(access.json().role).toBe('admin');
    expect(access.json().consoles).toEqual(['exec', 'ops']);
  });

  it('nurse is blocked from /exec/ (403 HTML) but allowed /admin/ui/', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const exec = await app.inject({ method: 'GET', url: '/exec/', headers: { cookie } });
    expect(exec.statusCode).toBe(403);
    expect(exec.headers['content-type'] ?? '').toContain('text/html');
    expect(exec.body).toContain('not available to your role');
    const ops = await app.inject({ method: 'GET', url: '/admin/ui/', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
    const access = await app.inject({ method: 'GET', url: '/admin/console-access', headers: { cookie } });
    expect(access.json().consoles).toEqual(['ops']);
  });

  it('auditor (ops) is blocked from /exec/', async () => {
    const app = await build();
    const cookie = await login(app, 'auditor', 'audit123');
    const exec = await app.inject({ method: 'GET', url: '/exec/', headers: { cookie } });
    expect(exec.statusCode).toBe(403);
    const ops = await app.inject({ method: 'GET', url: '/admin/ui/', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
  });
});
