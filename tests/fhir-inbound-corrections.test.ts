/*******************************************************************************
 * Copyright (c) 2026 Anant Health, Inc.
 *
 * This file is part of the Anant Health platform.
 *
 * Licensed under the Anant Health Enterprise License, Version 1.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://ananthealth.com/legal/enterprise-license
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License, and all other remedies available under applicable law.
 *
 ******************************************************************************/

/**
 * F3.5 — what an EMR says when it CHANGES ITS MIND.
 *
 * Two inbound statements are not clinical facts and must not be applied as if
 * they were:
 *
 *   * `Patient.link: replaced-by` — two of its records are one person, so the
 *     remote id we have been resolving now points at a chart the EMR has
 *     retired. Data that keeps flowing to the retired chart is a wrong-patient
 *     write.
 *   * `status: entered-in-error` — the sender is retracting a value. Applying
 *     the retracted resource as a fresh fact is how a withdrawn result becomes a
 *     live one.
 *
 * Both are ACKNOWLEDGED and recorded. Neither deletes anything: erasing the fact
 * that a wrong value was once sent is exactly what an audit needs to keep.
 *
 * Linkage is created through the real `/admin/fhir/identity/link` API rather than
 * by reaching into the store, so this exercises the same path an operator's
 * confirmation takes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { RealmRegistry } from '../src/realm/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const BOUND = 'realm:merge-bound';
const UNBOUND = 'realm:merge-unbound';

/** The chart the EMR still considers live. */
const SURVIVOR = {
  resourceType: 'Patient',
  id: 'emr-survivor',
  identifier: [{ system: 'urn:mrn', value: 'MRN-SURVIVOR' }],
  name: [{ family: 'Alvarez', given: ['Rosa'] }],
  birthDate: '1955-04-04',
  gender: 'female',
};

/** The chart the EMR has RETIRED — merged into the survivor. */
const RETIRED = {
  resourceType: 'Patient',
  id: 'emr-retired',
  identifier: [{ system: 'urn:mrn', value: 'MRN-RETIRED' }],
  name: [{ family: 'Alvarez', given: ['Rosa'] }],
  birthDate: '1955-04-04',
  gender: 'female',
  link: [{ type: 'replaced-by', other: { reference: 'Patient/emr-survivor' } }],
};

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
  expect(token, 'login must hand back a session cookie').toBeTruthy();
  return `hh_session=${token}`;
}

interface LinkRow {
  localPatientId: string;
  remoteSystem: string;
  remotePatientId: string;
  supersededBy?: string;
}

