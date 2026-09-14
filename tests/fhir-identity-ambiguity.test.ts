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
 * protected by copyright law, patent law, trade secret law, and international
 * intellectual property treaties.
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

// F3 · an ambiguous inbound identity becomes WORK.
//
// The identity engine already refused an ambiguous patient — `blocksWrite: true`
// — and that refusal is the safe half. The unsafe half was that the refusal was
// invisible: the same encounter was refused forever, no human was ever asked
// which patient it was, and a wrong-patient risk sat in a log line.
//
// The lesson this file encodes (borrowed deliberately from cohort-wiring): assert
// on the COMPOSITION, not only on the engine. A unit test proving "ambiguous is
// reported" would have stayed green while the console showed nothing to act on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { RealmRegistry } from '../src/realm/index.js';
import { serializeEntity } from '../src/fhir/mapping.js';
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

const REALM = 'realm:identity-ambiguity';

/**
 * Two chart patients the matcher must refuse to choose between.
 *
 * `name` is stored given-first, because that is how every reader parses the one
 * denormalised string (see the inbound structural map).
 */
const TWINS = [
  { id: 'twin-a', name: 'Nguyen Kim', birthDate: '1970-01-01', sex: 'female' },
  { id: 'twin-b', name: 'Nguyen Kim', birthDate: '1970-01-01', sex: 'female' },
];

/** An inbound patient that resembles BOTH, and carries no identifier of its own. */
const inbound = (id: string) => ({
  resourceType: 'Patient',
  id,
  name: [{ family: 'Kim', given: ['Nguyen'] }],
  birthDate: '1970-01-01',
  gender: 'female',
});

