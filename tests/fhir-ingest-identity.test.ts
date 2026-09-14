/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// F3, the ingest half — the guardrail was real code that no feed went through.
//
// `identitySnapshotFor` had exactly ONE caller: `/admin/fhir/identity/resolve`,
// which writes nothing. Every WRITE path still keyed an inbound Patient by its
// remote id, so an EMR patient whose MRN matched an existing chart created a
// SECOND chart for the same human. The engine was right; nothing called it.
//
// This file asserts the COMPOSITION rather than the engine (the lesson the
// cohort-wiring work taught): it drives the real routes and then looks at the
// CHART, because "the matcher returns unresolved" would stay green while a
// duplicate chart appeared.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { RealmRegistry } from '../src/realm/index.js';
import { shouldResolveIdentity } from '../src/fhir/routes.js';
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

/** A realm hydrated by a configured EMR feed. */
const BOUND = 'realm:feed-bound';
/** A realm with NO bound connection — a same-system replay. */
const UNBOUND = 'realm:feed-unbound';
/** Twinned charts, for the ambiguous case. */
const TWINS = 'realm:feed-twins';

/** The chart patient. `mrn` is what the inbound Patient will claim. */
const CHART_PATIENT = { id: 'chart-1', name: 'Jane Doe', birthDate: '1960-02-02', sex: 'female', mrn: 'MRN-1' };
/** A second chart patient the inbound stranger must not be confused with. */
const OTHER_PATIENT = { id: 'chart-2', name: 'Ade Okoro', birthDate: '1975-07-07', sex: 'male', mrn: 'MRN-2' };

/** The EMR's own Patient, claiming the SAME MRN as the chart patient. */
const INBOUND_SAME_MRN = {
  resourceType: 'Patient',
  id: 'emr-patient-9',
  identifier: [{ system: 'urn:mrn', value: 'MRN-1' }],
  name: [{ family: 'Doe', given: ['Jane'] }],
  birthDate: '1960-02-02',
  gender: 'female',
};

/** Nobody in the chart looks like this. */
const INBOUND_STRANGER = {
  resourceType: 'Patient',
  id: 'emr-patient-stranger',
  identifier: [{ system: 'urn:mrn', value: 'MRN-NOBODY' }],
  name: [{ family: 'Zzzznobody', given: ['Nobody'] }],
  birthDate: '1999-12-31',
  gender: 'male',
};

/** Resembles BOTH twins and carries no identifier of its own. */
const INBOUND_TWIN = {
  resourceType: 'Patient',
  id: 'emr-patient-twin',
  name: [{ family: 'Kim', given: ['Nguyen'] }],
  birthDate: '1970-01-01',
  gender: 'female',
};

