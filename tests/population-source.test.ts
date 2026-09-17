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

// S1 — the population seam, guarded by a golden.
//
// S1 moves the hand-written round-robin out of `sim-populator.ts` and behind a
// `PatientSource`, so that a generated population can replace it later (S0…S4).
// The whole justification for that refactor is that it **changes no behaviour**,
// and a refactor that claims to change nothing is exactly the kind that changes
// something quietly. So this file pins the seeded population to a hash of every
// patient's state, computed before the seam existed.
//
// The hash is a hash rather than a list of expected fields on purpose: an
// assertion listing the fields it knows about cannot fail on a field added later,
// and the risk here is precisely a field changing that nobody thought to list.
// A couple of readable assertions sit alongside it so a failure says something
// other than "the hash moved".
//
// The clock is injected and frozen. Without that the golden is unreproducible —
// `populateFacility` writes `admittedAt` and `lastVitals.at` from
// `realm.clock.realmAt`, so a wall-clock realm hashes differently on every run and
// the guard would be worthless.
//
// `seed: 1, days: 90` exercises the history path too, because that is the branch
// that reaches into `longitudinal.ts` and is therefore the most likely thing to
// shift during a refactor.

import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { AcceleratedClock } from '../src/realm/clock.js';
import { RealmRegistry } from '../src/realm/index.js';
import { populateFacility, type FacilitySeed } from '../src/realm/sim-populator.js';
import type { Realm } from '../src/realm/realm.js';

/** A fixed instant, so every timestamp the seeder writes is deterministic. */
const FIXED_START = new Date('2026-01-01T00:00:00.000Z');

const SEED: FacilitySeed = {
  facilityId: 'golden-fac',
  kind: 'dialysis',
  name: 'Golden Dialysis',
  units: ['A', 'B', 'C'],
  // 12, NOT 9, and the reason is a defect in the first version of this file.
  // Every attribute is `array[i % length]`, so with 9 patients `i` only reaches 8
  // and `AGES[9]` is never used. Changing that one element left the hash
  // unmoved — verified by perturbing it — which meant the golden was silently
  // blind to a whole slice of the population. 12 patients walks past the end of
  // the longest array (AGES, 10) so every element of every array is exercised.
  patientCount: 12,
};

function seedRealm(id: string, history?: { seed: number; days: number }): Realm {
  const realm = RealmRegistry.create({
    id,
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: FIXED_START }),
  });
  populateFacility(realm, SEED, history);
  return realm;
}

