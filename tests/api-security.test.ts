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

/**
 * The setup surface used to exist ONLY under /admin/swarm/*, so the operator
 * console's setup pages called an exec-scoped API and were 403 for every ops
 * role except `admin` — the one role in both consoles. Worse, the pages then
 * swallowed the 403 and rendered hardcoded defaults (5000bp shown for a real
 * 8200bp policy). These tests pin the ops-scoped twins AND that they read the
 * SAME document as the exec-scoped family.
 */
describe('ops-scoped setup surface (/admin/platform/*)', () => {
  it('ops role can reach setup that it was denied under the swarm prefix', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');

    const denied = await app.inject({ method: 'GET', url: '/admin/swarm/admin/policy', headers: { cookie } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().console).toBe('exec');

    const allowed = await app.inject({ method: 'GET', url: '/admin/platform/policy', headers: { cookie } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().policy.defaultDecision).toBeDefined();
  });

  it('both spellings read one document — the ops write is visible to the exec twin', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');

    const before = (await app.inject({ method: 'GET', url: '/admin/platform/policy', headers: { cookie } })).json().policy;

    const written = await app.inject({
      method: 'PUT', url: '/admin/platform/policy', headers: { cookie },
      payload: { ...before, escalationThresholdBasisPoints: 7400 },
    });
    expect(written.statusCode).toBe(200);
    expect(written.json().policy.escalationThresholdBasisPoints).toBe(7400);

    // The exec-scoped family serves the same row: admin can see the nurse's write.
    const adminCookie = await login(app, 'admin', 'admin123');
    const viaSwarm = await app.inject({ method: 'GET', url: '/admin/swarm/admin/policy', headers: { cookie: adminCookie } });
    expect(viaSwarm.statusCode).toBe(200);
    expect(viaSwarm.json().policy.escalationThresholdBasisPoints).toBe(7400);

    // Restore — the workspace store is process-global across this worker.
    await app.inject({
      method: 'PUT', url: '/admin/platform/policy', headers: { cookie },
      payload: { ...before, escalationThresholdBasisPoints: before.escalationThresholdBasisPoints },
    });
  });

  it('rejects an out-of-range threshold rather than storing it', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const res = await app.inject({
      method: 'PUT', url: '/admin/platform/policy', headers: { cookie },
      payload: { escalationThresholdBasisPoints: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid-threshold');
    expect(res.json().field).toBe('escalationThresholdBasisPoints');
  });

  it('accepts a secret binding REFERENCE and refuses a secret VALUE', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');

    const secret = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/kafka', headers: { cookie },
      payload: { secretRef: 'AKIAIOSFODNN7EXAMPLE1234567890abcdef' },
    });
    expect(secret.statusCode).toBe(400);
    expect(secret.json().error).toBe('secret-value-rejected');

    const binding = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/kafka', headers: { cookie },
      payload: { bridgeUrl: 'https://bridge.example', clusterAlias: 'c', securityProtocol: 'SASL_SSL', secretRef: 'binding:KAFKA_BRIDGE_TOKEN' },
    });
    expect(binding.statusCode).toBe(200);
    expect(binding.json().kafka.secretRef).toBe('binding:KAFKA_BRIDGE_TOKEN');

    const badProtocol = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/kafka', headers: { cookie },
      payload: { securityProtocol: 'NOPE' },
    });
    expect(badProtocol.statusCode).toBe(400);
    expect(badProtocol.json().error).toBe('invalid-security-protocol');
  });

  it('exec-only roles may READ the configuration but may not write it', async () => {
    const app = await build();
    const adminCookie = await login(app, 'admin', 'admin123');
    await app.inject({
      method: 'POST', url: '/admin/auth/users', headers: { cookie: adminCookie },
      payload: { username: 'md2', password: 'md2pass', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'] },
    });
    const mdCookie = await login(app, 'md2', 'md2pass');

    const swarm = await app.inject({ method: 'GET', url: '/admin/swarm/cells', headers: { cookie: mdCookie } });
    expect(swarm.statusCode).toBe(200);

    // Read: allowed. The executive console shows a read-only view of the SAME
    // documents the operator console writes, rather than a second spelling of them.
    const read = await app.inject({ method: 'GET', url: '/admin/platform/policy', headers: { cookie: mdCookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json().policy.defaultDecision).toBeDefined();

    // Write: refused, because setup is an operations activity.
    const write = await app.inject({
      method: 'PUT', url: '/admin/platform/policy', headers: { cookie: mdCookie },
      payload: { escalationThresholdBasisPoints: 6000 },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().console).toBe('ops');
  });

  it('a read-only role can read the configuration and is refused every write', async () => {
    const app = await build();
    const cookie = await login(app, 'auditor', 'audit123');

    // Read: the compliance role's whole purpose is to see what the platform is set to do.
    for (const url of ['/admin/platform/policy', '/admin/platform/config-objects', '/admin/platform/releases', '/admin/platform/release-gate']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
    }

    // Write: refused, on the setup surface, with a message that says why.
    const writes: Array<{ method: 'PUT' | 'POST' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'PUT', url: '/admin/platform/policy', payload: { escalationThresholdBasisPoints: 6000 } },
      { method: 'PUT', url: '/admin/platform/organization', payload: { displayName: 'Renamed by an auditor' } },
      { method: 'PUT', url: '/admin/platform/topics', payload: { entries: [] } },
      { method: 'POST', url: '/admin/platform/packs/deactivate' },
      { method: 'POST', url: '/admin/platform/releases', payload: { version: 'auditor-draft' } },
    ];
    for (const w of writes) {
      const res = await app.inject({ method: w.method, url: w.url, headers: { cookie }, ...(w.payload ? { payload: w.payload } : {}) });
      expect(res.statusCode, `${w.method} ${w.url}`).toBe(403);
      expect(res.json().error, `${w.method} ${w.url}`).toBe('read-only-role');
    }

    // …but the role's compliance WORKFLOW is not the configuration, so it stays open.
    const dlq = await app.inject({ method: 'GET', url: '/admin/platform/dlq', headers: { cookie } });
    expect(dlq.statusCode).toBe(200);
  });

  it('release gate serves the real verdict, not a hardcoded gate strip', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const res = await app.inject({ method: 'GET', url: '/admin/platform/release-gate', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { input, verdict } = res.json();
    expect(['ship', 'hold', 'block']).toContain(verdict.decision);
    expect(input.green.length).toBeGreaterThan(0);
    expect(typeof verdict.redContained).toBe('number');
    expect(typeof verdict.sourcesCurrent).toBe('boolean');
    expect(typeof verdict.approvalsMet).toBe('boolean');
    // Every check carries its own evidence — the strip the studio used had none.
    expect(input.green[0].check).toBeTruthy();
    expect(input.green[0].evidence).toBeTruthy();
  });

  it('config objects are durable rows with a kind allow-list', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');

    const list = await app.inject({ method: 'GET', url: '/admin/platform/config-objects', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().catalogs).toBeTruthy();

    // Single-document kind → { data, id }, and it says where it is stored.
    const single = await app.inject({ method: 'GET', url: '/admin/platform/config-objects/operating-model', headers: { cookie } });
    expect(single.statusCode).toBe(200);
    expect(single.json().storage).toBe('swarm_workspace');

    const unknown = await app.inject({ method: 'GET', url: '/admin/platform/config-objects/not-a-kind', headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('config-object-kind-not-found');
    expect(Array.isArray(unknown.json().allowed)).toBe(true);
  });

  it('release delete is 404 for an unknown id and unauthenticated access is 401', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const missing = await app.inject({ method: 'DELETE', url: '/admin/platform/releases/nope', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('release-not-found');

    const anon = await app.inject({ method: 'GET', url: '/admin/platform/policy' });
    expect(anon.statusCode).toBe(401);
  });
});
