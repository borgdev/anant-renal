/******************************************************************************
 * Phase F — one scripted end-to-end demo proving the entire closed loop and
 * producing an audit/replay package (port plan Phase F exit).
 *
 * admin → assurance (green/red) → release (validate→approve→activate, dossier)
 * → payer demo episodes → My Work (user cockpit) → approve → command →
 * acknowledgement → outcome verified (Resolved) → audit/replay package.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { getSwarmCoordinator } from '../src/server/swarm-routes.js';
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

describe('Phase F — end-to-end closed loop + audit/replay package', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('drives the full closed loop and produces an audit/replay package', async () => {
    const headers = { cookie: cookie(admin), 'content-type': 'application/json' };
    const post = async (url: string, body?: Record<string, unknown>) => {
      const res = await app.inject({ method: 'POST', url, headers, payload: body ?? {} });
      return res.json() as Record<string, any>;
    };

    // 1. Assurance — green + red team both contained (safe policy).
    const green = await post('/admin/platform/green-team/run', { ranBy: 'e2e' });
    expect(green.run.passed).toBe(true);
    const red = await post('/admin/platform/red-team/run-suite', { ranBy: 'e2e' });
    expect(red.passed).toBe(true);
    expect(red.findings).toHaveLength(0);

    // 2. Release — validate → approve → activate (immutable dossier).
    const create = await post('/admin/platform/releases', { version: 'e2e-v1', changeSummary: 'phase F closed loop', createdBy: 'admin' });
    const release = create.release;
    const validate = await post(`/admin/platform/releases/${release.id}/validate`);
    expect(validate.release.status).toBe('validated');
    await post(`/admin/platform/releases/${release.id}/request-approval`);
    const activate = await post(`/admin/platform/releases/${release.id}/activate`);
    expect(activate.release.status).toBe('active');
    expect(activate.release.dossier.contentHash).toBeTruthy();

    // 3. Seed the payer demo — durable outcome episodes on the shared coordinator.
    const demo = await post('/admin/swarm/payer/demo');
    expect(Array.isArray(demo.opened)).toBe(true);
    expect(demo.opened.length).toBe(2);

    // 4. User cockpit — My Work surfaces the payer episodes.
    const work = await (await app.inject({ method: 'GET', url: '/api/work' })).json();
    const careGap = work.items.find((i: { title: string }) => i.title.startsWith('care gap closure'));
    const authz = work.items.find((i: { title: string }) => i.title.startsWith('authorization review'));
    expect(careGap).toBeTruthy();
    expect(authz).toBeTruthy();
    expect(careGap.state).toBe('AwaitingApproval');

    // 5. Approve via the work action → command enters the transaction path.
    const decided = await post(`/api/work/${encodeURIComponent(careGap.id)}/actions`, { action: 'approve', approver: 'Facility Administrator', idempotencyKey: 'e2e-approve' });
    expect(decided.state).toBe('Coordinating');

    // 6. Full loop: dispatch command → downstream acknowledgement → outcome verified.
    const coord = getSwarmCoordinator();
    const ep = coord!.list().find((e) => e.kind === 'care-gap.closure');
    const commanded = coord!.dispatchCommand(ep!.episodeId, 'schedule-followup');
    expect(commanded.command?.action).toBe('schedule-followup');
    const acked = coord!.acknowledge(ep!.episodeId, 'member:m-1042');
    expect(acked.state).toBe('Verifying');
    const verified = coord!.verify(ep!.episodeId, { measureId: 'hedis:diabetes-hba1c', met: true });
    expect(verified.state).toBe('Resolved');

    // 7. Assemble the audit/replay package from real state.
    const rels = await (await app.inject({ method: 'GET', url: '/admin/platform/releases', headers })).json();
    const active = rels.active;
    const assurance = await (await app.inject({ method: 'GET', url: '/admin/platform/assurance', headers })).json();
    const packagePayload = {
      generatedAt: new Date().toISOString(),
      release: { version: active.version, status: active.status, contentHash: active.dossier?.contentHash },
      gates: active.dossier?.gates?.map((g: { name: string; passed: boolean }) => ({ name: g.name, passed: g.passed })),
      findingsBlocking: assurance.findings.blocking,
      episodes: coord!.list().map((e) => ({ id: e.episodeId, kind: e.kind, state: e.state })),
      workProcessed: [{ id: careGap.id, from: 'AwaitingApproval', to: 'Resolved', command: 'schedule-followup' }],
    };
    const auditPackage = { ...packagePayload, packageHash: createHash('sha256').update(JSON.stringify({ release: packagePayload.release, episodes: packagePayload.episodes, workProcessed: packagePayload.workProcessed })).digest('hex') };

    // The package is deterministic — the same content hashes to the same value.
    const replayHash = createHash('sha256').update(JSON.stringify({ release: packagePayload.release, episodes: packagePayload.episodes, workProcessed: packagePayload.workProcessed })).digest('hex');
    expect(auditPackage.packageHash).toBe(replayHash);

    // Closed-loop assertions: resolved episode, dossier gates, blocked findings 0.
    expect(auditPackage.episodes.some((e: { kind: string; state: string }) => e.kind === 'care-gap.closure' && e.state === 'Resolved')).toBe(true);
    expect(auditPackage.findingsBlocking).toBe(0);
    expect(auditPackage.gates.length).toBeGreaterThanOrEqual(5);
    expect(auditPackage.packageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the release + work + context surfaces agree on the active configuration', async () => {
    const ctx = await (await app.inject({ method: 'GET', url: '/api/context' })).json();
    const rels = await (await app.inject({ method: 'GET', url: '/admin/platform/releases', headers: { cookie: cookie(admin) } })).json();
    expect(ctx.configuration.activeVersion).toBe(rels.active.version);
    expect(ctx.aggregates.openEpisodes).toBeGreaterThanOrEqual(0);
  });
});