/** Stable stringify: object keys sorted, so the hash cannot depend on key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function patientSnapshot(realm: Realm): string {
  return realm.graph
    .listKind('patient')
    .map((p) => `${p.id}=${canonical(p.state)}`)
    .sort()
    .join('\n');
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

beforeEach(() => {
  for (const realm of RealmRegistry.list()) RealmRegistry.remove(realm.id);
});

describe('S1 — the seeded population is pinned, because the seam must change nothing', () => {
  it('seeds patients identically without the history branch', () => {
    const snapshot = patientSnapshot(seedRealm('golden-plain'));
    // Captured from the PRE-REFACTOR seeder at 12 patients, clock frozen.
    expect(digest(snapshot)).toBe('ea7482694cf882cd');
    // Readable alongside the hash, so a failure names something.
    expect(snapshot.split('\n')).toHaveLength(SEED.patientCount);
    expect(snapshot).toContain('golden-fac-pt-0001');
  });

  it('seeds patients identically WITH the 90-day history branch', () => {
    // The branch that reaches into `longitudinal.ts` — the most likely thing to
    // drift when the code moves, and the one S4 will replace with Synthea's warm-up.
    const snapshot = patientSnapshot(seedRealm('golden-history', { seed: 1, days: 90 }));
    // Also pre-refactor. The history branch is the one S4 replaces, so it is pinned
    // separately — a change there must be a deliberate act, not a side effect.
    expect(digest(snapshot)).toBe('3d0c8d5d6d677f0e');
    expect(snapshot).toContain('esaDosingHistory');
    expect(snapshot).toContain('dialysisVintageYears');
  });

  it('is reproducible across two runs in the same process', () => {
    // If this fails, the golden above is measuring the clock rather than the
    // seeder and every other assertion in this file is meaningless.
    const a = patientSnapshot(seedRealm('golden-repro-a'));
    const b = patientSnapshot(seedRealm('golden-repro-b'));
    // Same facility id would collide, so compact the ids out before comparing.
    expect(a.replaceAll('golden-fac', 'X').replaceAll('golden-repro-a', 'X'))
      .toBe(b.replaceAll('golden-fac', 'X').replaceAll('golden-repro-b', 'X'));
  });

  it('seeds the facility and its units, and puts every patient in one', () => {
    const realm = seedRealm('golden-structure');
    expect(realm.graph.listKind('facility')).toHaveLength(1);
    expect(realm.graph.listKind('unit')).toHaveLength(SEED.units.length);
    const patients = realm.graph.listKind('patient');
    expect(patients).toHaveLength(SEED.patientCount);
    for (const p of patients) {
      expect((p.state as { unitId?: string }).unitId, p.id).toBeTruthy();
    }
  });
});

describe('S4 — a facility kind no longer decides clinical content', () => {
  /**
   * Seed one facility of `kind` and return its patients' problem lists, in
   * `listKind` order so two facilities are comparable position by position.
   */
  function problemLists(facilityId: string, kind: string): string[][] {
    const realm = RealmRegistry.create({
      id: `kind-${facilityId}`,
      mode: 'sim',
      clock: new AcceleratedClock({ startAt: FIXED_START }),
    });
    populateFacility(realm, { ...SEED, facilityId, kind });
    return realm.graph
      .listKind('patient')
      .map((p) => [...((p.state as { problemList?: readonly string[] }).problemList ?? [])].sort());
  }

  // `problemsFor(kind, trajectory)` used to read:
  //   dialysis → ESRD/HTN/DM2      primary-care → HTN/DM2/Hyperlipidemia
  //   urgent-care → []             hospital → CAD/CHF
  // so the same patient index got a different chart depending only on the label on
  // the building. That is the platform asserting case mix from a facility kind, and
  // §9.4 names it as one of the two places the round-robin decided case mix.
  //
  // Two kinds that used to disagree must now agree exactly. The last assertion is
  // what makes this non-vacuous: "identical" must not be able to pass as "both empty",
  // which is exactly how urgent-care used to behave.
  it('gives the same patients the same problems whatever the kind is', () => {
    const dialysis = problemLists('k-dialysis', 'dialysis');
    const urgent = problemLists('k-urgent', 'urgent-care');
    const hospital = problemLists('k-hospital', 'hospital');

    expect(urgent).toEqual(dialysis);
    expect(hospital).toEqual(dialysis);
    expect(dialysis).toHaveLength(SEED.patientCount);
    expect(dialysis.every((list) => list.length > 0)).toBe(true);
  });

  // `FacilitySeed.kind` was the closed union `'dialysis' | 'primary-care' |
  // 'urgent-care' | 'hospital'`, and every pack declares a vocabulary that does not
  // intersect it — `packs/dialysis-provider` says `['outpatient-dialysis',
  // 'home-dialysis']`, `packs/oncology-deep` says `['oncology', 'infusion',
  // 'hospital']`. So the union could never have matched a pack's
  // `appliesTo.facilityKinds`: a constraint with no enforcer.
  //
  // Seeding with a real pack value is the check that it is genuinely gone — this was
  // a compile error before §9.7 step 2 deleted `problemsFor` and the union together.
  it('accepts a pack vocabulary the closed union forbade', () => {
    const lists = problemLists('k-pack', 'outpatient-dialysis');
    expect(lists).toHaveLength(SEED.patientCount);
  });
});
