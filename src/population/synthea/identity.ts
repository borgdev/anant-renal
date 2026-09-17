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

// S3 — the one decision that makes Synthea ingest safe: WHICH chart a Synthea
// patient becomes.
//
// The platform already has an identity guardrail (`src/fhir/identity.ts`, F3), and
// its rule is that an inbound `Patient` must RESOLVE or the entry is refused —
// because adopting a remote id for a patient we already hold forks a second chart.
// That guardrail protects an EMR feed arriving into a realm that already has
// patients. Seeding a realm from a generated population is the opposite situation:
// the realm is EMPTY, and every patient in the bundle is new. Resolving them all
// would refuse every entry.
//
// So instead of asking the ingest to resolve, we RENAME: each Synthea patient is
// mapped to a realm-scoped id BEFORE ingest, and the ingest is left in its
// adopt-by-id mode. The rename is what makes the guardrail's precondition true —
// after it, every inbound patient id is one the realm has never seen, so
// "adopt by id" and "this is a new chart" are the same statement.
//
// THREE PROPERTIES MATTER, and each costs something:
//
//   1. **Realm-scoped, never global.** The mapping depends on the realm id, so the
//      same Synthea patient seeded into two realms becomes two different patients.
//      That is the §9.5 rule (one artifact must not seed two realms as the same
//      person) expressed in an id. No cross-realm reconciliation exists, and none
//      is wanted.
//   2. **Ordinal by sorted Synthea id, not hashed.** Re-running the GENERATOR with a
//      different seed produces a different set of Synthea ids. Hashing would then
//      allocate an entirely new set of local ids and the realm would accumulate
//      patients; ordinals land the new population on the SAME local ids, so the
//      fleet keeps its size and shape (units, chairs, cohort denominators) and a
//      re-seed patches rather than grows. The cost is real and worth naming: a
//      regeneration with a different seed REPLACES patient 0001's clinical data
//      rather than adding a stranger, so the local id identifies a *slot* in this
//      realm's population, not a durable human. Patient-level identity is the
//      manifest's `patientDigest`; see `manifest.ts`.
//   3. **Idempotent on re-run.** Same Synthea ids in, same local ids out, so
//      re-seeding a realm that already holds the population maps onto the charts
//      that exist instead of minting duplicates.

import type { Bundle, FhirResource } from '../../fhir/types.js';

/** How many patients a population artifact can hold, given a 4-digit ordinal. */
export const MAX_LOCAL_PATIENTS = 9999;

/**
 * The id prefix for a realm's patients, made safe to embed in an id.
 *
 * Realm ids contain colons (`realm:b3`), and a colon inside a patient id collides
 * with the platform's own composite-key conventions — `platform-routes.ts` uses `~`
 * in cohort work-item references precisely because a realm id contains colons, and
 * several parsers split on `:`. Sanitising here keeps a patient id usable anywhere
 * an id is used (path param, work-item id, log line) without every consumer having
 * to know where it came from.
 */
export function localPatientIdPrefix(realmId: string): string {
  const safe = realmId.replace(/[^A-Za-z0-9_-]/g, '-');
  return safe.length > 0 ? safe : 'realm';
}

/** `realmId` + ordinal → the patient id the realm will hold. Zero-padded so ids sort. */
export function localPatientId(realmId: string, ordinal: number): string {
  return `${localPatientIdPrefix(realmId)}-pt-${String(ordinal + 1).padStart(4, '0')}`;
}

/**
 * Plan the Synthea id → local id mapping for one realm.
 *
 * Sorted, so the result depends on the SET of patients and not on the order the
 * files happened to be read in — a directory listing is not a stable interface.
 */
export function planPatientIds(syntheaIds: readonly string[], realmId: string): Map<string, string> {
  const unique = [...new Set(syntheaIds)].sort();
  if (unique.length > MAX_LOCAL_PATIENTS) {
    throw new Error(
      `population-too-large: ${unique.length} patients exceeds the ${MAX_LOCAL_PATIENTS}-patient id space. ` +
      'Generate a smaller population, or widen the ordinal in localPatientId().',
    );
  }
  const map = new Map<string, string>();
  unique.forEach((id, i) => map.set(id, localPatientId(realmId, i)));
  return map;
}