describe('F3 · an ambiguous inbound patient is refused AND given an owner', () => {
  let app: App;
  let cookie: string;

  beforeAll(async () => {
    app = await build();
    cookie = await login(app);
    const realm = await app.inject({
      method: 'POST', url: '/admin/realms', headers: { cookie },
      payload: {
        id: REALM, mode: 'sim',
        seed: { facilityId: 'fac-amb', kind: 'dialysis', name: 'Ambiguity Unit', units: ['u-1'], patientCount: 0 },
      },
    });
    expect([200, 201]).toContain(realm.statusCode);
    const r = RealmRegistry.get(REALM);
    if (!r) throw new Error('the realm was created through the API but is not registered');
    for (const twin of TWINS) r.graph.create('patient', twin.id, { ...twin });
  });

  afterAll(() => { RealmRegistry.remove?.(REALM); });

  const resolve = (patientId: string) => app.inject({
    method: 'POST', url: '/admin/fhir/identity/resolve',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { realmId: REALM, patient: inbound(patientId) },
  });

  const queue = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie } });
    return (res.json() as { items: Array<{ id: string; kind: string; actions: string[]; urgency: string }> }).items;
  };

  it('turns an unresolvable-which-patient into a queue item a human can act on', async () => {
    const res = await resolve('emr-amb-1');
    expect(res.statusCode).toBe(200);
    const resolution = res.json() as { status: string; writesBlocked: boolean; candidates: unknown[] };
    // The refusal is unchanged, and it is still the reason no write happened.
    expect(resolution.status).toBe('ambiguous');
    expect(resolution.writesBlocked).toBe(true);
    expect(resolution.candidates.length).toBe(2);

    const items = await queue();
    const item = items.find((i) => i.kind === 'identity');
    expect(item).toBeDefined();
    // A wrong-patient write is the highest-consequence error here, so it must not
    // be buried under low-urgency work.
    expect(item!.urgency).toBe('high');
    expect(item!.actions).toEqual(['link', 'dismiss']);

    // Re-running the same feed is ONE item, not one per run.
    await resolve('emr-amb-1');
    expect((await queue()).filter((i) => i.kind === 'identity')).toHaveLength(1);
  });

  it('explains the question and offers each answer, without pretending to act on the patient', async () => {
    const item = (await queue()).find((i) => i.kind === 'identity')!;
    const detail = await app.inject({ method: 'GET', url: `/api/work/${item.id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    const d = (detail.json() as {
      detail: {
        kind: string;
        why: string;
        policy: { actsOnPatient: boolean; mayNever: string[] };
        overview: { candidateCount: number; candidates: Array<{ localPatientId: string }>; incoming: { birthDate?: string } };
        decision: { allowed: string[]; reasonRequiredFor: string[] };
      };
    }).detail;

    expect(d.kind).toBe('identity');
    expect(d.overview.candidateCount).toBe(2);
    expect(d.overview.candidates.map((c) => c.localPatientId).sort()).toEqual(['twin-a', 'twin-b']);
    // What arrived, so the human compares rather than guesses.
    expect(d.overview.incoming.birthDate).toBe('1970-01-01');
    // Answering resolves a LABEL. It must never claim to touch care.
    expect(d.policy.actsOnPatient).toBe(false);
    expect(d.policy.mayNever).toContain('write to the chart');
    expect(d.decision.reasonRequiredFor).toEqual(['dismiss']);
  });

  it('resolves the ambiguity to a chosen candidate, and does not ask again', async () => {
    const item = (await queue()).find((i) => i.kind === 'identity')!;

    // A patient id nobody offered is refused: a typo must never become a
    // wrong-patient cross-reference, because a link is what lets a write through.
    const typo = await app.inject({
      method: 'POST', url: `/api/work/${item.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'link', localPatientId: 'twin-a-typo' },
    });
    expect(typo.statusCode).toBe(400);
    expect((typo.json() as { error: string }).error).toBe('not-a-candidate');

    const linked = await app.inject({
      method: 'POST', url: `/api/work/${item.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'link', localPatientId: 'twin-a', idempotencyKey: 'identity-link-1' },
    });
    expect(linked.statusCode).toBe(200);
    const body = linked.json() as { state: string; verified: boolean; localPatientId: string };
    expect(body.state).toBe('linked');
    expect(body.localPatientId).toBe('twin-a');
    // A human chose this, so the link is verified — not an inference.
    expect(body.verified).toBe(true);

    // It went through the ONE link path, so the cross-reference is real evidence.
    const links = await app.inject({ method: 'GET', url: `/admin/fhir/identity/links/${REALM}`, headers: { cookie } });
    const stored = (links.json() as { links: Array<{ localPatientId: string; verified: boolean }> }).links;
    expect(stored.some((l) => l.localPatientId === 'twin-a' && l.verified)).toBe(true);

    // Decided work leaves the queue...
    expect((await queue()).filter((i) => i.kind === 'identity')).toHaveLength(0);

    // ...and a later encounter does NOT reopen it. Re-raising a decision a human
    // already made would revert their answer and ask the same question forever.
    const again = await resolve('emr-amb-1');
    expect((again.json() as { status: string }).status).toBe('ambiguous');
    expect((await queue()).filter((i) => i.kind === 'identity')).toHaveLength(0);
  });

  it('a dismissal is a claim about two humans, so it has to carry why', async () => {
    await resolve('emr-amb-2');
    const item = (await queue()).find((i) => i.kind === 'identity')!;

    const bare = await app.inject({
      method: 'POST', url: `/api/work/${item.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'dismiss' },
    });
    expect(bare.statusCode).toBe(400);
    expect((bare.json() as { error: string }).error).toBe('dismiss-requires-reason');

    const dismissed = await app.inject({
      method: 'POST', url: `/api/work/${item.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'dismiss', reason: 'different person: verified against the paper chart', idempotencyKey: 'identity-dismiss-1' },
    });
    expect(dismissed.statusCode).toBe(200);
    expect((dismissed.json() as { state: string }).state).toBe('dismissed');
    expect((await queue()).filter((i) => i.kind === 'identity')).toHaveLength(0);
  });

  it('refuses an action it does not understand rather than accepting a near-miss', async () => {
    await resolve('emr-amb-3');
    const item = (await queue()).find((i) => i.kind === 'identity')!;
    const res = await app.inject({
      method: 'POST', url: `/api/work/${item.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { action: 'merge' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { allowed: string[] }).allowed).toEqual(['link', 'dismiss']);
  });

  /**
   * The population is only as good as what ingestion put there.
   *
   * An ingested name is stored as ONE string, and every reader splits it as
   * "given family". Storing it family-first made the write and the reads disagree,
   * which is invisible until a real EMR patient meets a real chart patient: it
   * went back out with family and given swapped, and it matched NOTHING, so every
   * re-encounter read as unresolved. This pins both halves against real ingest.
   */
  it('keeps an ingested patient name matchable and round-trips it faithfully', async () => {
    const bundle = {
      resourceType: 'Bundle', type: 'transaction',
      entry: [{
        resource: {
          resourceType: 'Patient', id: 'ingested-1',
          name: [{ family: 'Doe', given: ['Jane'] }],
          birthDate: '1968-04-12', gender: 'female',
          identifier: [{ system: 'urn:mrn', value: 'MRN-INGESTED-1' }],
        },
      }],
    };
    const ingested = await app.inject({
      method: 'POST', url: '/admin/fhir/ingest',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { realmId: REALM, bundle },
    });
    expect(ingested.statusCode).toBe(200);

    // (a) the engine can see it: a matching inbound patient RESOLVES, rather than
    //     falling through to unresolved because the name was stored swapped.
    const res = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/resolve',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        realmId: REALM,
        patient: {
          resourceType: 'Patient', id: 'emr-doe-1',
          name: [{ family: 'Doe', given: ['Jane'] }],
          birthDate: '1968-04-12', gender: 'female',
          identifier: [{ system: 'urn:other-emr', value: 'X-1' }],
        },
      },
    });
    const resolution = res.json() as { status: string; localPatientId?: string };
    expect(resolution.status).toBe('resolved');
    expect(resolution.localPatientId).toBe('ingested-1');

    // (b) and it goes back out with family and given the way the EMR sent them.
    const realm = RealmRegistry.get(REALM)!;
    const patient = realm.graph.listKind('patient').find((p) => p.id === 'ingested-1')!;
    const [outbound] = serializeEntity(patient, { realmId: REALM, facilityId: 'fac-amb', scopeId: REALM, sourceId: 'test', ingestedAt: '2026-01-01T00:00:00.000Z' });
    const name = (outbound as { name?: Array<{ family?: string; given?: string[] }> }).name?.[0];
    expect(name?.family).toBe('Doe');
    expect(name?.given).toEqual(['Jane']);
  });
});
