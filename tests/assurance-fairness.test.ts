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

// The assurance track's fairness path, as it actually exists.
//
// This file replaces two files that were written against a WRONG PREMISE and then
// deleted (`src/swarm/fairness-rows.ts`, `tests/fairness-rows.test.ts`,
// `tests/fairness-route.test.ts`). The premise was "there is no route and no row
// producer". Both claims came from `grep -rn ... src/`, and the assurance surface
// lives in `packs/dialysis-provider/assurance-track-routes.ts` — registered through
// `registerPackRoutes`. The searches could not have found it.
//
// What survives the correction is the probe, because it is a fact about the code
// that WAS there all along: a patient with an empty state scores non-zero on three of
// seven protocols. That is asserted below against `cohortSignals`, the real producer.
//
// The second half measures the real route. `cohortSignals` is reached by
// `GET /admin/swarm/assurance/fairness` from the dialysis-provider pack, so the
// question "does the screen fire?" is asked of the shipped route rather than of a
// reimplementation of it.

import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { dialysisProviderPack } from '../packs/dialysis-provider/index.js';
import { cohortSignals } from '../packs/dialysis-provider/assurance-track-routes.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { AcceleratedClock } from '../src/realm/clock.js';
import { RealmRegistry } from '../src/realm/index.js';
import { populateFacility } from '../src/realm/sim-populator.js';
import { renalPatientFacts, renalPatientInputs } from '../src/swarm/renal-cohort.js';
import { RENAL_PROTOCOLS, evaluateProtocolForPatient } from '../src/protocols/registry.js';

const FIXED_START = new Date('2026-01-01T00:00:00.000Z');

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
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
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    // The assurance routes come from the dialysis-provider pack, so it has to be
    // installed for the route to exist at all — which is itself the correction.
    packs: [healthcareCorePack, dialysisProviderPack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

function seedRealm(): void {
  const realm = RealmRegistry.create({
    id: 'assurance-fair',
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: FIXED_START }),
  });
  populateFacility(realm, {
    facilityId: 'assurance-fac',
    kind: 'dialysis',
    name: 'Assurance Dialysis',
    units: ['A', 'B'],
    patientCount: 12,
  }, { seed: 1, days: 90 });
}

beforeEach(() => {
  for (const realm of RealmRegistry.list()) RealmRegistry.remove(realm.id);
});

describe('assurance — the probe finding, against the real producer', () => {
  // A patient with NO data at all. Three of seven protocols assign a non-zero
  // severity, and `adequacy` sits at 0.5 — one notch below the `red` threshold of
  // 0.6. This is a finding about the PROTOCOLS: a patient nobody measured is 0.1 away
  // from being flagged for inadequate dialysis.
  it('documents that protocols score a no-data patient as non-zero', () => {
    const facts = renalPatientFacts({ id: 'bare', realmId: 'r', state: {} });
    const decided = RENAL_PROTOCOLS
      .map((p) => ({ id: p.id, ...evaluateProtocolForPatient(p.id, facts) }))
      .filter((s) => s.severity > 0);

    expect(decided.map((s) => s.id).sort()).toEqual(['access', 'adequacy', 'ckd-mbd']);
    expect(decided.find((s) => s.id === 'adequacy')?.severity).toBe(0.5);
    expect(decided.find((s) => s.id === 'adequacy')?.status).toBe('amber');
    expect(decided.every((s) => s.status !== 'red')).toBe(true);
  });

  // The consequence for the shipped producer, and the defect the probe uncovered.
  //
  // `cohortSignals` used to derive `covered` as "at least one protocol could evaluate
  // this patient" — which the probe above shows is TRUE for a patient with no chart,
  // because `access` returns `green` at severity 0.25 rather than `unknown`. Every row
  // was covered, so the coverage comparison `fairness.ts` performs BEFORE the flag
  // comparison was a constant, and `disparityReport` reads a coverage gap as `breach`:
  // the one gate that could have caught a data-capture disparity was measuring nothing.
  //
  // Now derived from the same sufficiency rule `registry.ts` uses for `unknown`.
  it('reports a no-data patient as UNCOVERED, which is what the coverage gate means', () => {
    const view = cohortSignals([{ id: 'bare', realmId: 'r', state: {} }]);
    expect(view.rows).toHaveLength(1);

    const row = view.rows[0]!;
    // The fix. Sessions 0 and a 0% panel is not enough data to judge anyone.
    expect(row.covered).toBe(false);
    // Still flagged, and that is the OTHER half of the finding rather than a
    // contradiction: `adequacy` reports amber 0.5 against a `red` threshold of 0.6, so
    // a patient nobody measured is 0.1 away from being flagged for inadequate dialysis.
    expect(row.flagged).toBe(true);
    expect(row.score).toBe(3);
    // And the two dimensions that exist on an empty state are absent, so the patient
    // bands into `unknown` for them rather than being dropped.
    expect(row.age).toBeUndefined();
    expect(row.sex).toBeUndefined();
  });

  // A chart is what makes a row covered, so the assertion above is about a specific
  // population rather than about the rule returning a constant — the failure the
  // previous `covered` derivation had.
  it('reports a charted patient as covered', () => {
    seedRealm();
    const view = cohortSignals(renalPatientInputs(RealmRegistry.list()));
    expect(view.rows).toHaveLength(12);
    expect(view.rows.filter((r) => r.covered)).toHaveLength(12);
  });

  // Non-vacuity: a patient WITH a chart is also covered and flagged, so the assertion
  // above is about a specific population rather than about the function returning a
  // constant.
  it('produces real rows for a seeded cohort', () => {
    seedRealm();
    const view = cohortSignals(renalPatientInputs(RealmRegistry.list()));

    expect(view.rows).toHaveLength(12);
    expect(view.patients).toBe(12);
    expect(view.protocols).toBe(RENAL_PROTOCOLS.length);
    expect(view.rows.every((r) => r.age !== undefined && r.sex !== undefined)).toBe(true);
    expect(view.rows.every((r) => r.vintageYears !== undefined && r.accessType !== undefined)).toBe(true);
  });
});