describe('F3 · an inbound feed cannot create a second chart', () => {
  let app: App;
  let cookie: string;
  let bundleSeq = 0;

  const createRealm = async (id: string, facilityId: string) => {
    const res = await app.inject({
      method: 'POST', url: '/admin/realms', headers: { cookie },
      payload: {
        id, mode: 'sim',
        seed: { facilityId, kind: 'dialysis', name: 'Feed Unit', units: ['u-1'], patientCount: 0 },
      },
    });
    expect([200, 201]).toContain(res.statusCode);
    return RealmRegistry.get(id)!;
  };

  /** Put a patient on the chart directly — this is the pre-existing chart. */
  const chart = (realmId: string, patient: Record<string, unknown>) => {
    RealmRegistry.get(realmId)!.graph.create('patient', String(patient.id), { ...patient });
  };

  const configure = (payload: Record<string, unknown>) => app.inject({
    method: 'PUT', url: '/admin/platform/integrations/fhir',
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });

  const ingest = (realmId: string, resource: unknown, type: 'collection' | 'transaction' = 'transaction') => app.inject({
    method: 'POST', url: '/admin/fhir/ingest',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {
      realmId,
      // A distinct bundle.id per call: the ledger replays an identical id, and a
      // replayed bundle would make a second ingest a no-op rather than a test.
      bundle: { resourceType: 'Bundle', id: `b-${++bundleSeq}`, type, entry: [{ resource }] },
    },
  });

  const patientIds = (realmId: string) =>
    RealmRegistry.get(realmId)!.graph.listKind('patient').map((p) => p.id).sort();

  beforeAll(async () => {
    app = await build();
    cookie = await login(app);

    const bound = await createRealm(BOUND, 'fac-bound');
    chart(BOUND, CHART_PATIENT);
    chart(BOUND, OTHER_PATIENT);

    await createRealm(UNBOUND, 'fac-unbound');
    chart(UNBOUND, CHART_PATIENT);

    const twins = await createRealm(TWINS, 'fac-twins');
    twins.graph.create('patient', 'twin-a', { id: 'twin-a', name: 'Nguyen Kim', birthDate: '1970-01-01', sex: 'female' });
    twins.graph.create('patient', 'twin-b', { id: 'twin-b', name: 'Nguyen Kim', birthDate: '1970-01-01', sex: 'female' });
  });

  afterAll(() => {
    for (const id of [BOUND, UNBOUND, TWINS]) RealmRegistry.remove?.(id);
  });

  it('reuses the chart patient whose MRN arrived, instead of starting a second one', async () => {
    await configure({ realmId: BOUND, identityMode: 'resolve' });

    const res = await ingest(BOUND, INBOUND_SAME_MRN);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rolledBack: boolean; summary: { structuralUpserts: number } };
    expect(body.rolledBack).toBe(false);
    expect(body.summary.structuralUpserts).toBe(1);

    // THE assertion: the remote id did NOT become a patient.
    expect(patientIds(BOUND)).toEqual([CHART_PATIENT.id, OTHER_PATIENT.id]);
    expect(RealmRegistry.get(BOUND)!.graph.get(`urn:realm:${BOUND}:patient:emr-patient-9`)).toBeUndefined();
  });

  it('refuses an entry whose patient cannot be identified, and rolls the bundle back', async () => {
    await configure({ realmId: BOUND, identityMode: 'resolve' });

    const res = await ingest(BOUND, INBOUND_STRANGER);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rolledBack: boolean;
      entries: Array<{ status: number; outcome?: { issue?: Array<{ diagnostics?: string }> } }>;
      summary: { structuralUpserts: number; skipped: string[] };
    };

    // A refused identity is a FAILED entry, not a quiet skip — a silently
    // dropped patient is a bundle that looks applied and is not.
    expect(body.summary.structuralUpserts).toBe(0);
    expect(body.rolledBack).toBe(true);
    expect(body.entries[0]!.status).toBeGreaterThanOrEqual(400);

    expect(patientIds(BOUND)).toEqual([CHART_PATIENT.id, OTHER_PATIENT.id]);
  });

  it('turns an ambiguous inbound patient into refused work with an owner', async () => {
    await configure({ realmId: TWINS, identityMode: 'resolve' });

    const res = await ingest(TWINS, INBOUND_TWIN);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { rolledBack: boolean }).rolledBack).toBe(true);
    expect(patientIds(TWINS)).toEqual(['twin-a', 'twin-b']);

    // Refusing the write is the safe half. Without the work item the same
    // encounter is refused forever and no human is ever asked which it was.
    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    const items = (work.json() as { items: Array<{ id: string; kind: string; urgency: string; summary: string }> }).items;
    const identity = items.filter((i) => i.kind === 'identity');
    expect(identity.length).toBeGreaterThanOrEqual(1);
    expect(identity[0]!.urgency).toBe('high');
    expect(identity[0]!.summary).toContain('possible chart matches');

    // The row must say WHICH patient arrived, or the human is comparing two
    // names against nothing.
    const detail = await app.inject({
      method: 'GET', url: `/api/work/${identity[0]!.id}`, headers: { cookie },
    });
    const overview = (detail.json() as {
      detail: { overview: { candidateCount: number; incoming: { birthDate?: string; family?: string } } };
    }).detail.overview;
    expect(overview.candidateCount).toBe(2);
    expect(overview.incoming.birthDate).toBe('1970-01-01');
    expect(overview.incoming.family).toBe('Kim');
  });

  it('applies a human\'s answer to the NEXT encounter, so the queue can be cleared', async () => {
    // The half that makes the other half worth having. Refusing forever and
    // recording a decision nobody consults is two halves of a guardrail that
    // disagree: the reviewer clears the item, the feed is refused again, and
    // the same question comes back on every poll.
    await configure({ realmId: TWINS, identityMode: 'resolve' });

    const work = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    const items = (work.json() as { items: Array<{ id: string; kind: string; scope: string }> }).items;
    const item = items.find((i) => i.kind === 'identity' && i.scope === TWINS);
    expect(item, 'the ambiguous encounter must have left a queue entry').toBeTruthy();

    const decide = await app.inject({
      method: 'POST', url: `/api/work/${encodeURIComponent(item!.id)}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'link', localPatientId: 'twin-a', reason: 'confirmed against the paper chart' },
    });
    expect(decide.statusCode).toBe(200);
    expect((decide.json() as { state: string }).state).toBe('linked');

    // The SAME inbound patient, replayed. It carries no identifier of its own,
    // so the only thing that can identify it is the link the human just made —
    // which is exactly the thing that has to reach the resolver.
    const res = await ingest(TWINS, INBOUND_TWIN);
    const body = res.json() as { rolledBack: boolean };
    expect(body.rolledBack, 'a human answered; the write must no longer be refused').toBe(false);

    // It resolved to a chart patient rather than starting a third one.
    expect(patientIds(TWINS)).toEqual(['twin-a', 'twin-b']);
  });

  it('adopts the remote id when the feed DECLARES it is a same-system replay', async () => {
    await configure({ realmId: BOUND, identityMode: 'adopt-by-remote-id' });

    const res = await ingest(BOUND, INBOUND_SAME_MRN);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { summary: { structuralUpserts: number } }).summary.structuralUpserts).toBe(1);

    // The escape hatch works, and it is explicit: the operator asked for it.
    expect(patientIds(BOUND)).toEqual([CHART_PATIENT.id, OTHER_PATIENT.id, 'emr-patient-9']);
  });

  it('keeps the old behaviour for a realm with no bound connection', async () => {
    // The connection is bound to BOUND, so UNBOUND has no claim on it. This is
    // the replay realm every ingest fixture uses.
    const res = await ingest(UNBOUND, INBOUND_SAME_MRN);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { summary: { structuralUpserts: number } }).summary.structuralUpserts).toBe(1);
    expect(patientIds(UNBOUND)).toEqual([CHART_PATIENT.id, 'emr-patient-9']);
  });

  it('rejects an identity mode the console made up', async () => {
    const res = await configure({ realmId: BOUND, identityMode: 'trust-the-emr' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; allowed: string[] };
    expect(body.error).toBe('invalid-identity-mode');
    expect(body.allowed).toEqual(['resolve', 'adopt-by-remote-id']);
  });

  it('defaults to resolve, so a real feed opts INTO adopting a remote id', async () => {
    // The default IS the safety property, so it is asserted directly rather
    // than inferred: a default that adopts is the hazard itself.
    expect(shouldResolveIdentity({ realmId: BOUND }, BOUND)).toBe(true);
    expect(shouldResolveIdentity({ realmId: BOUND }, UNBOUND)).toBe(false);
    expect(shouldResolveIdentity({ realmId: BOUND, identityMode: 'resolve' }, BOUND)).toBe(true);
    expect(shouldResolveIdentity({ realmId: BOUND, identityMode: 'adopt-by-remote-id' }, BOUND)).toBe(false);

    // ...and the mode survives a round trip through the console API.
    await configure({ realmId: BOUND, identityMode: 'resolve' });
    const stored = (await app.inject({
      method: 'GET', url: '/admin/platform/integrations/fhir', headers: { cookie },
    })).json() as { integration: { identityMode?: string } };
    expect(stored.integration.identityMode).toBe('resolve');

    const res = await ingest(BOUND, INBOUND_STRANGER);
    expect((res.json() as { rolledBack: boolean }).rolledBack).toBe(true);
  });
});