/** Collect every Synthea `Patient` id in a set of bundles, in the order found. */
export function patientIdsIn(bundles: readonly Bundle[]): string[] {
  const ids: string[] = [];
  for (const bundle of bundles) {
    for (const entry of bundle.entry ?? []) {
      const r = entry.resource;
      if (r && r.resourceType === 'Patient' && typeof r.id === 'string' && r.id) ids.push(r.id);
    }
  }
  return ids;
}

/**
 * Rewrite a bundle so its patient carries the realm's local id.
 *
 * Rewrites three things and nothing else:
 *
 *   • the patient's own `id`;
 *   • a `Patient/<old>` reference → `Patient/<new>`;
 *   • a bare `urn:uuid:<old>` reference, when `<old>` is a patient in the map.
 *
 * The third is the one that is easy to leave out, and leaving it out is a
 * wrong-patient hazard rather than a cosmetic one. Synthea references a patient
 * from its observations as `urn:uuid:<uuid>`, and `resolveBundleReferences` only
 * resolves such a reference when the target is in the SAME bundle being ingested.
 * S3 splits a bundle — a Synthea patient file runs to ~17,000 entries against the
 * ingest's 500-entry ceiling — so an observation carrying `urn:uuid:<old>` can land
 * in a chunk that does not contain its patient. The reference would then survive
 * into the effect as `patientId: 'urn:uuid:…'`, and the reducer would CREATE a
 * patient under that id (`effect-reducer.ts` `record-vitals` creates when the
 * patient is absent). Rewriting to `Patient/<local>` makes every reference
 * resolvable from the realm graph, chunk or no chunk — `refId()` takes the segment
 * after the slash, so it never depends on the bundle index.
 *
 * Deliberately NOT a deep string rewrite: arbitrary string surgery would be the
 * bespoke FHIR parser §4.3 exists to avoid, and it would corrupt `valueString`
 * fields that happen to contain a uuid.
 *
 * Mutates in place — a Synthea patient bundle is megabytes and a structured clone
 * would double peak memory — and returns the number of references rewritten, so a
 * caller can assert that a patient with observations actually had them re-pointed.
 */
export function applyPatientIdMap(bundle: Bundle, map: ReadonlyMap<string, string>): number {
  let rewrites = 0;
  const URN = 'urn:uuid:';
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource as FhirResource | undefined;
    if (!resource) continue;

    if (resource.resourceType === 'Patient' && typeof resource.id === 'string') {
      const mapped = map.get(resource.id);
      if (mapped && mapped !== resource.id) {
        // `entry.fullUrl` is deliberately left alone. It is `urn:uuid:<old>`, and
        // the ref index maps a fullUrl to the resource's CURRENT id — so leaving it
        // keeps `urn:uuid:<old>` resolvable for same-chunk references while the
        // reference rewrite below covers every other case.
        resource.id = mapped;
        rewrites++;
      }
    }

    for (const ref of referenceStrings(resource)) {
      const value = ref.value;
      let local: string | undefined;
      if (value.startsWith(URN)) {
        local = map.get(value.slice(URN.length));
      } else {
        const slash = value.indexOf('/');
        if (slash > 0 && value.slice(0, slash) === 'Patient') local = map.get(value.slice(slash + 1));
      }
      if (!local) continue;
      ref.value = `Patient/${local}`;
      rewrites++;
    }
  }
  return rewrites;
}

/**
 * Every writable `reference` string in a resource, as live accessors.
 *
 * Returning accessors rather than paths keeps the mutation in `applyPatientIdMap`
 * and avoids building a path language for a job that is one field deep.
 */
function referenceStrings(node: unknown, out: Array<{ value: string }> = [], seen = new Set<object>()): Array<{ value: string }> {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node as object)) return out;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const item of node) referenceStrings(item, out, seen);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj['reference'] === 'string' && obj['reference']) {
    out.push({
      get value(): string { return obj['reference'] as string; },
      set value(v: string) { obj['reference'] = v; },
    });
  }
  for (const v of Object.values(obj)) referenceStrings(v, out, seen);
  return out;
}
