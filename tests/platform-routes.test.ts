/******************************************************************************
 * Generic platform contract layer (port plan Phase A/B) — tests.
 *
 * Covers the /admin/platform/* administration surface, the public /api/context,
 * /api/work (My Work), /api/graph and /api/canvases experience APIs, including
 * role-scoping of the work queue and idempotent work actions.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { payerPack } from '../packs/payer/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NOW = '2026-08-26T09:00:00.000Z';

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
    adminApiAuth: true, // match the real runtime: /admin/* requires a session
  });
}

/** POST /auth/login → the hh_session cookie value. */
async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const m = /hh_session=([^;]+)/.exec(raw);
  const token = m?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

describe('platform administration (/admin/platform/*)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('blocks unauthenticated /admin/platform/* requests (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/bootstrap' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('not-authenticated');
  });

  it('bootstrap reports onboarding state and the first gate', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/bootstrap', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('onboarding');
    expect(body.onboarding.currentStep).toBe('organization');
    expect(body.onboarding.gates.organization).toBe(false);
    expect(body.onboarding.gates.identity).toBe(true); // seeded users exist
    expect(Array.isArray(body.onboarding.steps)).toBe(true);
    expect(body.onboarding.steps.length).toBe(8);
    expect(body.onboarding.readyForRehearsal).toBe(false);
  });

  it('PUT /admin/platform/organization persists a provider hierarchy and unlocks the organization gate', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/admin/platform/organization',
      headers: { cookie: cookie(admin) },
      payload: {
        operatingModel: 'provider',
        displayName: 'Riverbend Kidney Care',
        region: 'us-south', timezone: 'America/Chicago', retentionDays: 365,
        scopePath: [
          { id: 'ent', level: 'enterprise', label: 'Enterprise' },
          { id: 'div', level: 'division', label: 'Renal Division' },
          { id: 'reg', level: 'region', label: 'Nashville' },
          { id: 'fac', level: 'facility', label: 'Franklin' },
        ],
        synthetic: true,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().organization.operatingModel).toBe('provider');
    expect(put.json().organization.scopePath.length).toBe(4);

    const get = await app.inject({ method: 'GET', url: '/admin/platform/organization', headers: { cookie: cookie(admin) } });
    expect(get.statusCode).toBe(200);
    expect(get.json().organization.displayName).toBe('Riverbend Kidney Care');
    expect(Array.isArray(get.json().realized)).toBe(true);

    const boot = await app.inject({ method: 'GET', url: '/admin/platform/bootstrap', headers: { cookie: cookie(admin) } });
    expect(boot.json().onboarding.gates.organization).toBe(true);
    expect(boot.json().onboarding.currentStep).toBe('integrations');
  });

  it('rejects an invalid operating model', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/platform/organization',
      headers: { cookie: cookie(admin) },
      payload: { operatingModel: 'accounting' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid-operating-model');
  });

  it('topic plan round-trips with the required product topics', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/topics', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaults.defaultOutputTopic).toBe('anant.agent.output.v1');

    const put = await app.inject({
      method: 'PUT', url: '/admin/platform/topics',
      headers: { cookie: cookie(admin) },
      payload: {
        defaultOutputTopic: 'anant.agent.output.v1',
        agentDlqTopic: 'anant.agent.output.dlq.v1',
        actionCommandTopic: 'anant.action.command.v1',
        actionAckTopic: 'anant.action.ack.v1',
        outcomeStateTopic: 'anant.outcome.state.v1',
        assuranceEventTopic: 'anant.assurance.event.v1',
        entries: [
          { id: 't1', topic: 'anant.agent.output.v1', direction: 'outbound', contract: 'agent-output-envelope.v1', partitions: 6, keyStrategy: 'episode' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: '/admin/platform/topics', headers: { cookie: cookie(admin) } });
    expect(got.json().topics.entries.length).toBe(1);
    expect(got.json().topics.entries[0].keyStrategy).toBe('episode');
  });

  it('onboarding PUT records progress and persists the rail', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/admin/platform/onboarding',
      headers: { cookie: cookie(admin) },
      payload: { operatingModel: 'provider', completedSteps: ['organization'], currentStep: 'integrations' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().onboarding.completedSteps).toContain('organization');
    const boot = await app.inject({ method: 'GET', url: '/admin/platform/bootstrap', headers: { cookie: cookie(admin) } });
    expect(boot.json().onboarding.currentStep).toBe('integrations');
  });

  it('integrations summary reflects kafka/fhir/identity/cms state', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/integrations', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity.users).toBeGreaterThanOrEqual(3);
    expect(body.identity.roles).toContain('admin');
    expect(Array.isArray(body.fhir.resources)).toBe(false);
    expect(typeof body.cms.sources).toBe('number');
  });

  it('release lifecycle: draft → validate → request-approval → activate → rollback', async () => {
    const create = await app.inject({
      method: 'POST', url: '/admin/platform/releases',
      headers: { cookie: cookie(admin) },
      payload: { version: 'v2', changeSummary: 'Payer lens enablement', createdBy: 'admin' },
    });
    expect(create.statusCode).toBe(200);
    const release = create.json().release;
    expect(release.status).toBe('draft');

    const validate = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/validate`, headers: { cookie: cookie(admin) } });
    expect(validate.json().release.status).toBe('validated');

    const approve = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/request-approval`, headers: { cookie: cookie(admin) } });
    expect(approve.json().release.status).toBe('approved');

    const activate = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/activate`, headers: { cookie: cookie(admin) } });
    expect(activate.json().release.status).toBe('active');

    const list = await app.inject({ method: 'GET', url: '/admin/platform/releases', headers: { cookie: cookie(admin) } });
    expect(list.json().active.version).toBe('v2.draft');

    // Activate a second release → the first is superseded, second is active.
    const create2 = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'v3' } });
    const rel2 = create2.json().release;
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${rel2.id}/validate`, headers: { cookie: cookie(admin) } });
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${rel2.id}/request-approval`, headers: { cookie: cookie(admin) } });
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${rel2.id}/activate`, headers: { cookie: cookie(admin) } });

    // Roll back to the first release → v2.draft active again, v3 rolled back.
    const rollback = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/rollback`, headers: { cookie: cookie(admin) } });
    expect(rollback.json().release.status).toBe('active');
    const after = await app.inject({ method: 'GET', url: '/admin/platform/releases', headers: { cookie: cookie(admin) } });
    expect(after.json().active.id).toBe(release.id);
    const rolled = after.json().releases.find((r: { id: string }) => r.id === rel2.id);
    expect(rolled.status).toBe('rolled-back');
  });

  it('DLQ inspection returns a stable shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/dlq', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.brokerDepth).toBe('number');
    expect(typeof body.outbox.pending).toBe('number');
    expect(Array.isArray(body.incidents)).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe('public experience APIs (/api/context, /api/work, /api/graph, /api/canvases)', () => {
  let app: App;
  let admin: string;
  let nurse: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
    nurse = await login(app, 'nurse', 'nurse123');
  });
  afterAll(async () => { await app.close(); });

  it('/api/context is public and reports the active pack/lens + navigation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/context' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(false);
    // NO consoles for a caller with no session: answering here is what tells a
    // client who it is, and advertising both consoles was a role claim nothing
    // backed (the switcher reads this list). Navigation is per-console, so it
    // is empty too.
    expect(res.json().consoles).toEqual([]);
    expect(res.json().capabilities).toEqual([]);
    expect(res.json().navigation).toEqual([]);
    // the pack/lens is not role-scoped, so the route still reports it
    expect(res.json().pack.id).toBeTruthy();
    expect(typeof res.json().aggregates).toBe('object');
  });

  it('/api/context reflects the authenticated role and its consoles', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/context', headers: { cookie: cookie(admin) } });
    const body = res.json();
    expect(body.authenticated).toBe(true);
    expect(body.role).toBe('admin');
    expect(body.user.username).toBe('admin');
    expect(body.consoles).toEqual(['exec', 'ops']);
    expect(body.capabilities).toContain('release.approve');
    expect(body.capabilities).toContain('dlq.remediate');

    const nurseCtx = await app.inject({ method: 'GET', url: '/api/context', headers: { cookie: cookie(nurse) } });
    expect(nurseCtx.json().consoles).toEqual(['ops']);
    expect(nurseCtx.json().capabilities).toContain('dlq.remediate');
    expect(nurseCtx.json().capabilities).not.toContain('release.approve');
  });

  it('/api/work is role-scoped: admin sees approval work, nurse does not', async () => {
    // A release ready for approval is exec work.
    const create = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'work-1' } });
    const rel = create.json().release;
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${rel.id}/validate`, headers: { cookie: cookie(admin) } });

    // An open outcome episode awaiting approval is exec work.
    const ep = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) }, payload: { kind: 'continuity', subject: 'pt-1', scopeType: 'patient' } });
    const epId = ep.json().episode?.episodeId ?? ep.json().episode?.id;
    expect(epId).toBeTruthy();
    await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${epId}/propose`, headers: { cookie: cookie(admin) } });

    const adminWork = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } });
    const adminItems = adminWork.json().items;
    expect(adminItems.some((i: { id: string }) => i.id === `release:${rel.id}`)).toBe(true);
    expect(adminItems.some((i: { id: string; kind: string; state: string }) => i.kind === 'episode' && i.state === 'AwaitingApproval')).toBe(true);

    const nurseWork = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(nurse) } });
    expect(nurseWork.json().items.some((i: { id: string }) => i.id === `release:${rel.id}`)).toBe(false);
  });

  it('refuses the work queue without a session', async () => {
    // The queue is ROLE-SCOPED, so it is meaningless without a principal — and while
    // it was readable anonymously it returned every patient-scoped suggestion
    // (patient ids, the clinical reason, the owner role) to anyone who asked.
    for (const url of ['/api/work', '/api/work/episode:nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} answered an anonymous caller`).toBe(401);
      expect(res.json()).toMatchObject({ error: 'not-authenticated' });
    }
    const act = await app.inject({
      method: 'POST', url: '/api/work/episode:nope/actions',
      payload: { action: 'approve' },
    });
    // a decision is attributed to a person; there is no anonymous decider
    expect(act.statusCode).toBe(401);
  });

  it('advertises no consoles to an unauthenticated caller', async () => {
    // an empty list, not both: the console switcher reads this, and claiming a
    // console no session backs is a role claim nothing supports
    const res = await app.inject({ method: 'GET', url: '/api/context' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(false);
    expect(res.json().consoles).toEqual([]);
    // and the role-scoped alternative still works for a real session
    const nurseCtx = await app.inject({ method: 'GET', url: '/api/context', headers: { cookie: cookie(nurse) } });
    expect(nurseCtx.json().consoles).toEqual(['ops']);
  });

  it('/api/work/:id returns a universal detail for an episode', async () => {
    const ep = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) }, payload: { kind: 'access-review', subject: 'pt-2', scopeType: 'patient' } });
    const epId = ep.json().episode?.episodeId ?? ep.json().episode?.id;
    await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${epId}/propose`, headers: { cookie: cookie(admin) } });
    const res = await app.inject({ method: 'GET', url: `/api/work/episode:${epId}`, headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const detail = res.json().detail;
    expect(detail.kind).toBe('episode');
    expect(detail.state).toBe('AwaitingApproval');
    expect(Array.isArray(detail.activity)).toBe(true);
    expect(detail.policy.approvalClass).toBeTruthy();
    expect(detail.assurance.dossierHash).toBeTruthy();
  });

  it('/api/work/:id/actions approves a release idempotently', async () => {
    const create = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'work-approve' } });
    const rel = create.json().release;
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${rel.id}/validate`, headers: { cookie: cookie(admin) } });

    const act = await app.inject({
      method: 'POST', url: `/api/work/release:${rel.id}/actions`, headers: { cookie: cookie(admin) },
      payload: { action: 'approve', approver: 'admin', idempotencyKey: `ik-${rel.id}` },
    });
    expect(act.statusCode).toBe(200);
    expect(act.json().state).toBe('approved');

    // Same idempotency key → cached result flagged duplicate, no second mutation.
    const dup = await app.inject({
      method: 'POST', url: `/api/work/release:${rel.id}/actions`, headers: { cookie: cookie(admin) },
      payload: { action: 'approve', approver: 'admin', idempotencyKey: `ik-${rel.id}` },
    });
    expect(dup.json().duplicate).toBe(true);
  });

  it('/api/work/:id/actions approves an episode (AwaitingApproval → Coordinating)', async () => {
    const ep = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) }, payload: { kind: 'capacity', subject: 'fac-1', scopeType: 'facility' } });
    const epId = ep.json().episode?.episodeId ?? ep.json().episode?.id;
    await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${epId}/propose`, headers: { cookie: cookie(admin) } });
    const res = await app.inject({
      method: 'POST', url: `/api/work/episode:${epId}/actions`, headers: { cookie: cookie(admin) },
      payload: { action: 'approve', approver: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('Coordinating');
  });

  it('/api/work/:id/actions fails closed on an invalid episode transition', async () => {
    // AwaitingApproval → Escalated is not a valid transition; the API must
    // explain the block (400) instead of crashing (500).
    const ep = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) }, payload: { kind: 'access-review', subject: 'pt-3', scopeType: 'patient' } });
    const epId = ep.json().episode?.episodeId ?? ep.json().episode?.id;
    await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${epId}/propose`, headers: { cookie: cookie(admin) } });
    const res = await app.inject({
      method: 'POST', url: `/api/work/episode:${epId}/actions`, headers: { cookie: cookie(admin) },
      payload: { action: 'escalate', reason: 'no slot available' },
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('/api/graph returns a typed topology projection', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/graph' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().nodes)).toBe(true);
    expect(Array.isArray(res.json().edges)).toBe(true);
    expect(res.json().nodes.length).toBeGreaterThan(0);
  });

  it('/api/canvases CRUD round-trips a saved shared-intelligence canvas', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/canvases',
      payload: { name: 'Continuity Risk Map', scopeId: 'scope:enterprise', createdBy: 'admin' },
    });
    expect(create.statusCode).toBe(200);
    const canvas = create.json().canvas;
    expect(canvas.version).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/api/canvases' });
    expect(list.json().canvases.some((c: { id: string }) => c.id === canvas.id)).toBe(true);

    const put = await app.inject({ method: 'PUT', url: `/api/canvases/${canvas.id}`, payload: { notes: [{ body: 'flagged', by: 'admin', at: NOW }] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().canvas.version).toBe(2);
    expect(put.json().canvas.notes.length).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/canvases/${canvas.id}` });
    expect(del.json().ok).toBe(true);
    const missing = await app.inject({ method: 'GET', url: `/api/canvases/${canvas.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('nurse role sees ops-scoped work and can operate the topic plan', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/platform/topics', headers: { cookie: cookie(nurse) },
      payload: { defaultOutputTopic: 'anant.agent.output.v1', agentDlqTopic: 'anant.agent.output.dlq.v1', actionCommandTopic: 'anant.action.command.v1', actionAckTopic: 'anant.action.ack.v1', outcomeStateTopic: 'anant.outcome.state.v1', assuranceEventTopic: 'anant.assurance.event.v1', entries: [] },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Pack Studio (/admin/platform/packs — real catalog + durable lens switch)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      // payer registered after healthcare-core satisfies its extends range.
      packs: [healthcareCorePack, payerPack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      adminApiAuth: true,
    });
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('GET /admin/platform/packs lists the REAL installed packs with lens + active flag', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/packs', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.packs.map((p: { id: string }) => p.id);
    expect(ids).toContain('healthcare-core');
    expect(ids).toContain('payer');
    const core = body.packs.find((p: { id: string }) => p.id === 'healthcare-core');
    expect(core.lens).toBe('hybrid'); // provider + payer kinds
    const payer = body.packs.find((p: { id: string }) => p.id === 'payer');
    expect(payer.lens).toBe('payer');
    expect(body.activePack).toBeNull();
    expect(body.packs.every((p: { active: boolean }) => p.active === false)).toBe(true);
  });

  it('activating a pack flips /api/context pack.id + lens (durable lens switch)', async () => {
    const act = await app.inject({
      method: 'POST', url: '/admin/platform/packs/payer/activate', headers: { cookie: cookie(admin) }, payload: { by: 'test' },
    });
    expect(act.statusCode).toBe(200);
    expect(act.json().pack.lens).toBe('payer');

    const ctx = await app.inject({ method: 'GET', url: '/api/context' });
    expect(ctx.json().pack).toEqual({ id: 'payer', lens: 'payer' });

    const listed = await app.inject({ method: 'GET', url: '/admin/platform/packs', headers: { cookie: cookie(admin) } });
    const payer = listed.json().packs.find((p: { id: string }) => p.id === 'payer');
    expect(payer.active).toBe(true);
  });

  it('rejects activating a pack that is not installed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/platform/packs/not-a-real-pack/activate', headers: { cookie: cookie(admin) }, payload: { by: 'test' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('pack-not-installed');
  });

  it('deactivating restores the operating-model default lens', async () => {
    const deact = await app.inject({ method: 'POST', url: '/admin/platform/packs/deactivate', headers: { cookie: cookie(admin) } });
    expect(deact.statusCode).toBe(200);
    const ctx = await app.inject({ method: 'GET', url: '/api/context' });
    // Falls back to the operating-model derivation (a provider org is persisted
    // by an earlier suite via the shared workspace singleton) — NOT the pack.
    expect(ctx.json().pack.id).toBe('healthcare.provider');
    expect(ctx.json().pack.lens).toBe('provider');
  });
});