describe('assurance — the shipped fairness route', () => {
  it('is served by the dialysis-provider pack and reports over the live cohort', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness' });
      expect(res.statusCode).toBe(200);

      const body = res.json() as {
        report: { cohortN: number; dimensions: Array<{ dimension: string; verdict: string }>; verdict: string; findings: string[] };
        signature: string;
        protocol: string;
        cohort: { patients: number };
      };

      expect(body.cohort.patients).toBe(12);
      expect(body.report.cohortN).toBe(12);
      // Seven since S5 L1: the renal four plus race, ethnicity and language. The
      // order is asserted because it is observable — the renal four keep their
      // positions so a pre-L1 report and a post-L1 one are comparable side by side.
      expect(body.report.dimensions.map((d) => d.dimension)).toEqual([
        'age', 'sex', 'vintage', 'access', 'race', 'ethnicity', 'language',
      ]);
      expect(typeof body.signature).toBe('string');

      // eslint-disable-next-line no-console
      console.log(
        `[assurance] verdict=${body.report.verdict} :: ` +
        body.report.dimensions.map((d) => `${d.dimension}=${d.verdict}`).join(' '),
      );
    } finally {
      await app.close();
    }
  });

  // S5 L1 moved this line. Before it, `race` was a real field on every ingested
  // patient and NOT a declared `SliceDimension`, so asking for it was a 400 — and an
  // empty `DisparityReport` would have read as "no racial disparity", the most
  // dangerous wrong answer this endpoint could give. Now it is served, and the 400
  // case has moved to the axis that is still missing.
  it('serves a demographic dimension that used to be refused', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?dimension=race' });
      expect(res.statusCode).toBe(200);

      const body = res.json() as { dimension: { dimension: string; slices: Array<{ slice: string; n: number }> } };
      expect(body.dimension.dimension).toBe('race');
      // The static fixture carries no race, so every patient bands into `unknown` —
      // and is COUNTED there rather than dropped, which is the distinction that makes
      // the gap visible instead of invisible.
      expect(body.dimension.slices.map((s) => [s.slice, s.n])).toEqual([['unknown', 12]]);
    } finally {
      await app.close();
    }
  });

  // `insurance` is a real equity axis (§9.2 names it alongside race, ethnicity and
  // language) and is still NOT declared. It stays a 400 so the gap is asserted rather
  // than latent — and an unlisted dimension must never come back as an empty report,
  // because "no disparity in insurance" and "we do not record insurance" are opposite
  // conclusions that would render identically.
  it('refuses a dimension that is still undeclared, and an unknown protocol', async () => {
    seedRealm();
    const app = await build();
    try {
      const badDim = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?dimension=insurance' });
      expect(badDim.statusCode).toBe(400);
      expect((badDim.json() as { error: string }).error).toContain('insurance');

      const badProtocol = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?protocol=mbd' });
      expect(badProtocol.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
