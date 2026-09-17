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

// S4 — the async seeding seam.
//
// Two things are worth testing here and only two. Everything else the seeder does
// is already tested where it lives (`population-seed.test.ts` for the ingest →
// enrich → prime path, `population-source.test.ts` for the round-robin).
//
//   1. **The seam changed nothing.** `StaticPopulationSeeder` must produce exactly
//      the realm `populateFacility` produces. That is the same discipline S1 applied
//      to the `PatientSource` refactor, and for the same reason: the justification
//      for routing a call through an interface is that the interface is free.
//   2. **The duplicated mapper is gone.** `seederRequestFrom` is the single place a
//      route payload becomes a seeder request. It is tested as a *mapping* —
//      including that it does not invent an `artifact` block — because the defect it
//      exists to prevent is the two call sites drifting, and a drift is invisible in
//      any test that only exercises one of them.

import { describe, expect, it, beforeEach } from 'vitest';
import { AcceleratedClock } from '../src/realm/clock.js';
import { RealmRegistry } from '../src/realm/index.js';
import { populateFacility } from '../src/realm/sim-populator.js';
import type { Realm } from '../src/realm/realm.js';
import {
  DEFAULT_FACILITY_KIND,
  MissingPatientCountError,
  POPULATION_SEEDERS,
  StaticPopulationSeeder,
  SyntheaPopulationSeeder,
  seederById,
  seederRequestFrom,
  type SeederRequest,
} from '../src/population/seeder.js';

const FIXED_START = new Date('2026-01-01T00:00:00.000Z');

function makeRealm(id: string): Realm {
  return RealmRegistry.create({
    id,
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: FIXED_START }),
  });
}

