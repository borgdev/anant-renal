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

// `birthDate` is the stored fact; `age` is a read (§8 #6 of
// `docs/synthea-population-integration.md`).
//
// The platform used to store `age` — snapshotted at seed time by the round-robin and
// never revisited. That is a derived, time-dependent value being persisted as though
// it were a fact, and a realm clock runs accelerated, so a realm that has simulated
// three years holds a patient whose stored age is three years stale. `birthDate` does
// not have that property, the FHIR ingest already writes it, and `identity.ts`
// already consumes it for matching — so it is a fact the platform half-used already.
//
// Two things make the derived read safe to adopt rather than a rewrite:
//
//   * the read has a blast radius of one site (`POST /admin/realms`'s SQL mirror),
//     measured rather than assumed;
//   * every Synthea patient carries `birthDate`, so the derived path is the real one
//     and the fallback below is the exception rather than the rule.

/**
 * Whole years between a FHIR `birthDate` and an instant, or `undefined`.
 *
 * Accepts `YYYY-MM-DD` (what FHIR sends) and a full ISO instant (what a chatty
 * producer sends). Returns `undefined` for an absent or unparseable value rather than
 * `0` or `NaN`: a patient of unknown age and a newborn are different clinical facts,
 * and the fairness screen already has a distinct `unknown` band for the former. A
 * silent `0` would put every unparseable patient in the `< 55` band and read as data.
 *
 * The birthday adjustment is the whole point of not using a year subtraction: a
 * patient born 1956-12-21 is 69 on 2026-09-17 and 70 on 2026-12-21, and the
 * difference matters because the fairness screen bands at 55/65/75.
 */
export function ageFromBirthDate(birthDate: string | undefined, at: Date): number | undefined {
  if (typeof birthDate !== 'string' || birthDate.trim() === '') return undefined;
  const text = birthDate.trim();
  // A bare date is midnight UTC, so a date-only value cannot slide a day either way
  // depending on the host timezone.
  const born = new Date(text.length === 10 ? `${text}T00:00:00.000Z` : text);
  if (Number.isNaN(born.getTime())) return undefined;

  let years = at.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = at.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < born.getUTCDate())) years -= 1;
  return years >= 0 ? years : undefined;
}

/**
 * A patient's age at an instant: derived from `birthDate` when there is one, and from
 * a stored `age` when there is not.
 *
 * The fallback is not a convenience, it is a statement about which populations exist
 * today. `StaticPatientSource` has no `birthDate` — it carries ten fixed ages — and it
 * is deliberately kept as the dependency-free test path, so a strict "derive or
 * nothing" would silently report every fixture patient as age-unknown and change what
 * the fairness screen bands over in the unit suite.
 *
 * What that costs, stated rather than hidden: for a static fixture patient the
 * fallback returns a value frozen at seed time, so the drift the derivation exists to
 * remove is still present there. That is acceptable *because it is a fixture* — its
 * ages are fixed by construction and its trajectory is a test input, not a clinical
 * claim. The alternative, giving the fixture a `birthDate` derived from its age, would
 * move every hash in `tests/population-source.test.ts` to fix a drift that a fixture
 * cannot exhibit. A real deployment reads the derived path, because a Synthea patient
 * always has a birth date.
 */
export function patientAge(
  state: Record<string, unknown> | undefined,
  at: Date,
): number | undefined {
  const birthDate = state?.['birthDate'];
  const derived = ageFromBirthDate(typeof birthDate === 'string' ? birthDate : undefined, at);
  if (derived !== undefined) return derived;

  const stored = state?.['age'];
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  // A numeric string, because the entity state bag is `Record<string, unknown>` and a
  // value that arrived from JSON or a CSV column may well be one. The alternative is a
  // patient whose age silently reads as unknown because of its serialisation.
  if (typeof stored === 'string' && stored.trim() !== '') {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
