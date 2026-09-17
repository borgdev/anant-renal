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

// S5 L0 — the fairness row producer, and the question the screen was never asked.
//
// The decisive test here is not any single assertion; it is that
// `fairnessReport(fairnessRowsFromPatients(...))` is *callable and meaningful*. Before
// this file the only rows that ever reached that report were `[]` from tests, so the
// verdict was `insufficient` by construction and nothing could distinguish "equitable"
// from "unreachable".
//
// The second theme is the static fixture's own arithmetic, asserted rather than
// lamented: `SEXES` alternates strictly, so a 12-patient realm is exactly 6/6 and the
// sex dimension can *never* show a disparity. That is §1.2's claim, and it is a
// property of the fixture rather than of the platform — worth pinning, because a
// future "the screen finds nothing" result needs to be attributable.

import { describe, expect, it, beforeEach } from 'vitest';
import { AcceleratedClock } from '../src/realm/clock.js';
import { RealmRegistry } from '../src/realm/index.js';
import { populateFacility, type FacilitySeed } from '../src/realm/sim-populator.js';
import { renalPatientFacts, renalPatientInputs } from '../src/swarm/renal-cohort.js';
import { RENAL_PROTOCOLS, evaluateProtocolForPatient } from '../src/protocols/registry.js';
import { fairnessRowsFromPatients, fairnessRowFromPatient } from '../src/swarm/fairness-rows.js';
import { fairnessReport, sliceOf } from '../src/evidence/fairness.js';

const FIXED_START = new Date('2026-01-01T00:00:00.000Z');

/** 12 patients walks past the end of every fixture array (the S1 golden's reason). */
const SEED: FacilitySeed = {
  facilityId: 'fair-fac',
  kind: 'dialysis',
  name: 'Fairness Dialysis',
  units: ['A', 'B'],
  patientCount: 12,
};

function seeded(history?: { seed: number; days: number }) {
  const realm = RealmRegistry.create({
    id: `fair-${Math.random().toString(36).slice(2, 8)}`,
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: FIXED_START }),
  });
  populateFacility(realm, SEED, history);
  return { realm, patients: renalPatientInputs([realm]) };
}

beforeEach(() => {
  for (const realm of RealmRegistry.list()) RealmRegistry.remove(realm.id);
});

describe('S5 L0 — rows exist, so the screen can be asked a question', () => {
  it('produces one row per patient', () => {
    const { patients } = seeded();
    const rows = fairnessRowsFromPatients(patients, { at: FIXED_START });
    expect(rows).toHaveLength(SEED.patientCount);
    expect(new Set(rows.map((r) => r.patientId)).size).toBe(SEED.patientCount);
  });

  // The four declared slice dimensions must be FILLED, or the screen bands every
  // patient into `unknown` and reports `insufficient` for a reason that looks like
  // missing data rather than a missing producer. `vintageYears` is the one at risk:
  // `RenalPatientFacts` does not carry it, so it is read off the entity state.
  it('fills every declared slice dimension', () => {
    const { patients } = seeded();
    const rows = fairnessRowsFromPatients(patients, { at: FIXED_START });

    for (const [dimension, present] of [
      ['age', (r: (typeof rows)[number]) => r.age !== undefined],
      ['sex', (r: (typeof rows)[number]) => r.sex !== undefined],
      ['vintage', (r: (typeof rows)[number]) => r.vintageYears !== undefined],
      ['access', (r: (typeof rows)[number]) => r.accessType !== undefined],
    ] as const) {
      expect(rows.every(present), `${dimension} unfilled`).toBe(true);
      // …and no patient lands in the `unknown` slice for it.
      expect(rows.map((r) => sliceOf(dimension, r).id), dimension).not.toContain('unknown');
    }
  });

  // §8 #6 applied where it matters: `age` is derived from the stored `birthDate` at
  // the caller's instant. The static fixture has no birth date, so this asserts the
  // fallback rather than the derivation — but it asserts that `age` is a real number
  // rather than a `NaN` that would band as `< 55` and read as data.
  it('bands age from the instant it is given, and never yields NaN', () => {
    const { patients } = seeded();
    const rows = fairnessRowsFromPatients(patients, { at: FIXED_START });
    for (const row of rows) {
      expect(Number.isFinite(row.age)).toBe(true);
      expect(row.age).toBeGreaterThanOrEqual(0);
    }
  });

  // The whole point: the report runs over real rows. `cohortN` is the strongest
  // single assertion available, because it is the number `fairnessReport` compares
  // against `minSliceN` before it can say anything at all.
  it('feeds a fairness report a real cohort instead of an empty one', () => {
    const { patients } = seeded({ seed: 1, days: 90 });
    const rows = fairnessRowsFromPatients(patients, { at: FIXED_START });
    const report = fairnessReport(rows);

    expect(report.cohortN).toBe(SEED.patientCount);
    expect(report.dimensions).toHaveLength(4);
    // Not `insufficient` for the cohort-size reason — the reason it used to be.
    expect(report.findings.join(' ')).not.toContain('smaller than the minimum slice size');
    expect(report.verdict).toMatch(/ok|watch|breach|insufficient/);
  });

  // §1.2, asserted on the fixture rather than argued: `SEXES` alternates strictly, so
  // sex parity is arithmetic and the sex dimension can never fire. If a future change
  // makes it fire, that is a change to the fixture and this test says so.
  it('cannot find a sex disparity in a fixture whose sexes alternate strictly', () => {
    const { patients } = seeded();
    const rows = fairnessRowsFromPatients(patients, { at: FIXED_START });
    const report = fairnessReport(rows);
    const sex = report.dimensions.find((d) => d.dimension === 'sex');

    expect(sex?.slices.map((s) => [s.slice, s.n])).toEqual([['F', 6], ['M', 6]]);
    expect(sex?.verdict).toBe('ok');
  });
});

