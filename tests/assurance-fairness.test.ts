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
  // The probe finding, now fixed at its source.
  //
  // Three of seven protocols used to answer anyway for a patient with no chart at all:
  // `adequacy` 0.5, `ckd-mbd` 0.3, `access` 0.25. Each encoded missingness as a
  // positive severity, which both defeated the engine's own `unknown` branch (it only
  // fired at severity 0) and put a patient nobody had measured 0.1 below the `red`
  // threshold for inadequate dialysis. `registry.ts` no longer does that.
  it('declines to judge a no-data patient, on every protocol', () => {
    const facts = renalPatientFacts({ id: 'bare', realmId: 'r', state: {} });
    const decided = RENAL_PROTOCOLS.map((p) => ({ id: p.id, ...evaluateProtocolForPatient(p.id, facts) }));

    expect(decided.every((s) => s.status === 'unknown')).toBe(true);
    expect(decided.every((s) => s.severity === 0)).toBe(true);

    // Named individually: these three carried the terms, and an aggregate assertion
    // would let one of them creep back if another stopped scoring.
    for (const id of ['adequacy', 'ckd-mbd', 'access'] as const) {
      const row = decided.find((s) => s.id === id);
      expect(row?.severity, `${id} scores a patient with no data`).toBe(0);
      expect(row?.status, `${id} judges a patient with no data`).toBe('unknown');
    }
  });

  // Non-vacuity: the engine still judges a patient it CAN measure, so the assertion
  // above is about missing data rather than about a protocol that never speaks.
  it('still judges a patient who has been measured', () => {
    const charted = renalPatientFacts({ id: 'charted', realmId: 'r', state: { labs: { URR: 55 } } });
    const adequacy = evaluateProtocolForPatient('adequacy', charted);
    expect(adequacy.status).toBe('red');
    expect(adequacy.severity).toBeGreaterThan(0.6);
  });

  // The consequence for the shipped producer, and the defect the probe uncovered.
  //
  // `cohortSignals` derived `covered` as "at least one protocol could evaluate this
  // patient" — which the probe showed was TRUE for a patient with no chart, because
  // `access` returned `green` at severity 0.25 rather than `unknown`. Every row was
  // covered, so the coverage comparison `fairness.ts` performs BEFORE the flag
  // comparison was a constant, and `disparityReport` reads a coverage gap as `breach`:
  // the one gate that could have caught a data-capture disparity was measuring nothing.
  //
  // The interim fix restated the engine's `unknown` condition inside `covered`. That
  // restatement is now retired — the engine makes `unknown` reachable, so `covered`
  // reads the engine rather than duplicating it.
  it('reports a no-data patient as uncovered AND unflagged', () => {
    const view = cohortSignals([{ id: 'bare', realmId: 'r', state: {} }]);
    expect(view.rows).toHaveLength(1);

    const row = view.rows[0]!;
    // No protocol reached a verdict, so there is nothing to be covered by…
    expect(row.covered).toBe(false);
    expect(row.score).toBe(0);
    // …and nothing was flagged either. This is the half that CHANGED: the patient used
    // to read `flagged: true` off `adequacy`'s 0.5 against a 0.6 threshold.
    expect(row.flagged).toBe(false);
    // The two dimensions that exist on an empty state are absent, so the patient bands
    // into `unknown` for them rather than being dropped.
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
      // Eight: the renal four, then race/ethnicity/language (S5 L1), then insurance.
      // The order is asserted because it is observable — the renal four keep their
      // positions, so a pre-L1 report and a post-L1 one are comparable side by side.
      expect(body.report.dimensions.map((d) => d.dimension)).toEqual([
        'age', 'sex', 'vintage', 'access', 'race', 'ethnicity', 'language', 'insurance',
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

  // The payer axis. `enrich.ts` resolves the patient's `Coverage` ENTITY onto
  // `state.insurance` (a coverage fact lives on its own resource, so it needs that
  // step), and on the STATIC fixture no patient has coverage — every one bands into
  // `unknown` and is counted there rather than dropped. That is the honest state of the
  // world until `synthea-seeds/` is committed (§5 S6); what this asserts is that the
  // axis exists and counts its patients, which is the difference between a gap that is
  // visible and one that is not.
  it('serves the payer axis, counting unrecorded coverage rather than dropping it', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?dimension=insurance' });
      expect(res.statusCode).toBe(200);

      const body = res.json() as { dimension: { dimension: string; slices: Array<{ slice: string; n: number }> } };
      expect(body.dimension.dimension).toBe('insurance');
      expect(body.dimension.slices.map((s) => [s.slice, s.n])).toEqual([['unknown', 12]]);
    } finally {
      await app.close();
    }
  });

  // `insurance` WAS this test's 400 case and is now declared, so the 400 moved to
  // `birthSex` — the one axis deliberately left out, because `sex` already bands it and
  // `fairnessReport` takes the WORST verdict across dimensions, so two dimensions over
  // one axis would double-count a single disparity in the headline while reading as two
  // independent findings.
  //
  // It must stay a 400 rather than becoming an empty report: "no disparity in birth
  // sex" and "we do not band birth sex" are opposite conclusions that would otherwise
  // render identically.
  it('refuses a dimension that is not declared, and an unknown protocol', async () => {
    seedRealm();
    const app = await build();
    try {
      const badDim = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?dimension=birthSex' });
      expect(badDim.statusCode).toBe(400);
      expect((badDim.json() as { error: string }).error).toContain('birthSex');

      const badProtocol = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?protocol=mbd' });
      expect(badProtocol.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