describe('F3.5 · an EMR that merges two records does not create a third', () => {
  let app: App;
  let cookie: string;
  let seq = 0;

  const createRealm = async (id: string, facilityId: string) => {
    const res = await app.inject({
      method: 'POST', url: '/admin/realms', headers: { cookie },
      payload: { id, mode: 'sim', seed: { facilityId, kind: 'dialysis', name: 'Merge Unit', units: ['u-1'], patientCount: 0 } },
    });
    expect([200, 201]).toContain(res.statusCode);
    return RealmRegistry.get(id)!;
  };

  const configure = (payload: Record<string, unknown>) => app.inject({
    method: 'PUT', url: '/admin/platform/integrations/fhir',
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });

  const ingest = (realmId: string, resources: unknown[]) => app.inject({
    method: 'POST', url: '/admin/fhir/ingest',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {
      realmId,
      bundle: {
        resourceType: 'Bundle', id: `m-${++seq}`, type: 'transaction',
        entry: resources.map((resource) => ({ resource })),
      },
    },
  });

  const patientIds = (realmId: string) =>
    RealmRegistry.get(realmId)!.graph.listKind('patient').map((p) => p.id).sort();

  /** Put a patient on the chart and record its claim on a remote id via the real API. */
  const chart = async (realmId: string, localId: string, remotePatientId: string) => {
    RealmRegistry.get(realmId)!.graph.create('patient', localId, {
      id: localId, name: 'Alvarez Rosa', birthDate: '1955-04-04', sex: 'female',
    });
    const res = await app.inject({
      method: 'POST', url: '/admin/fhir/identity/link',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { realmId, localPatientId: localId, remoteSystem: 'urn:mrn', remotePatientId, actor: 'test' },
    });
    expect(res.statusCode).toBe(200);
  };

  const liveLinks = async (realmId: string): Promise<LinkRow[]> => {
    const res = await app.inject({
      method: 'GET', url: `/admin/fhir/identity/links/${encodeURIComponent(realmId)}`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { links: LinkRow[] };
    return body.links.filter((l) => !l.supersededBy);
  };

  beforeAll(async () => {
    app = await build();
    cookie = await login(app);
    await createRealm(BOUND, 'fac-merge');
    await createRealm(UNBOUND, 'fac-merge-unbound');
    await configure({ realmId: BOUND, identityMode: 'resolve' });

    // Two charts, each with a claim on one of the EMR's two records.
    await chart(BOUND, 'chart-live', 'MRN-SURVIVOR');
    await chart(BOUND, 'chart-dead', 'MRN-RETIRED');
  });

  afterAll(() => {
    for (const id of [BOUND, UNBOUND]) RealmRegistry.remove?.(id);
  });

  it('re-points the retired record to the surviving chart, and creates no patient', async () => {
    // The shape a vendor actually sends: the retired record AND the record that
    // absorbed it, in one transaction.
    const res = await ingest(BOUND, [RETIRED, SURVIVOR]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { corrections: string[]; summary: { structuralUpserts: number } };

    // THE assertion: the retired record did not become a third chart. The
    // survivor in the same bundle re-affirms its OWN chart, which is correct —
    // so the invariant is the patient LIST, not a zero upsert count.
    expect(patientIds(BOUND)).toEqual(['chart-dead', 'chart-live']);

    // The merge is REPORTED, not silent.
    expect(body.corrections.some((c) => c.includes('emr-retired') && c.includes('merge'))).toBe(true);

    // The remote id the EMR retired now resolves to the chart that survived...
    const links = await liveLinks(BOUND);
    const retiredNow = links.filter((l) => l.remotePatientId === 'MRN-RETIRED');
    expect(retiredNow.length).toBe(1);
    expect(retiredNow[0]!.localPatientId).toBe('chart-live');

    // ...and no LIVE row still points at the dead chart. A surviving row would
    // let clinical data keep flowing to the chart the EMR just retired.
    expect(links.filter((l) => l.localPatientId === 'chart-dead')).toEqual([]);
  });

  it('acknowledges an entered-in-error retraction WITHOUT applying it as a fact', async () => {
    const res = await ingest(BOUND, [{
      resourceType: 'Observation',
      id: 'obs-retracted',
      status: 'entered-in-error',
      code: { coding: [{ system: 'http://loinc.org', code: '718-7' }] },
      subject: { reference: 'Patient/chart-live' },
      valueQuantity: { value: 3.1, unit: 'g/dL' },
    }]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { corrections: string[]; summary: { effectsApplied: number } };

    // A retracted value must not become a live one.
    expect(body.summary.effectsApplied).toBe(0);
    expect(body.corrections.some((c) => c.includes('entered-in-error'))).toBe(true);
  });

  it('refuses a merge whose surviving chart we cannot identify', async () => {
    // The EMR says this record became someone we hold no claim on. Guessing a
    // destination by name would move clinical data onto a plausible-looking
    // chart, so the honest answer is to refuse.
    const res = await ingest(BOUND, [{
      resourceType: 'Patient',
      id: 'emr-orphan',
      identifier: [{ system: 'urn:mrn', value: 'MRN-RETIRED' }],
      name: [{ family: 'Alvarez', given: ['Rosa'] }],
      birthDate: '1955-04-04',
      link: [{ type: 'replaced-by', other: { reference: 'Patient/emr-unknown-survivor' } }],
    }]);
    const body = res.json() as { rolledBack: boolean; summary: { skipped: string[] } };
    expect(body.rolledBack).toBe(true);
    expect(body.summary.skipped.some((s) => s.startsWith('patient-merge-unresolved'))).toBe(true);
    expect(patientIds(BOUND)).toEqual(['chart-dead', 'chart-live']);
  });

  it('treats a merge for a record we never held as a no-op, not an error', async () => {
    // The common shape: the EMR merged a record we never had, so there is
    // nothing of ours to retire. The half that matters is that the retired
    // patient is still NOT created.
    const res = await ingest(BOUND, [{
      resourceType: 'Patient',
      id: 'emr-stranger',
      identifier: [{ system: 'urn:mrn', value: 'MRN-NEVER-SEEN' }],
      name: [{ family: 'Alvarez', given: ['Rosa'] }],
      birthDate: '1955-04-04',
      link: [{ type: 'replaced-by', other: { reference: 'Patient/emr-survivor' } }],
    }, SURVIVOR]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rolledBack: boolean; corrections: string[]; summary: { structuralUpserts: number } };
    expect(body.rolledBack).toBe(false);
    expect(body.corrections.some((c) => c.includes('not one of our charts'))).toBe(true);
    expect(patientIds(BOUND)).toEqual(['chart-dead', 'chart-live']);
  });

  it('leaves a realm with no bound connection entirely alone', async () => {
    // The correction pre-pass only runs when a feed supplied an identity
    // snapshot, so an unbound realm keeps the behaviour that predates F3.5.
    const res = await ingest(UNBOUND, [{
      resourceType: 'Observation',
      id: 'obs-unbound',
      status: 'entered-in-error',
      code: { coding: [{ system: 'http://loinc.org', code: '718-7' }] },
      subject: { reference: 'Patient/f1-pt-1' },
      valueQuantity: { value: 3.1, unit: 'g/dL' },
    }]);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { corrections: string[] }).corrections).toEqual([]);
  });
});