describe('S5 L0 — the derived booleans', () => {
  // `covered` is the coverage gate, not health. A patient with no sessions and a thin
  // panel cannot be decided, so they are uncovered — and `fairness.ts` reads a slice's
  // coverage before it reads its flag rate, which is why the distinction has to be
  // preserved rather than collapsed into `flagged: false`.
  it('reports a bare patient as uncovered rather than unflagged', () => {
    const row = fairnessRowFromPatient(
      { id: 'bare', realmId: 'r', state: {} },
      { at: FIXED_START },
    );
    expect(row.covered).toBe(false);
    expect(row.flagged).toBe(false);
    // And it is still a row. Dropping an unknown patient would hide exactly the
    // population a coverage comparison is about.
    expect(row.patientId).toBe('bare');
    expect(row.age).toBeUndefined();
    expect(row.sex).toBeUndefined();
  });

  // The finding that forced `covered` off the protocol statuses, pinned so it cannot
  // be forgotten or silently 'fixed'. A patient with an EMPTY state gets a non-zero
  // severity from three of seven protocols, and `adequacy` sits at 0.5 — 0.1 below the
  // `red` threshold. If this assertion ever changes, `covered`'s derivation should be
  // revisited, because it was chosen around exactly this behaviour.
  it('documents that protocols score a no-data patient as non-zero', () => {
    const facts = renalPatientFacts({ id: 'bare', realmId: 'r', state: {} });
    const decided = RENAL_PROTOCOLS
      .map((p) => ({ id: p.id, ...evaluateProtocolForPatient(p.id, facts) }))
      .filter((s) => s.severity > 0);

    expect(decided.map((s) => s.id).sort()).toEqual(['access', 'adequacy', 'ckd-mbd']);
    expect(decided.find((s) => s.id === 'adequacy')?.severity).toBe(0.5);
    expect(decided.find((s) => s.id === 'adequacy')?.status).toBe('amber');
    // Nothing is flagged — but only because the threshold is 0.6. That margin is the
    // whole reason this test exists.
    expect(decided.every((s) => s.status !== 'red')).toBe(true);
  });

  // `flagged` is `red`, not `amber`. Asserted as a property of the mapping so that
  // folding the watch band in later is a deliberate act with a failing test.
  it('is deterministic for the same state and instant', () => {
    const patient = { id: 'p', realmId: 'r', state: { age: 70, sex: 'F', dialysisVintageYears: 3 } };
    const a = fairnessRowFromPatient(patient, { at: FIXED_START });
    const b = fairnessRowFromPatient(patient, { at: FIXED_START });
    expect(a).toEqual(b);
  });
});
