/******************************************************************************
 * Anemia / ESA dose-adjustment CDSS (P0 reference) — tests.
 *
 * Proves the manifold-learning EPO decision-support domain closes a governed,
 * Class-C, human-in-the-loop loop through the SAME coordinator + workspace
 * contracts: cells + feature catalog + advise endpoint (guardrails + surrogate
 * + drivers + latent), durable anemia episodes seeding into My Work (without
 * flipping the provider lens), targeted reset, and exec-role guarding.
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

/** Standard ESA patient window builder for the advise endpoint. */
const win = (over: Record<string, unknown>) => ({
  patientId: 'p-esa-t', currentHgb: 10.6, mcv: 92, ferritin: 640, transferrinSat: 28,
  crp: 6, calcium: 9.2, pth: 120, onESA: true, currentDose: 8000,
  hgbTrendLast90d: [10.1, 10.3, 10.4, 10.6], esaEscalationsLast90d: 0,
  lastIronPanelAt: '2026-08-01T00:00:00Z', asOf: '2026-09-01T00:00:00Z',
  ...over,
});

describe('anemia / ESA CDSS (P0 reference)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('exposes the ESA bounded cells + feature catalog (Class C, CDSS posture)', async () => {
    const cellsRes = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/cells', headers: { cookie: cookie(admin) } });
    expect(cellsRes.statusCode).toBe(200);
    const cells = cellsRes.json().cells;
    expect(cells.map((c: { id: string }) => c.id).sort()).toEqual(['esa-dose-optimization', 'iron-management']);
    for (const c of cells) {
      expect(Array.isArray(c.allowedActions)).toBe(true);
      expect(c.approvalClass).toBe('C'); // never autonomous — Class C human approval
      // ESA titration / ordering actions are within the allowlist (never holds/denials).
      expect(c.allowedActions).toEqual(expect.arrayContaining(['order-med', 'order-lab']));
    }

    const feat = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/features', headers: { cookie: cookie(admin) } });
    expect(feat.statusCode).toBe(200);
    const f = feat.json();
    expect(f.hgbTarget).toEqual({ min: 10, max: 12 });
    expect(f.model.kind).toBe('reference-surrogate');
    expect(f.safety.approvalClass).toBe('C');
    expect(f.safety.posture).toContain('human-in-the-loop');
    const hgb = f.features.find((x: { id: string }) => x.id === 'hgb');
    expect(hgb.loinc).toBe('718-7');
    expect(hgb.relevance).toBeGreaterThan(0);
  });

  it('advise holds the dose when Hb is in band and iron is fresh', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: win({}) });
    expect(res.statusCode).toBe(200);
    const rec = res.json().recommendation;
    expect(rec.inTargetBand).toBe(true);
    expect(rec.guardrails.blocked).toBe(false);
    expect(rec.direction).toBe('hold');
    expect(rec.recommendedDose).toBe(8000);
    expect(rec.delta).toBe(0);
    expect(rec.latent).toHaveProperty('l1');
    expect(rec.latent).toHaveProperty('polarRadius');
    expect(rec.model.kind).toBe('reference-surrogate');
    expect(rec.synthetic).toBe(true);
    // Prior EPO is the dominant driver (~0.40), MCV second (~0.16) — paper Fig. 10.
    expect(rec.drivers[0].id).toBe('priorEpo');
    expect(rec.drivers[0].relevance).toBe(0.4);
    expect(rec.drivers[1].id).toBe('mcv');
  });

  it('advise reduces ~25% when Hb is above the band', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: win({ currentHgb: 12.6 }) });
    const rec = res.json().recommendation;
    expect(rec.guardrails.flags).toContain('hgb-above-11-on-esa');
    expect(rec.direction).toBe('reduce');
    expect(rec.recommendedDose).toBe(6000); // 8000 * 0.75
    expect(rec.note).toContain('reduce');
  });

  it('advise blocks when iron status is stale (iron-first guardrail)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: win({ lastIronPanelAt: '2026-01-01T00:00:00Z' }) });
    const rec = res.json().recommendation;
    expect(rec.guardrails.flags).toContain('iron-not-checked-quarterly');
    expect(rec.guardrails.blocked).toBe(true);
    expect(rec.direction).toBe('blocked');
    expect(rec.recommendedDose).toBeNull();
    expect(rec.guardrails.blockReason).toMatch(/iron/i);
  });

  it('advise blocks on a microcytic picture (MCV < 80 → replete iron/B12 first)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: win({ mcv: 74 }) });
    const rec = res.json().recommendation;
    expect(rec.guardrails.flags).toContain('microcytic-iron-first');
    expect(rec.guardrails.blocked).toBe(true);
    expect(rec.recommendedDose).toBeNull();
  });

  it('advise validates required inputs (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/advise', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('demo seeds durable anemia episodes WITHOUT flipping the provider lens', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/demo', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seeded).toBe(true);
    expect(body.lens).toBe('provider');
    expect(body.opened.length).toBe(1); // patient:p-esa-1 → AwaitingApproval (Class C)
    expect(body.closed.length).toBe(1); // patient:p-esa-2 → full closed loop Resolved

    // Lens is NOT flipped to payer (unlike the payer demo).
    const ctx = await app.inject({ method: 'GET', url: '/api/context' });
    expect(ctx.json().pack.lens).not.toBe('payer');

    const state = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/state', headers: { cookie: cookie(admin) } });
    expect(state.json().source).toBe('anemia');
    expect(state.json().episodes.some((e: { kind: string; state: string }) => e.kind === 'anemia.esa-response' && e.state === 'AwaitingApproval')).toBe(true);
    expect(state.json().episodes.some((e: { kind: string; state: string }) => e.kind === 'anemia.esa-response' && e.state === 'Resolved')).toBe(true);
    // The AwaitingApproval episode's proposal carries the Class-C dose recommendation + advisor payload.
    const openEp = state.json().episodes.find((e: { state: string }) => e.state === 'AwaitingApproval');
    expect(openEp.proposal.approvalClass).toBe('C');
    expect(openEp.proposal.payload.advisor.model.kind).toBe('reference-surrogate');
    expect(typeof openEp.proposal.payload.advisor.recommendedDose).toBe('number');
  });

  it('anemia episodes appear in My Work (/api/work) as role-scoped decisions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.some((i: { title: string }) => i.title.includes('anemia esa response · patient:p-esa-1'))).toBe(true);
  });

  it('demo is idempotent — re-seeding does not churn episodes', async () => {
    const first = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/state', headers: { cookie: cookie(admin) } });
    const countBefore = first.json().episodes.length;
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/demo', headers: { cookie: cookie(admin) }, payload: {} });
    expect(res.json().opened.length).toBe(0);
    expect(res.json().existing.length).toBeGreaterThan(0);
    const after = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/state', headers: { cookie: cookie(admin) } });
    expect(after.json().episodes.length).toBe(countBefore);
  });

  it('reset removes ONLY anemia episodes (targeted)', async () => {
    const ep = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) }, payload: { kind: 'continuity', subject: 'pt-reset', scopeType: 'patient' } });
    expect(ep.statusCode).toBe(200);

    const reset = await app.inject({ method: 'POST', url: '/admin/swarm/anemia/reset', headers: { cookie: cookie(admin) }, payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().removed).toBeGreaterThanOrEqual(2);

    const state = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/state', headers: { cookie: cookie(admin) } });
    expect(state.json().episodes.length).toBe(0);

    const episodes = await app.inject({ method: 'GET', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) } });
    expect(episodes.json().episodes.some((e: { kind: string }) => e.kind === 'continuity')).toBe(true);

    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } });
    expect(work.json().items.some((i: { title: string }) => i.title.includes('anemia esa response'))).toBe(false);
  });

  it('unauth /admin/swarm/anemia/* is blocked (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/anemia/cells' });
    expect(res.statusCode).toBe(401);
  });
});
