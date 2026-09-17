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

// S4 — `birthDate` is the stored fact, `age` is a read (§8 #6).
//
// The boundary cases carry this file, because the reason to derive rather than
// subtract years is the birthday. The fairness screen bands at 55/65/75, so a
// patient one day short of their 65th birthday is in a different slice from the same
// patient the next day — and a `year - year` implementation would put them in the
// same one for up to 364 days.

import { describe, expect, it } from 'vitest';
import { ageFromBirthDate, patientAge } from '../src/population/age.js';

/** The sample patient from the real 249-patient projected artifact. */
const SAMPLE_BIRTH_DATE = '1956-12-21';

describe('S4 — age derived from birthDate', () => {
  it('counts a birthday that has passed', () => {
    expect(ageFromBirthDate(SAMPLE_BIRTH_DATE, new Date('2026-09-17T00:00:00.000Z'))).toBe(69);
  });

  // The exact day. Off-by-one here is the difference between the 55-64 band and the
  // 65-74 band on one patient, for one day.
  it('counts a birthday on the day itself', () => {
    expect(ageFromBirthDate(SAMPLE_BIRTH_DATE, new Date('2026-12-21T00:00:00.000Z'))).toBe(70);
  });

  it('does not count a birthday that is one day away', () => {
    expect(ageFromBirthDate(SAMPLE_BIRTH_DATE, new Date('2026-12-20T00:00:00.000Z'))).toBe(69);
  });

  // A plain year subtraction gets this wrong for most of the year, which is why the
  // naive implementation is worth a dedicated assertion rather than being implied.
  it('is not a year subtraction', () => {
    const at = new Date('2026-01-05T00:00:00.000Z');
    expect(ageFromBirthDate(SAMPLE_BIRTH_DATE, at)).toBe(69);
    // 2026 - 1956 = 70, and the patient does not turn 70 until December.
    expect(ageFromBirthDate(SAMPLE_BIRTH_DATE, at)).not.toBe(70);
  });

  it('accepts a full instant as well as a bare date', () => {
    expect(ageFromBirthDate('1956-12-21T08:30:00.000Z', new Date('2026-09-17T00:00:00.000Z'))).toBe(69);
  });

  // `undefined`, never `0` and never `NaN`. A silent `0` would band every patient with
  // a missing or unreadable birth date into `< 55`, which reads as data — and the
  // fairness screen has an `unknown` band precisely so that gap can be named instead.
  it('returns nothing rather than zero for an absent or unreadable value', () => {
    const at = new Date('2026-09-17T00:00:00.000Z');
    for (const bad of [undefined, '', '   ', 'not-a-date', '2026-13-45']) {
      expect(ageFromBirthDate(bad, at), String(bad)).toBeUndefined();
    }
  });

  // A birth date in the future is not a negative age; it is a value the platform
  // cannot use.
  it('returns nothing for a birth date after the instant', () => {
    expect(ageFromBirthDate('2030-01-01', new Date('2026-09-17T00:00:00.000Z'))).toBeUndefined();
  });
});

describe('S4 — patientAge prefers the fact and falls back to the snapshot', () => {
  const at = new Date('2026-09-17T00:00:00.000Z');

  // The decision in one assertion. An ingested patient carries BOTH: `enrichPatient`
  // wrote a seeded `age`, and the ingest wrote `birthDate`. The derived value is the
  // one that does not go stale, so it wins even when a stored value disagrees — here
  // the stored one is deliberately wrong to prove it is not being read.
  it('derives from birthDate even when a stored age disagrees', () => {
    expect(patientAge({ birthDate: SAMPLE_BIRTH_DATE, age: 12 }, at)).toBe(69);
  });

  // The static fixture's case, and the reason the fallback exists at all: it carries
  // ten fixed ages and no birth dates, and it is deliberately kept as the
  // dependency-free test path.
  it('falls back to a stored age when there is no birth date', () => {
    expect(patientAge({ age: 71 }, at)).toBe(71);
  });

  it('reads a stored age that arrived as a string', () => {
    expect(patientAge({ age: '71' }, at)).toBe(71);
  });

  it('falls back when the birth date is present but unusable', () => {
    expect(patientAge({ birthDate: 'garbage', age: 71 }, at)).toBe(71);
  });

  it('returns nothing for an entity carrying neither', () => {
    expect(patientAge(undefined, at)).toBeUndefined();
    expect(patientAge({}, at)).toBeUndefined();
    expect(patientAge({ age: 'unknown' }, at)).toBeUndefined();
  });

  // The realm clock is a parameter, not a wall clock. If the derivation ever reached
  // for `new Date()`, a patient's age would change between two calls at the same
  // realm instant — and every claim in this file would be measuring the host machine.
  it('is a function of the instant it is given, not of now', () => {
    const state = { birthDate: SAMPLE_BIRTH_DATE };
    expect(patientAge(state, new Date('2026-09-17T00:00:00.000Z'))).toBe(69);
    expect(patientAge(state, new Date('2026-12-21T00:00:00.000Z'))).toBe(70);
  });
});