/** Stable stringify, key-sorted, so a snapshot cannot depend on key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function patientSnapshot(realm: Realm): string {
  return realm.graph.listKind('patient').map((p) => `${p.id}=${canonical(p.state)}`).sort().join('\n');
}

const REQUEST: SeederRequest = {
  facilityId: 'seam-fac',
  facilityKind: 'dialysis',
  facilityName: 'Seam Dialysis',
  units: ['A', 'B', 'C'],
  patientCount: 12,
};

beforeEach(() => {
  for (const realm of RealmRegistry.list()) RealmRegistry.remove(realm.id);
});

describe('S4 — the static seeder is the old code path, wrapped', () => {
  // The whole justification for the seam: routing `populateFacility` through an
  // async interface must be free. If this fails, the seam is wrong and every other
  // test in this file is measuring the wrong thing.
  it('produces exactly the realm `populateFacility` produces', async () => {
    const viaInterface = makeRealm('seam-via-interface');
    await StaticPopulationSeeder.seed(viaInterface, REQUEST);

    const viaDirect = makeRealm('seam-via-direct');
    populateFacility(viaDirect, {
      facilityId: REQUEST.facilityId,
      kind: 'dialysis',
      name: 'Seam Dialysis',
      units: ['A', 'B', 'C'],
      patientCount: 12,
    });

    // Same facilityId on purpose, so the patient ids are comparable and the
    // assertion can be equality rather than "equal after normalising ids away".
    // Nothing in the seeded state embeds the realm id, which is what makes that
    // possible — and is itself worth knowing.
    expect(patientSnapshot(viaInterface)).toBe(patientSnapshot(viaDirect));
    expect(patientSnapshot(viaInterface).split('\n')).toHaveLength(12);
  });

  it('reports the facility, units and patients it created', async () => {
    const realm = makeRealm('seam-outcome');
    const outcome = await StaticPopulationSeeder.seed(realm, REQUEST);

    expect(outcome.seederId).toBe(StaticPopulationSeeder.id);
    expect(outcome.facilityId).toBe('seam-fac');
    expect(outcome.unitIds).toEqual(['seam-fac-A', 'seam-fac-B', 'seam-fac-C']);
    expect(outcome.patientIds).toHaveLength(12);
    // No report: the static path interprets nothing, so there is nothing to report.
    // A stub report here would be a number that means nothing dressed as provenance.
    expect(outcome.report).toBeUndefined();
  });

  // `patientCount` is optional on the shared request shape so one shape serves both
  // seeders, which means the static seeder has to be the thing that insists on it.
  // Defaulting to a number nobody chose is exactly the class of silent wrongness
  // this file's sibling tests exist to catch.
  it('refuses to run when the request has no patient count', async () => {
    const realm = makeRealm('seam-no-count');
    await expect(
      StaticPopulationSeeder.seed(realm, { facilityId: 'x', units: ['A'] }),
    ).rejects.toBeInstanceOf(MissingPatientCountError);
  });

  it('defaults the facility kind rather than dropping it', async () => {
    const realm = makeRealm('seam-default-kind');
    const outcome = await StaticPopulationSeeder.seed(realm, {
      facilityId: 'seam-default',
      units: ['A'],
      patientCount: 3,
    });

    expect(outcome.facilityId).toBe('seam-default');
    const facility = realm.graph.listKind('facility')[0];
    expect((facility?.state as { kind?: string }).kind).toBe(DEFAULT_FACILITY_KIND);
  });
});

describe('S4 — one payload mapper, because there used to be two', () => {
  it('maps the facility fields through', () => {
    const request = seederRequestFrom({
      facilityId: 'f-1',
      facilityKind: 'outpatient-dialysis',
      facilityName: 'F One',
      units: ['A', 'B'],
    });

    expect(request.facilityId).toBe('f-1');
    expect(request.facilityKind).toBe('outpatient-dialysis');
    expect(request.facilityName).toBe('F One');
    expect(request.units).toEqual(['A', 'B']);
  });

  // A payload with no artifact configuration must not produce an empty `artifact`
  // block. `{}` is not the same as absent: the population seeder reads
  // `request.artifact ?? {}`, so both behave alike today — but a present-but-empty
  // block would make "this request configured an artifact" indistinguishable from
  // "this request did not", and that is the question a future field would be added
  // to answer.
  it('omits the artifact block entirely when no artifact option is set', () => {
    const request = seederRequestFrom({ facilityId: 'f-2', units: ['A'] });
    expect(request.artifact).toBeUndefined();
    expect(Object.keys(request)).not.toContain('artifact');
  });

  // The drift guard. Every artifact field a route can carry must survive the
  // mapping — this is the assertion that fails when a field is added to
  // `PopulationSeedRequest` and forgotten here, which is how the two hand-written
  // option bags would have diverged.
  it('carries every artifact field through', () => {
    const request = seederRequestFrom({
      facilityId: 'f-3',
      units: ['A'],
      root: '/tmp/root',
      limit: 7,
      includeDeceased: true,
      seedObservationState: false,
    });

    expect(request.artifact).toEqual({
      root: '/tmp/root',
      limit: 7,
      includeDeceased: true,
      seedObservationState: false,
    });
  });

  // `false` and `0` are values, not absences. A mapper written with `||` or a truthy
  // check would drop them, and a caller asking for `limit: 0` or explicitly turning
  // the observation seed OFF would silently get the default instead.
  it('does not confuse a falsey option with an absent one', () => {
    const request = seederRequestFrom({
      facilityId: 'f-4',
      units: ['A'],
      limit: 0,
      includeDeceased: false,
      seedObservationState: false,
    });

    expect(request.artifact).toEqual({ limit: 0, includeDeceased: false, seedObservationState: false });
  });
});

describe('S4 — the seeder registry', () => {
  it('registers both paths, and the population one is reachable by name', () => {
    expect(Object.keys(POPULATION_SEEDERS).sort()).toEqual(['static', 'synthea']);
    expect(seederById('synthea')).toBe(SyntheaPopulationSeeder);
    expect(seederById('static')).toBe(StaticPopulationSeeder);
  });

  // A typo in a stored seeder id must fail loudly. Falling back to the static
  // seeder would produce a realm that looks seeded and is the wrong population —
  // the failure mode `realm-restore.ts` already removes a realm to avoid.
  it('refuses an unknown seeder id, and names the ones that exist', () => {
    expect(() => seederById('synthia')).toThrowError(/synthia/);
    expect(() => seederById('synthia')).toThrowError(/static, synthea/);
  });
});
