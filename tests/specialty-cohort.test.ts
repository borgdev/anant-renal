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

// A specialty owns its POPULATION.
//
// The gap this closes: the platform had one patient projection and handed it to
// every pack, so a non-renal specialty received a renal cohort it had no way to
// identify itself within. Oncology's board was empty for that reason — the pack
// could not name a single patient it was responsible for, so it could not say
// anything useful at all.
//
// Two properties carry the design, and both are asserted here:
//
//   * a pack that declares a cohort receives ONLY its own patients
//   * a pack that declares none receives the whole projection — unchanged from
//     what shipped before, because a concept that rewrites the working packs on
//     the day it lands is one nobody can adopt
//
// The predicate is a DECLARATION OVER PLATFORM FACTS, not a second data source,
// and the last test here is the reason that matters: a cohort cannot reach a
// patient the platform never projected.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { hasOncologyProblem, oncologyCohort, problemListOf } from '../packs/oncology-provider/cohort.js';
import type { DomainPack } from '../src/control-plane/pack-registry.js';
import type { PackCohort, PackRouteContribution, PackWithContributions } from '../src/control-plane/pack-contributions.js';
import type { RenalPatientInput } from '../src/swarm/renal-cohort.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { setSpecialtyBindingSnapshot } from '../src/server/specialty-apply.js';

