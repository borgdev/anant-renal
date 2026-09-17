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

// The fairness screen's missing half: a row producer (S5 L0).
//
// `src/evidence/fairness.ts` declares, bands, slices and compares `FairnessRow`s —
// and nothing in the platform ever built one. `fairnessRows` was passed at 7 of 7
// call sites, all of them tests, all of them `[]`. So `fairnessReport([], ...)`
// returned `insufficient` by construction, and the screen had never been reachable,
// let alone fired.
//
// That is what this file fixes, and it is deliberately small, because every part of
// the join already existed:
//
//   * the per-patient facts — `renalPatientFacts` / `renalPatientInputs`
//   * the per-protocol status — `evaluateProtocolForPatient`
//   * the banding and comparison — `fairness.ts`
//
// Only the row was missing. That is worth stating because the temptation is to read
// "the screen cannot fire" as "the feature is large", and it was not.
//
// ---- the two booleans, and why they are derived this way -------------------
//
// `FairnessRow.covered` and `.flagged` are the protocol's own coverage gate and
// finding, read from `evaluateProtocolForPatient` rather than recomputed here:
//
//   covered  — DATA SUFFICIENCY, from the panel and the session count, not from the
//              protocol statuses. See the note below: this started as "at least one
//              protocol reached a decided status" and a probe showed that is not a
//              coverage signal at all.
//   flagged  — at least one protocol is `red`.
//
// **That `covered` derivation is the result of a probe, not a first guess.** It began
// as "at least one protocol reached a decided status", on the assumption that
// `unknown` is the coverage failure signal. Probing `renalPatientFacts({state: {}})`
// — a patient with NO data at all — showed the assumption is false:
//
//     fluid                    unknown  sev= 0
//     adequacy                 amber    sev= 0.5     <-- one notch below `red`
//     anemia                   unknown  sev= 0
//     ckd-mbd                  amber    sev= 0.3
//     nutrition-electrolytes   unknown  sev= 0
//     access                   green    sev= 0.25
//     infection                unknown  sev= 0
//
// Three of seven protocols assign a NON-ZERO severity to a patient with an empty
// state, so "some protocol decided" is true for a patient nobody has measured — and
// `covered` would have been `true` for every patient in the deployment, making the
// coverage comparison `fairness.ts` performs first a constant.
//
// `covered` therefore uses the platform's own sufficiency rule rather than a status:
// the condition `registry.ts` itself uses to decide a protocol CANNOT decide
// (`sessions.count === 0 && panel.completenessPct < 50`) negated. Reusing the stated
// rule is the point — a second, privately-invented threshold is how two definitions
// of "enough data" drift apart.
//
// The probe result is recorded here rather than only in a commit message because it is
// a finding about the PROTOCOLS, not about this file: `adequacy` reports a 0.5
// severity for a patient with no chart, which is 0.1 below `red`. That is the
// "a reading that looks stable" failure mode §5 S3 already recorded twice (the
// `hr = 72, spo2 = 97` fallback, the `Suspected ...` displays), and it is the reason a
// fairness comparison over these protocols needs `covered` filtered first.
//
// Three choices inside that:
//
//   1. **`red` only, not `amber`.** `amber` is the platform's watch band, and
//      folding it into `flagged` would make the flag comparison in `disparityReport`
//      measure "surfaced anything" instead of "surfaced a problem". The screen's
//      whole claim is about problems.
//   2. **Across ALL protocols, not the one being sliced.** The dimensions (age, sex,
//      vintage, access) are cross-cutting by design — `assuranceTrack` says so — so a
//      row is "did this patient, as the platform sees them, have a problem". A
//      per-protocol row set would need a row per patient per protocol, and the
//      dimension comparison would then be measuring protocol selection.
//   3. **`vintageYears` comes from the ENTITY STATE, not from the facts.** This was
//      the one real surprise: `RenalPatientFacts` carries `age`, `sex`, `access`,
//      `labs`, `sessions`, `panel`, `exposure` and `signals` — and no vintage. The
//      value lives on the entity as `dialysisVintageYears` (written by
//      `StaticPatientSource` and by the Synthea enricher), and `vintage` is one of
//      the four declared slice dimensions, so reading it off the state is the only
//      way to fill a dimension the screen already declares.
//
// ---- what this does NOT do -------------------------------------------------
//
// It does not serve anything. There is still no `GET /admin/swarm/assurance/fairness`
// route, so `exec-app/src/lib/assurance.ts` remains a client for an endpoint that
// does not exist. Building the rows answers "can the screen fire at all?" — which is
// S5's actual question — but not "can an operator see it fire". The route is the
// second half and is not built here.

