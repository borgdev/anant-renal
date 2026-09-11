/******************************************************************************
 * Living cohorts — wiring: a definition the operator authored must actually
 * reach the ONE work queue, on the default patient source.
 *
 * This file exists because of a real defect. `renalPatients` was an optional app
 * dependency that only the unit tests supplied, so at runtime the cohort layer
 * evaluated nothing, its suggestions never appeared, and NOTHING errored — the
 * endpoint stayed green and simply returned fewer items. The unit tests passed
 * throughout, because they injected the very dependency production was missing.
 *
 * The lesson encoded here: assert on the composition, not only on the engine.
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
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = {
  actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi',
  purposeOfUse: 'operations',
} as ActorContext;

type App = Awaited<ReturnType<typeof buildApp>>;

async function build(): Promise<App> {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
    // NOTE: `renalPatients` is deliberately NOT passed. The whole point is that
    // the surface must still receive patients — from the realm registry.
  });
}

async function login(app: App): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { username: 'admin', password: 'admin123' },
  });
  const raw = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return `hh_session=${token}`;
}

describe('living cohorts reach the queue on the default patient source', () => {
  let app: App;
  let cookie: string;

  beforeAll(async () => {
    app = await build();
    cookie = await login(app);
    // a realm WITH patients, created the way an operator would
    const realm = await app.inject({
      method: 'POST', url: '/admin/realms', headers: { cookie },
      payload: {
        id: 'realm:cohort-wiring', mode: 'sim',
        seed: {
          facilityId: 'fac-wiring', kind: 'dialysis', name: 'Wiring Unit',
          units: ['u-1'], patientCount: 12,
        },
      },
    });
    expect([200, 201]).toContain(realm.statusCode);
  }, 120_000);

  afterAll(async () => { await app?.close(); });

  it('evaluates the realm patients without the caller supplying a patient source', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/cohorts/evaluate',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { persist: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cohorts: Array<{ cohortId: string; evaluated: number }> };
    expect(body.cohorts.length).toBeGreaterThan(0);
    // EVERY seeded cohort sees the realm's patients — a zero here means the
    // default source is missing again, which is exactly the defect above.
    for (const state of body.cohorts) expect(state.evaluated).toBeGreaterThan(0);
  }, 120_000);

  it('surfaces cohort suggestions in the ONE work queue, shaped like every other item', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<Record<string, unknown> & { kind: string; capability?: string; actions?: string[] }>;
    };
    // the queue is a single stream: it must not be empty, and every item must
    // carry the same contract regardless of kind
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.urgency).toBe('string');
      expect(typeof item.owner).toBe('string');
    }
  }, 120_000);

  it('a cohort definition authored through the API becomes a queue item', async () => {
    // deliberately broad so it matches the seeded fleet: every patient qualifies
    const define = await app.inject({
      method: 'POST', url: '/admin/cohorts', headers: { cookie, 'content-type': 'application/json' },
      payload: {
        id: 'wiring-probe',
        label: 'Wiring probe cohort',
        kind: 'suggested',
        protocol: 'cross',
        rationale: 'proves an authored definition reaches the work queue',
        entry: [{ metric: 'age.years', comparator: 'gte', value: 0 }],
        exit: [{ metric: 'age.years', comparator: 'lt', value: 0 }],
        suggestedAction: 'Review the plan of care',
        approvalClass: 'B',
        mayNever: ['amend a prescription'],
        guard: ['clinician review'],
        minN: 1,
        criterionVersion: '1.0.0',
        owner: 'test',
        enabled: true,
      },
    });
    expect([200, 201]).toContain(define.statusCode);

    const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    const body = res.json() as { items: Array<{ id: string; kind: string; capability?: string; actions?: string[]; summary?: string }> };
    const coherent = body.items.filter((i) => i.id.startsWith('cohort:wiring-probe:'));
    expect(coherent.length).toBeGreaterThan(0);

    const first = coherent[0]!;
    expect(first.kind).toBe('cohort');
    expect(first.capability).toBe('cohort.review');
    // suggestions are decided by a human, never executed
    expect(first.actions).toEqual(['review', 'decline']);
    // the summary carries WHY, which is the whole product claim of a cohort
    expect(first.summary).toMatch(/age\.years/);

    await app.inject({ method: 'DELETE', url: '/admin/cohorts/wiring-probe', headers: { cookie } });
  }, 120_000);

  it('a cohort suggestion carries its reason and can never act on the patient', async () => {
    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    const items = (work.json() as { items: Array<{ id: string; kind: string }> }).items;
    const item = items.find((i) => i.kind === 'cohort');
    expect(item).toBeDefined();

    const res = await app.inject({ method: 'GET', url: `/api/work/${item!.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const detail = (res.json() as { detail: Record<string, unknown> }).detail;

    // the reason is the suggestion's entire justification, so it must be present
    expect(typeof detail.why).toBe('string');
    expect(String(detail.why).length).toBeGreaterThan(0);

    // the allowed actions are the whole contract: a human reviews or declines.
    // acting on a patient stays a separate proposal -> approval -> episode.
    expect(detail.decision).toEqual({ allowed: ['review', 'decline'], reasonRequiredFor: ['decline'] });
    expect(detail.execution).toBeNull();
    expect((detail.overview as Record<string, unknown>).entryCriteria).toBeDefined();

    // an action the design does not permit is refused rather than ignored
    const forbidden = await app.inject({
      method: 'POST', url: `/api/work/${item!.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'approve' },
    });
    expect(forbidden.statusCode).toBe(400);
  }, 120_000);

  it('a decline requires a reason and is retained against the criterion version', async () => {
    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    const items = (work.json() as { items: Array<{ id: string; kind: string }> }).items;
    const item = items.find((i) => i.kind === 'cohort');
    expect(item).toBeDefined();

    // a decline with no reason is unusable as feedback, so it is refused
    const bare = await app.inject({
      method: 'POST', url: `/api/work/${item!.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'decline' },
    });
    expect(bare.statusCode).toBe(400);

    const declined = await app.inject({
      method: 'POST', url: `/api/work/${item!.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'decline', reason: 'catheter is tunnelled and clinically essential', idempotencyKey: 'wiring-decline-1' },
    });
    expect(declined.statusCode).toBe(200);
    const body = declined.json() as { criterionVersion: string; decisionId: string };
    // the criterion version is what makes a decline tunable rather than noise
    expect(body.criterionVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.decisionId).toBeTruthy();

    // replaying the same intent is one decision, not two
    const replay = await app.inject({
      method: 'POST', url: `/api/work/${item!.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'decline', reason: 'catheter is tunnelled and clinically essential', idempotencyKey: 'wiring-decline-1' },
    });
    expect((replay.json() as { duplicate?: boolean }).duplicate).toBe(true);

    // and it shows up as history on the item itself
    const detail = await app.inject({ method: 'GET', url: `/api/work/${item!.id}`, headers: { cookie } });
    const activity = ((detail.json() as { detail: { activity: Array<{ to: string }> } }).detail.activity);
    expect(activity.some((a) => a.to === 'declined')).toBe(true);
  }, 120_000);

  it('a declined suggestion stays declined until its criteria change', async () => {
    // a cohort every patient satisfies, so the queue item is deterministic
    const base = {
      id: 'decline-probe', label: 'Decline probe', kind: 'suggested', protocol: 'cross',
      rationale: 'proves a decline sticks', entry: [{ metric: 'age.years', comparator: 'gte', value: 0 }],
      exit: [{ metric: 'age.years', comparator: 'lt', value: 0 }],
      suggestedAction: 'Review the plan of care', approvalClass: 'B',
      mayNever: ['amend a prescription'], guard: ['clinician review'], minN: 1,
      criterionVersion: '1.0.0', owner: 'test', enabled: true,
    };
    await app.inject({ method: 'POST', url: '/admin/cohorts', headers: { cookie, 'content-type': 'application/json' }, payload: base });

    const queued = async (): Promise<string[]> => {
      const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
      return (res.json() as { items: Array<{ id: string }> }).items
        .map((i) => i.id).filter((id) => id.startsWith('cohort:decline-probe:'));
    };
    const before = await queued();
    expect(before.length).toBeGreaterThan(0);

    const declined = await app.inject({
      method: 'POST', url: `/api/work/${before[0]}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'decline', reason: 'criterion too broad for this unit', idempotencyKey: 'decline-probe-1' },
    });
    expect(declined.statusCode).toBe(200);

    // the nurse must not see the same suggestion come back on the next poll
    const after = await queued();
    expect(after).not.toContain(before[0]);

    // but a NEW criterion has not been judged, so bumping the version re-opens it
    const bumped = await app.inject({
      method: 'PUT', url: '/admin/cohorts/decline-probe',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { ...base, criterionVersion: '1.1.0', entry: [{ metric: 'age.years', comparator: 'gte', value: 18 }] },
    });
    expect(bumped.statusCode).toBe(200);
    expect(await queued()).toContain(before[0]);

    await app.inject({ method: 'DELETE', url: '/admin/cohorts/decline-probe', headers: { cookie } });
  }, 120_000);

  it('a disabled definition stops producing queue items', async () => {
    // PUT is a full replace, not a patch: a cohort's criteria are a versioned
    // unit, so it is replaced whole and attributed by criterionVersion.
    const current = await app.inject({ method: 'GET', url: '/admin/cohorts/infection-risk-catheter', headers: { cookie } });
    expect(current.statusCode).toBe(200);
    const def = (current.json() as { cohort: Record<string, unknown> }).cohort;

    const off = await app.inject({
      method: 'PUT', url: '/admin/cohorts/infection-risk-catheter',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { ...def, enabled: false },
    });
    expect(off.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    const body = after.json() as { items: Array<{ id: string }> };
    expect(body.items.filter((i) => i.id.startsWith('cohort:infection-risk-catheter:'))).toHaveLength(0);

    // restore so the catalog is left as found
    const on = await app.inject({
      method: 'PUT', url: '/admin/cohorts/infection-risk-catheter',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { ...def, enabled: true },
    });
    expect(on.statusCode).toBe(200);
  }, 120_000);
});