const actor: ActorContext = {
  actorRef: 'user:cohort',
  scopeIds: ['scope:*'],
  clearance: 'restricted-phi',
  purposeOfUse: 'operations',
} as ActorContext;

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  return {
    async applyMigrations() { /* no-op */ },
    async appendEvent(_s: unknown, e: CanonicalEvent) { events.push(e); },
    async queryEvents() { return events; },
    async appendLedger(_s: unknown, e: LedgerEntry) { ledger.push(e); },
    async queryLedger() { return ledger; },
    async appendAudit() { /* noop */ },
    async queryAudit() { return []; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

/**
 * Six patients: three with a malignancy, three without.
 *
 * Several carry RENAL problems too, on purpose — a multi-specialty patient is the
 * whole point, and a fixture where each patient belongs to exactly one specialty
 * would not exercise the overlapping case that makes cohorts worth having.
 */
const PATIENTS: RenalPatientInput[] = [
  { id: 'p1', realmId: 'r1', state: { problemList: ['ESRD', 'HTN', 'DM2'] } },
  { id: 'p2', realmId: 'r1', state: { problemList: ['ESRD', 'NSCLC'] } },
  { id: 'p3', realmId: 'r1', state: { problemList: ['Breast cancer'] } },
  { id: 'p4', realmId: 'r1', state: { problemList: ['ESRD', 'CKD-anemia'] } },
  { id: 'p5', realmId: 'r1', state: { problemList: ['ESRD', 'RCC', 'HTN'] } },
  { id: 'p6', realmId: 'r1', state: {} },
];

/** A pack that reports exactly which patients it was handed. */
function reportingPack(id: string, cohort?: PackCohort): PackWithContributions {
  const routes: PackRouteContribution = {
    id: `${id}.probe`,
    scope: 'exec',
    prefixes: [`/admin/swarm/${id}`],
    register(app, deps) {
      app.get(`/admin/swarm/${id}/probe`, async () => ({
        ids: deps.patients().map((patient) => patient.id),
      }));
    },
  };
  return {
    ...(healthcareCorePack as DomainPack),
    id,
    version: '0.1.0',
    capabilities: ['probe'],
    requiredControls: ['access-policy'],
    routes: [routes],
    ...(cohort ? { cohort } : {}),
  } as unknown as PackWithContributions;
}

async function deployment(packs: PackWithContributions[]) {
  const app = await buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs,
    renalPatients: () => PATIENTS,
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
  const raw = res.headers['set-cookie'];
  const cookie = /hh_session=([^;]+)/.exec(Array.isArray(raw) ? raw.join(';') : String(raw ?? ''))?.[1] ?? '';
  const ids = async (packId: string): Promise<string[]> => {
    const probe = await app.inject({ method: 'GET', url: `/admin/swarm/${packId}/probe`, headers: { cookie: `hh_session=${cookie}` } });
    return (probe.json() as { ids: string[] }).ids;
  };
  return { app, ids };
}

describe('a specialty owns its population', () => {
  it('a pack with a cohort receives ONLY its own patients', async () => {
    const { app, ids } = await deployment([
      reportingPack('with-cohort', { id: 'test.ones', includes: (p) => p.id.endsWith('1'), emptyReason: 'n/a' }),
    ]);
    // Not "fewer patients" — the platform scoped the projection to this pack.
    expect(await ids('with-cohort')).toEqual(['p1']);
    await app.close();
  });

  it('a pack that declares NO cohort still receives everything', async () => {
    // The compatibility half. A concept that changes the behaviour of every pack
    // already working is one nobody adopts, so the default is what shipped.
    const { app, ids } = await deployment([reportingPack('no-cohort')]);
    expect(await ids('no-cohort')).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    await app.close();
  });

  it('two packs in ONE deployment receive different populations', async () => {
    // The property that makes a multi-specialty deployment different from two
    // products side by side: the same platform, the same patients, different
    // answers to "which of these are mine".
    const { app, ids } = await deployment([
      reportingPack('renal-ish', { id: 'test.renal', includes: (p) => problemListOf(p).includes('ESRD'), emptyReason: 'n/a' }),
      reportingPack('onc-ish', { id: 'test.onc', includes: hasOncologyProblem, emptyReason: 'n/a' }),
    ]);
    expect(await ids('renal-ish')).toEqual(['p1', 'p2', 'p4', 'p5']);
    expect(await ids('onc-ish')).toEqual(['p2', 'p3', 'p5']);
    // p2 and p5 are in BOTH — the overlapping patient is the point.
    await app.close();
  });

  it('the applied gate still empties a cohort, and the two compose', async () => {
    // Cohort and `applied` answer different questions — "is this patient mine" and
    // "is this specialty on for this caller" — and applying them in the wrong order
    // or collapsing them would let a switched-off specialty keep computing.
    setSpecialtyBindingSnapshot([
      { id: 'scope:*|onc-ish', scope: 'scope:*', packId: 'onc-ish', applied: false, show: false, entitled: false },
    ]);
    const { app, ids } = await deployment([
      reportingPack('onc-ish', { id: 'test.onc', includes: hasOncologyProblem, emptyReason: 'n/a' }),
      reportingPack('renal-ish', { id: 'test.renal', includes: (p) => problemListOf(p).includes('ESRD'), emptyReason: 'n/a' }),
    ]);
    expect(await ids('onc-ish')).toEqual([]);
    // And the other specialty in the same deployment is untouched.
    expect(await ids('renal-ish')).toEqual(['p1', 'p2', 'p4', 'p5']);
    await app.close();
    setSpecialtyBindingSnapshot([]);
  });
});

describe("oncology's cohort definition", () => {
  it('selects on the RECORDED problem, not on anything inferred', () => {
    expect(hasOncologyProblem(PATIENTS[1]!)).toBe(true);
    expect(hasOncologyProblem(PATIENTS[0]!)).toBe(false);
  });

  it('treats a missing or malformed problem list as "not mine"', () => {
    // `state` is an untyped bag on the wire, and the failure direction matters: an
    // unreadable list must not enrol a patient into a specialty's population.
    expect(problemListOf({ id: 'x', realmId: 'r', state: {} })).toEqual([]);
    expect(problemListOf({ id: 'x', realmId: 'r', state: { problemList: 'ESRD' } })).toEqual([]);
    expect(problemListOf({ id: 'x', realmId: 'r', state: { problemList: [1, 'NSCLC'] } })).toEqual(['NSCLC']);
    expect(hasOncologyProblem({ id: 'x', realmId: 'r', state: { problemList: [1, null] } })).toBe(false);
  });

  it('declares a reason for an empty cohort, because blank and "nothing to do" differ', () => {
    expect(oncologyCohort.emptyReason).toMatch(/problem list/);
    expect(oncologyCohort.emptyReason).toMatch(/clean bill of health/);
  });
});
