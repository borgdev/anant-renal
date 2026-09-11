/******************************************************************************
 * Phase F — security: role/scope isolation + break-glass (port plan Phase F).
 *
 * Proves the /admin/* guard is role-scoped (exec vs ops vs admin-only), the
 * My Work projection never leaks a console the role cannot use, and the
 * cross-tenant (break-glass) adversarial case is flagged by the red team.
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

describe('Phase F — security: role/scope isolation + break-glass', () => {
  let app: App;
  let admin: string;
  let nurse: string;
  let auditor: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
    nurse = await login(app, 'nurse', 'nurse123');
    auditor = await login(app, 'auditor', 'audit123');
  });
  afterAll(async () => { await app.close(); });

  it('anonymous sessions are rejected on every admin surface (401)', async () => {
    for (const url of ['/admin/platform/submissions', '/admin/platform/assurance', '/admin/platform/agents', '/admin/platform/releases', '/admin/swarm/cells', '/admin/auth/users']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('ops roles (nurse) can use the ops console but NOT exec / admin-only surfaces', async () => {
    // ops surface → allowed
    const assurance = await app.inject({ method: 'GET', url: '/admin/platform/assurance', headers: { cookie: cookie(nurse) } });
    expect(assurance.statusCode).toBe(200);
    // exec-only swarm surface → 403
    const exec = await app.inject({ method: 'GET', url: '/admin/swarm/cells', headers: { cookie: cookie(nurse) } });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().error).toBe('role-not-permitted-for-console');
    // admin-only user management → 403
    const users = await app.inject({ method: 'GET', url: '/admin/auth/users', headers: { cookie: cookie(nurse) } });
    expect(users.statusCode).toBe(403);
  });

  it('auditor (ops) gets the same isolation as nurse', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/swarm/cells', headers: { cookie: cookie(auditor) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/admin/auth/users', headers: { cookie: cookie(auditor) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/admin/platform/submissions', headers: { cookie: cookie(auditor) } })).statusCode).toBe(200);
  });

  it('admin (exec+ops) reaches both consoles and user management', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/platform/release-gate', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/auth/users', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/platform/assurance', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
  });

  it('My Work never leaks a console the role cannot use', async () => {
    // Seed ops + exec work: a draft release (ops validation) and a validated
    // release (exec approval).
    const createA = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin), 'content-type': 'application/json' }, payload: { version: 'sec-draft' } });
    const a = createA.json().release;
    const createB = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin), 'content-type': 'application/json' }, payload: { version: 'sec-validated' } });
    const b = createB.json().release;
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${b.id}/validate`, headers: { cookie: cookie(admin) }, payload: {} });

    // nurse → ops console only; sees the draft validation, never exec items.
    const items = (await (await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(nurse) } })).json()).items;
    expect(items.some((i: { title: string }) => i.title.includes('sec-draft'))).toBe(true);
    for (const i of items) {
      expect(i.console, `item ${i.id} leaks ${i.console}`).toBe('ops');
      expect(['release', 'dlq'].includes(i.kind), `item ${i.id} kind ${i.kind} not an ops item`).toBe(true);
    }
    expect(items.some((i: { title: string }) => i.title.includes('sec-validated'))).toBe(false);

    // admin sees exec items too.
    const adminItems = (await (await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } })).json()).items;
    expect(adminItems.some((i: { title: string; console: string }) => i.title.includes('sec-validated') && i.console === 'exec')).toBe(true);
  });

  it('break-glass: cross-tenant leakage is flagged by the red team', async () => {
    // With an allow policy the cross-patient/cross-tenant control fails → finding.
    await app.inject({ method: 'PUT', url: '/admin/swarm/admin/policy', headers: { cookie: cookie(admin), 'content-type': 'application/json' }, payload: { defaultDecision: 'allow' } });
    const suite = await app.inject({ method: 'POST', url: '/admin/platform/red-team/run-suite', headers: { cookie: cookie(admin), 'content-type': 'application/json' }, payload: { ranBy: 'security' } });
    expect(suite.json().passed).toBe(false);
    const crossTenant = suite.json().findings.filter((f: { threatModel: string }) => f.threatModel === 'cross-tenant-leakage');
    expect(crossTenant.length).toBeGreaterThan(0);
    // Restore the safe policy.
    await app.inject({ method: 'PUT', url: '/admin/swarm/admin/policy', headers: { cookie: cookie(admin), 'content-type': 'application/json' }, payload: { defaultDecision: 'block' } });
  });
});