import type { RenalPatientInput } from '../swarm/renal-cohort.js';
import { renalPatientFacts } from '../swarm/renal-cohort.js';
import { RENAL_PROTOCOLS, evaluateProtocolForPatient, type ProtocolStatus } from '../protocols/registry.js';
import { patientAge } from '../population/age.js';
import type { FairnessRow } from '../evidence/fairness.js';

/** The band that means a problem was surfaced. */
const FINDING: ProtocolStatus = 'red';

export interface FairnessRowOptions {
  /** The instant ages are derived at — the realm clock, never a wall clock. */
  readonly at: Date;
}

/**
 * One `FairnessRow` per patient, from the platform's own patient projection.
 *
 * Pure: no registry access, no storage, no clock. The caller supplies the patients
 * and the instant, so a demo and a test can produce the same rows from the same
 * inputs — which is the property the golden tests in this repo keep asking for.
 */
export function fairnessRowsFromPatients(
  patients: readonly RenalPatientInput[],
  opts: FairnessRowOptions,
): FairnessRow[] {
  return patients.map((patient) => fairnessRowFromPatient(patient, opts));
}

export function fairnessRowFromPatient(
  patient: RenalPatientInput,
  opts: FairnessRowOptions,
): FairnessRow {
  const facts = renalPatientFacts(patient);
  const statuses = RENAL_PROTOCOLS.map((p) => evaluateProtocolForPatient(p.id, facts).status);

  // Derived at the caller's instant rather than read from the stored `age` (§8 #6),
  // so a realm that has simulated three years bands its patients where they are
  // *now* rather than where the seeder found them.
  const age = patientAge(patient.state, opts.at);
  const vintage = numberOf(patient.state['dialysisVintageYears']);
  const accessType = accessTypeOf(patient.state);

  return {
    patientId: patient.id,
    // Conditionally spread, because `exactOptionalPropertyTypes` distinguishes an
    // absent key from a present `undefined` — and `fairness.ts` bands an absent value
    // into its `unknown` slice rather than silently dropping the patient.
    ...(age !== undefined ? { age } : {}),
    ...(facts.sex !== undefined ? { sex: facts.sex } : {}),
    ...(vintage !== undefined ? { vintageYears: vintage } : {}),
    ...(accessType !== undefined ? { accessType } : {}),
    covered: facts.sessions.count > 0 || facts.panel.completenessPct >= 50,
    flagged: statuses.some((s) => s === FINDING),
  };
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * The access modality, read from the entity state.
 *
 * `fairness.ts`'s `accessSlice` normalises (`avf`/fistula → `avf`, `avg`/graft →
 * `avg`, anything with `cath` → `catheter`), so the raw modality is passed through
 * rather than pre-normalised here. Normalising in two places is how the two
 * definitions of "a fistula" drift apart.
 */
function accessTypeOf(state: Record<string, unknown>): string | undefined {
  const access = state['access'];
  if (typeof access !== 'object' || access === null) return undefined;
  const type = (access as Record<string, unknown>)['type'];
  return typeof type === 'string' && type.trim() !== '' ? type : undefined;
}
