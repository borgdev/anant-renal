/******************************************************************************
 * DST-Q #1 — belief-aware My Work.
 *
 * Unit coverage for the D-S work-queue readout (`src/swarm/work-dst.ts`) plus
 * a route-level check that /api/work attaches a grounded Bel/Pl/K readout to
 * evidence-driven episode items and orders the queue by belief-aware priority.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import type { OutcomeEpisode } from '../src/swarm/outcome-episode.js';
import {
  episodeDstReadout,
  compareDstQueue,
  DST_WORK_OPTIMISM,
  DST_WORK_HARM_GAMMA,
  type EpisodeDstReadout,
  type DstQueueItem,
} from '../src/swarm/work-dst.js';

/* ---------- fixtures ---------- */

function episode(overrides: Partial<OutcomeEpisode>): OutcomeEpisode {
  return {
    episodeId: `out-test-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'continuity',
    subject: 'pt-x',
    scopeType: 'patient',
    state: 'AwaitingApproval',
    openedAt: '2026-08-26T09:00:00.000Z',
    transitions: [],
    evidence: [],
    dossierHash: 'fixture',
    ...overrides,
  } as OutcomeEpisode;
}

function fakeFusion(fields: { belief: number; plausibility: number; conflictMass: number }) {
  return {
    belief: fields.belief,
    plausibility: fields.plausibility,
    uncertainty: Math.max(0, fields.plausibility - fields.belief),
    conflictMass: fields.conflictMass,
    massVector: {},
    sources: [],
  } as OutcomeEpisode['evidenceFusion'];
}

/* ---------- unit: episodeDstReadout ---------- */

describe('episodeDstReadout (DST-Q #1)', () => {
  it('returns undefined for an episode with no evidence', () => {
    expect(episodeDstReadout(episode({ evidence: [] }))).toBeUndefined();
  });

  it('reads out a weak belief interval for a single synthetic signal', () => {
    const out = episodeDstReadout(episode({
      evidence: [{ sourceId: 'sim:scripted-events', contentType: 'signal', ref: 'r1' }],
    }));
    expect(out).toBeDefined();
    const r = out as EpisodeDstReadout;
    expect(r.belief).toBeLessThan(r.plausibility);
    expect(r.belief).toBeLessThan(0.55); // never corroborated from one sim signal
    expect(r.evidenceStatus).toBe('weak');
    expect(r.conflictMass).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('ranks corroborated realm-ledger evidence above a single weak source', () => {
    const corroborated = episode({
      evidence: [
        { sourceId: 'realm-ledger:fac-1', contentType: 'fact', ref: 'r1' },
        { sourceId: 'realm-ledger:fac-1', contentType: 'fact', ref: 'r2' },
        { sourceId: 'realm-ledger:fac-2', contentType: 'fact', ref: 'r3' },
      ],
    });
    const weak = episode({
      evidence: [{ sourceId: 'sim:scripted-events', contentType: 'signal', ref: 'r1' }],
    });
    const strong = episodeDstReadout(corroborated) as EpisodeDstReadout;
    const faint = episodeDstReadout(weak) as EpisodeDstReadout;
    expect(strong.belief).toBeGreaterThan(faint.belief);
    expect(strong.belief).toBeGreaterThan(0.55); // corroborated posture
    expect(strong.evidenceStatus).toBe('corroborated');
    expect(strong.score).toBeGreaterThan(faint.score);
    expect(strong.belief).toBeLessThanOrEqual(strong.plausibility);
  });

  it('honours a stored contested fusion (high K) and discounts its score', () => {
    const contestedFusion = fakeFusion({ belief: 0.5, plausibility: 0.9, conflictMass: 0.4 });
    const calmFusion = fakeFusion({ belief: 0.8, plausibility: 0.85, conflictMass: 0.05 });
    const hot = episode({ evidence: [], evidenceFusion: contestedFusion });
    const calm = episode({ evidence: [], evidenceFusion: calmFusion });
    const hotOut = episodeDstReadout(hot) as EpisodeDstReadout;
    const calmOut = episodeDstReadout(calm) as EpisodeDstReadout;
    expect(hotOut.evidenceStatus).toBe('contested');
    expect(calmOut.evidenceStatus).toBe('corroborated');
    // High conflict raises Pl(harm) and must drag the decision priority down.
    expect(hotOut.score).toBeLessThan(calmOut.score);
    // The score is exactly the documented decision rule: Bel + λ·unc − γ·Pl(harm),
    // where Pl(harm) for a corroborated episode is 0.1 + 0.5·unc.
    const plHarm = 0.1 + calmOut.uncertainty * 0.5;
    const expected = Math.max(0, Math.min(1, calmOut.belief + DST_WORK_OPTIMISM * calmOut.uncertainty - DST_WORK_HARM_GAMMA * plHarm));
    expect(Math.abs(calmOut.score - expected)).toBeLessThan(0.001);
  });
});

/* ---------- unit: compareDstQueue ---------- */

describe('compareDstQueue (DST-Q #1 ordering)', () => {
  const item = (u: DstQueueItem['urgency'], p: number | undefined, at: string): DstQueueItem => ({ urgency: u, at, ...(p !== undefined ? { dstPriority: p } : {}) });
  const sorted = (xs: DstQueueItem[]) => [...xs].sort(compareDstQueue);

  it('keeps urgency as the primary tier', () => {
    const list = sorted([
      item('medium', 0.9, 'a'),
      item('high', 0.1, 'b'),
      item('low', 1.0, 'c'),
    ]);
    expect(list.map((i) => i.urgency)).toEqual(['high', 'medium', 'low']);
  });

  it('places scored (belief-aware) items before unscored items within a tier', () => {
    const list = sorted([
      item('medium', undefined, 'older-unscored'),
      item('medium', 0.4, 'scored'),
    ]);
    expect(list[0]?.dstPriority).toBe(0.4);
  });

  it('orders scored items by descending D-S priority within a tier', () => {
    const list = sorted([
      item('medium', 0.2, 't1'),
      item('medium', 0.95, 't0'),
      item('medium', 0.55, 't2'),
    ]);
    expect(list.map((i) => i.dstPriority)).toEqual([0.95, 0.55, 0.2]);
  });

  it('falls back to recency for unscored and equal-priority items', () => {
    const list = sorted([
      item('medium', undefined, '2026-01-01T00:00:00.000Z'),
      item('medium', undefined, '2026-02-01T00:00:00.000Z'),
      item('medium', 0.5, '2026-03-01T00:00:00.000Z'),
    ]);
    expect(list.map((i) => i.at)).toEqual(['2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });
});

/* ---------- route: /api/work attaches D-S readout to episodes ---------- */

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
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const m = /hh_session=([^;]+)/.exec(raw);
  const token = m?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

describe('My Work D-S readout over /api/work', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('attaches a grounded Bel/Pl/K readout + priority to evidence-driven episodes', async () => {
    const opened = await app.inject({
      method: 'POST', url: '/admin/swarm/episodes', headers: { cookie: cookie(admin) },
      payload: { kind: 'continuity', subject: 'dst-pt-1', scopeType: 'patient' },
    });
    const epId = opened.json().episode?.episodeId ?? opened.json().episode?.id;
    expect(epId).toBeTruthy();
    // propose adds a signal evidence ref then moves the episode to AwaitingApproval.
    await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${epId}/propose`, headers: { cookie: cookie(admin) } });

    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(admin) } });
    expect(work.statusCode).toBe(200);
    const epItem = work.json().items.find((i: { id: string }) => i.id === `episode:${epId}`);
    expect(epItem).toBeTruthy();
    expect(typeof epItem.belief).toBe('number');
    expect(typeof epItem.plausibility).toBe('number');
    expect(typeof epItem.conflictMass).toBe('number');
    expect(epItem.dstPriority).toBeGreaterThanOrEqual(0);
    expect(epItem.dstPriority).toBeLessThanOrEqual(1);
    expect(epItem.belief).toBeLessThanOrEqual(epItem.plausibility);
    expect(epItem.evidenceStatus).toBe('weak'); // single auto-added signal → weak
  });
});
