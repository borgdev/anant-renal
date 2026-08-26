/******************************************************************************
 * Epic 10 / Journey O — Shared Intelligence: hypergraph-bound canvases.
 *
 * Proves: canvas CRUD, versioned cited notes, and the isolated what-if entry
 * that replays the swarm boundary at a different consensus threshold and
 * records the cited simulation as a canvas note (graph insight → cited
 * work/release decision).
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

describe('Shared Intelligence canvases (Epic 10 / Journey O)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('creates a canvas and adds a versioned, cited note', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/canvases', headers: { cookie: cookie(admin) }, payload: { name: 'Care coordination view', scopeId: 'scope:enterprise', createdBy: 'admin' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().canvas.version).toBe(1);
    const id = created.json().canvas.id;

    const note = await app.inject({ method: 'POST', url: `/api/canvases/${id}/notes`, headers: { cookie: cookie(admin) }, payload: { body: 'Network adequacy drives referral steering', by: 'admin', citation: 'cms-cy2026-final' } });
    expect(note.json().canvas.version).toBe(2);
    expect(note.json().note.citation).toBe('cms-cy2026-final');
    expect(note.json().canvas.notes).toHaveLength(1);
  });

  it('what-if replays the swarm boundary at a different consensus threshold and records a cited note', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/canvases', headers: { cookie: cookie(admin) }, payload: { name: 'Payer threshold study', createdBy: 'admin' } });
    const id = created.json().canvas.id;

    const sim = await app.inject({ method: 'POST', url: `/api/canvases/${id}/simulate`, headers: { cookie: cookie(admin) }, payload: { threshold: 0.6, by: 'analyst' } });
    expect(sim.statusCode).toBe(200);
    const body = sim.json();
    expect(body.simulation.simulation).toBe(true);
    expect(typeof body.simulation.episodesSurfaced).toBe('number');
    expect(body.simulation.threshold).toBe(0.6);
    expect(body.canvas.version).toBe(2);
    expect(body.note.citation).toBe('what-if:threshold=0.6');
    expect(body.canvas.notes).toHaveLength(1);
    expect(body.note.body).toContain('What-if at consensus 60%');

    // Invalid threshold → 400.
    const bad = await app.inject({ method: 'POST', url: `/api/canvases/${id}/simulate`, headers: { cookie: cookie(admin) }, payload: { threshold: 1.5 } });
    expect(bad.statusCode).toBe(400);
  });

  it('canvases resolve against the typed hypergraph (/api/graph)', async () => {
    const graph = await app.inject({ method: 'GET', url: '/api/graph' });
    expect(graph.statusCode).toBe(200);
    expect(Array.isArray(graph.json().nodes)).toBe(true);
    expect(Array.isArray(graph.json().edges)).toBe(true);
  });
});
