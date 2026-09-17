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

// Where a realm's patients come from (S1).
//
// The seeder used to be the only answer: `populateFacility` computed every
// patient inline from `array[index % array.length]`. That population is the thing
// S0…S4 replaces with a generated one, so this is the seam that lets it be
// replaced without touching the realm.
//
// The seam is in S1 and nothing else is. `StaticPatientSource` holds today's
// round-robin *unchanged*, it is the default, and a golden pins the seeded
// population to a hash taken before this file existed — because the entire
// justification for the refactor is that it changes no behaviour.
//
// What this deliberately does NOT do is generalize the *state model*. A patient's
// state bag is still whatever the source puts there, and the trajectory engine's
// vocabulary is still the platform's (see §9.1/§9.7 of
// `docs/synthea-population-integration.md`). Two constraints keep that honest:
//
//   1. the mapping from a population to the engine's event vector belongs in
//      `src/population/`, never in `src/liquid/`;
//   2. the first renal constant this layer needs *inside* `src/liquid/` is the
//      signal to stop and declare the state model properly.
//
// A declaration with one implementation is what `PLATFORM_VIEW_KINDS` was
// explicitly written to avoid, and the population work does not need it.

/**
 * A facility's kind: an OPEN vocabulary, not a closed union.
 *
 * Named here so the several places that used to re-state
 * `'dialysis' | 'primary-care' | 'urgent-care' | 'hospital'` have one declaration
 * to point at. `string` is the honest type — the reasoning is on
 * `FacilitySeed.kind`, and §9.7 step 2 of `docs/synthea-population-integration.md`
 * is why the union had to go at the same time as `problemsFor`.
 */
export type FacilityKind = string;

/**
 * A facility to seed, and how many patients to put in it.
 *
 * Declared here rather than in `sim-populator.ts` so a source can describe a
 * population without importing the thing that consumes it — the seeder imports
 * the source, so the vocabulary has to live below both. `sim-populator.ts`
 * re-exports it, so every existing importer is unaffected.
 */
export interface FacilitySeed {
  facilityId: string;
  /**
   * The facility's kind — an OPEN string, deliberately.
   *
   * This was the closed union `'dialysis' | 'primary-care' | 'urgent-care' |
   * 'hospital'`, and a population keyed off it: `problemsFor(kind, …)` asserted
   * that `kind === 'dialysis'` means ESRD. That made the union load-bearing — it
   * was the platform's case-mix claim wearing a type. S4 deletes the function, and
   * §9.7 step 2 requires the union to go in the same commit, so the closed type
   * never exists without a consumer.
   *
   * It was also already wrong. The packs declare their own vocabularies and they do
   * not intersect this union: `packs/dialysis-provider` says
   * `['outpatient-dialysis', 'home-dialysis']`; `packs/oncology-deep` says
   * `['oncology', 'infusion', 'hospital']`. A value of `'dialysis'` could never have
   * matched a pack's `appliesTo.facilityKinds`, so the closed union was a constraint
   * with no enforcer.
   *
   * The values the hand-written fixture uses are `dialysis`, `primary-care`,
   * `urgent-care`, `hospital`. A real deployment's vocabulary is its own, and
   * nothing in the population layer reads this field to decide clinical content.
   */
  kind: FacilityKind;
  name: string;
  units: string[]; // e.g. ['ICH-A','ICH-B','ICH-C'] for dialysis
  patientCount: number;
}

/** R1 — optional complete-data backfill: seed each patient's chart with a
 *  deterministic 90-day-consistent lab/vitals summary at creation. */
export interface PopulateHistoryOptions {
  seed?: number;
  days?: number;
}

/** Everything a source needs to place patients in one facility. */
export interface PatientSeedContext {
  readonly facilityId: string;
  readonly facilityKind: FacilitySeed['kind'];
  /** Unit ids, already created, in declaration order. */
  readonly unitIds: readonly string[];
  readonly patientCount: number;
  /** The realm clock instant to seed against — the source must not read a wall clock. */
  readonly realmAt: Date;
  readonly history?: PopulateHistoryOptions;
}

/**
 * One patient, ready to be written into the realm graph.
 *
 * `state` is the entity's state bag verbatim — the same object the seeder used to
 * build inline, and the same object `renalPatientInputs` hands to every specialty.
 * Keeping it as an opaque bag is deliberate: the platform does not get to know
 * what a specialty puts in it.
 */
export interface PopulatedPatient {
  readonly id: string;
  /** The unit this patient is placed in; must be one of `ctx.unitIds`. */
  readonly unitId: string;
  readonly state: Record<string, unknown>;
}

/**
 * A source of synthetic patients.
 *
 * Synchronous on purpose. A generated population (S2/S3) is read from artifacts
 * produced ahead of time, not fetched at seed time — so the async work belongs in
 * generation, and the realm-seeding path stays synchronous and testable.
 */
export interface PatientSource {
  /** Stable identifier, used in the population manifest and in logs. */
  readonly id: string;
  /** One line for a human: where this population came from. */
  readonly describe: string;
  patients(ctx: PatientSeedContext): readonly PopulatedPatient[];
}
