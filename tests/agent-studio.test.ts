/******************************************************************************
 * Agent Studio + first-class DLQ (port plan Phase D) — tests.
 *
 * Proves the unified agent registry (published + drafts + topic bindings + run
 * stats + kill/rollback state), isolated contract tests, durable kill/rollback,
 * output-topic binding, and the DLQ detail → acknowledge → idempotent replay
 * journey.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { InProcessEventBroker } from '../src/server/inprocess-event-broker.js';
import { getSqlStore } from '../src/server/sql/index.js';
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

const DLQ_EVENT: CanonicalEvent = {
  id: 'evt:dlq-test', type: 'treatment.completed', occurredAt: '2026-08-26T00:00:00.000Z',
  scopeId: 'scope:test', subjectId: 'pt:test', facilityId: 'fac:test',
  payload: { sessions: 1 },
  provenance: { sourceId: 'test', observedAt: '2026-08-26T00:00:00.000Z', ingestedAt: '2026-08-26T00:00:00.000Z' },
  classification: 'confidential',
};

describe('agent studio (Phase D)', () => {
  let app: App;
  let admin: string;
  let firstPublished: { id: string; packId: string } | null = null;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('unified registry lists published + draft agents with topic/kill/run columns', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/agents', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThan(0);
    const published = body.agents.filter((a: { source: string }) => a.source === 'published');
    expect(published.length).toBeGreaterThan(0);
    for (const a of published.slice(0, 3)) {
      expect(typeof a.outputTopic).toBe('string');
      expect(typeof a.dlqTopic).toBe('string');
      expect(typeof a.killSwitch).toBe('boolean');
      expect(typeof a.runs).toBe('number');
    }
    firstPublished = { id: published[0].id, packId: published[0].packId };
  });

  it('contract test resolves trigger, governance, output and DLQ (no broker interaction)', async () => {
    expect(firstPublished).toBeTruthy();
    const res = await app.inject({ method: 'POST', url: `/admin/platform/agents/${firstPublished!.id}/test`, headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.statusCode).toBe(200);
    const t = res.json().test;
    expect(t.ok).toBe(true);
    expect(t.mode).toBe('contract-only');
    expect(t.contract.trigger).toBeTruthy();
    expect(t.contract.clearanceRequired).toBeTruthy();
    expect(t.outputTopic).toBe('anant.agent.output.v1');
    expect(t.dlqTopic).toBe('anant.agent.output.dlq.v1');
  });

  it('kill → registry reflects the kill switch → un-kill clears it', async () => {
    expect(firstPublished).toBeTruthy();
    const kill = await app.inject({ method: 'POST', url: `/admin/platform/agents/${firstPublished!.id}/kill`, headers: { cookie: cookie(admin) }, payload: { reason: 'regression in output', by: 'test' } });
    expect(kill.statusCode).toBe(200);
    expect(kill.json().killSwitch).toBe(true);

    let reg = await (await app.inject({ method: 'GET', url: '/admin/platform/agents', headers: { cookie: cookie(admin) } })).json();
    let row = reg.agents.find((a: { id: string }) => a.id === firstPublished!.id);
    expect(row.killSwitch).toBe(true);
    expect(row.killReason).toBe('regression in output');

    const unkill = await app.inject({ method: 'POST', url: `/admin/platform/agents/${firstPublished!.id}/un-kill`, headers: { cookie: cookie(admin) }, payload: {} });
    expect(unkill.json().killSwitch).toBe(false);
    reg = await (await app.inject({ method: 'GET', url: '/admin/platform/agents', headers: { cookie: cookie(admin) } })).json();
    row = reg.agents.find((a: { id: string }) => a.id === firstPublished!.id);
    expect(row.killSwitch).toBe(false);
  });

  it('output-topic binding persists and shows in the registry + topic plan', async () => {
    expect(firstPublished).toBeTruthy();
    const put = await app.inject({
      method: 'PUT', url: `/admin/platform/agents/${firstPublished!.id}/output-topic`,
      headers: { cookie: cookie(admin) },
      payload: { topic: 'anant.agent.dedicated.output.v1', dlqTopic: 'anant.agent.dedicated.dlq.v1' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().outputTopic).toBe('anant.agent.dedicated.output.v1');

    const reg = await (await app.inject({ method: 'GET', url: '/admin/platform/agents', headers: { cookie: cookie(admin) } })).json();
    const row = reg.agents.find((a: { id: string }) => a.id === firstPublished!.id);
    expect(row.outputTopic).toBe('anant.agent.dedicated.output.v1');

    const topics = await (await app.inject({ method: 'GET', url: '/admin/platform/topics', headers: { cookie: cookie(admin) } })).json();
    expect(topics.topics.entries.some((e: { owningAgent: string }) => e.owningAgent === firstPublished!.id)).toBe(true);
  });

  it('rollback request is durable', async () => {
    expect(firstPublished).toBeTruthy();
    const res = await app.inject({ method: 'POST', url: `/admin/platform/agents/${firstPublished!.id}/rollback`, headers: { cookie: cookie(admin) }, payload: { toVersion: '1.0.0', reason: 'revert behavior' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rollback.status).toBe('requested');
    const reg = await (await app.inject({ method: 'GET', url: '/admin/platform/agents', headers: { cookie: cookie(admin) } })).json();
    const row = reg.agents.find((a: { id: string }) => a.id === firstPublished!.id);
    expect(row.rollbackStatus).toBe('requested');
  });

  it('unknown agent → 404 on detail, test, kill', async () => {
    const detail = await app.inject({ method: 'GET', url: '/admin/platform/agents/no-such-agent', headers: { cookie: cookie(admin) } });
    expect(detail.statusCode).toBe(404);
    const test = await app.inject({ method: 'POST', url: '/admin/platform/agents/no-such-agent/test', headers: { cookie: cookie(admin) }, payload: {} });
    expect(test.statusCode).toBe(404);
    const kill = await app.inject({ method: 'POST', url: '/admin/platform/agents/no-such-agent/kill', headers: { cookie: cookie(admin) }, payload: {} });
    expect(kill.statusCode).toBe(404);
  });
});

describe('first-class DLQ journey (Phase D)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      adminApiAuth: true,
      eventBroker: new InProcessEventBroker(),
    });
    admin = await login(app, 'admin', 'admin123');
    // Seed a real outbox row + an incident receipt so the DLQ has a concrete item.
    const store = await getSqlStore();
    await store.enqueueOutboxEvent({ id: 'evt:dlq-test', topic: 'anant.agent.output.v1', scopeId: 'scope:test', eventJson: JSON.stringify(DLQ_EVENT), createdAt: '2026-08-26T00:00:00.000Z' });
    await store.recordBridgeReceipt({ outboxId: 'evt:dlq-test', topic: 'anant.agent.output.v1', partitionKey: 'scope:test', idempotencyKey: 'row:evt:dlq-test', publishedAt: '2026-08-26T00:00:05.000Z', state: 'incident', incident: 'publish-terminal: test poison' });
  });
  afterAll(async () => { await app.close(); });

  it('the incident appears in the DLQ list with an id', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/dlq', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.some((i: { outboxId: string }) => i.outboxId === 'evt:dlq-test')).toBe(true);
  });

  it('detail returns evidence (receipt + outbox row) + remediation history', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/dlq/evt:dlq-test', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const item = res.json().item;
    expect(item.topic).toBe('anant.agent.output.v1');
    expect(item.incident).toContain('publish-terminal');
    expect(item.idempotencyKey).toBe('row:evt:dlq-test');
    expect(Array.isArray(item.remediations)).toBe(true);
  });

  it('acknowledge records an owner', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/platform/dlq/evt:dlq-test/acknowledge', headers: { cookie: cookie(admin) }, payload: { owner: 'integration-ops', reason: 'taking ownership' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.status).toBe('acknowledged');
    const detail = await (await app.inject({ method: 'GET', url: '/admin/platform/dlq/evt:dlq-test', headers: { cookie: cookie(admin) } })).json();
    expect(detail.item.remediations.some((r: { status: string }) => r.status === 'acknowledged')).toBe(true);
  });

  it('replay publishes idempotently (original key) and records remediation', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/platform/dlq/evt:dlq-test/replay', headers: { cookie: cookie(admin) }, payload: { owner: 'integration-ops', reason: 'fixed upstream' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().item.status).toBe('replayed');
    expect(typeof res.json().replayId).toBe('string');

    const detail = await (await app.inject({ method: 'GET', url: '/admin/platform/dlq/evt:dlq-test', headers: { cookie: cookie(admin) } })).json();
    const replayed = detail.item.remediations.filter((r: { status: string }) => r.status === 'replayed');
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed[0].replayId).toBeTruthy();
  });

  it('unknown DLQ item → 404 on detail/ack/replay', async () => {
    const detail = await app.inject({ method: 'GET', url: '/admin/platform/dlq/nope', headers: { cookie: cookie(admin) } });
    expect(detail.statusCode).toBe(404);
    const ack = await app.inject({ method: 'POST', url: '/admin/platform/dlq/nope/acknowledge', headers: { cookie: cookie(admin) }, payload: {} });
    expect(ack.statusCode).toBe(404);
    const replay = await app.inject({ method: 'POST', url: '/admin/platform/dlq/nope/replay', headers: { cookie: cookie(admin) }, payload: {} });
    expect(replay.statusCode).toBe(404);
  });

  it('the UI "dlq:" prefixed id resolves the same incident (detail/ack/replay)', async () => {
    // The admin-ui list and My Work queue emit `dlq:<outboxId>`; the endpoints must
    // accept that form as well as the raw outboxId.
    const detail = await app.inject({ method: 'GET', url: '/admin/platform/dlq/dlq:evt:dlq-test', headers: { cookie: cookie(admin) } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().item.outboxId).toBe('evt:dlq-test');
    expect(detail.json().item.topic).toBe('anant.agent.output.v1');

    const ack = await app.inject({ method: 'POST', url: '/admin/platform/dlq/dlq:evt:dlq-test/acknowledge', headers: { cookie: cookie(admin) }, payload: { owner: 'ui-operator' } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().item.outboxId).toBe('evt:dlq-test');
    expect(ack.json().item.status).toBe('acknowledged');

    const replay = await app.inject({ method: 'POST', url: '/admin/platform/dlq/dlq:evt:dlq-test/replay', headers: { cookie: cookie(admin) }, payload: { owner: 'ui-operator', reason: 'fixed via UI' } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().ok).toBe(true);
    expect(replay.json().item.outboxId).toBe('evt:dlq-test');

    // Remediation ids stay clean (no `dlq:` nesting) and are linked to the incident.
    const after = await (await app.inject({ method: 'GET', url: '/admin/platform/dlq/evt:dlq-test', headers: { cookie: cookie(admin) } })).json();
    expect(after.item.remediations.some((r: { status: string }) => r.status === 'replayed')).toBe(true);
  });
});
