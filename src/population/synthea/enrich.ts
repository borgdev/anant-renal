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

// S3, step 2 — completing an ingested patient into the renal shape.
//
// Ingest gives a patient what Synthea knows: name, sex, birth date, an MRN, their
// conditions, and their observations. It does not give them a RENAL shape — a unit,
// an access, a dialysis vintage, an admission — because those are facts about this
// realm rather than about a Synthea patient. Plan §4.6 is explicit that they stay
// seeder-authored here.
//
// ---------------------------------------------------------------------------
// WHY THIS READS THE BUNDLE AND NOT THE REALM GRAPH
// ---------------------------------------------------------------------------
// The obvious implementation reads the ingested entities back out of the graph:
// `graph.listKind('condition')` for the problem list, `graph.listKind('result')` for
// the labs. That does not work, for a reason worth stating because it is a real
// limitation of the ingest path rather than of this module.
//
// `result-lab` in the effect reducer creates a `result` entity carrying
// `{ code, value, unit, abnormal, orderId, at }` — **and no patient**. The link to a
// patient exists only through an `order` entity (`addRelation(result, 'of-order',
// order)`), and an `order` only exists if an `order-lab` effect was emitted first,
// which happens for a `ServiceRequest` and not for an `Observation`. Synthea sends
// its labs as bare `Observation`s with no `basedOn`, so `orderId` falls back to
// `result:<observation-id>` (`canonical.ts`), no order entity is ever created, and
// the result is written **orphaned** — present in the realm, attributable to nobody.
//
// So the clinical summary here is computed from the projected bundle, which is the
// authoritative source and still in hand, and the graph is only WRITTEN to. That also
// keeps `summarisePatient` pure, so the interesting part is testable without a realm.
//
// The orphan is recorded as a limitation in `docs/synthea-population-integration.md`
// rather than fixed here: carrying `patientId` on the `result-lab` effect is a
// platform change (it touches `WorldEffect`, the reducer and every producer), and it
// is not needed for S3 to seed the state correctly.

import { codeFor } from '../../fhir/code-registry.js';
import type { Bundle, FhirResource } from '../../fhir/types.js';
import { trajectoryLabel } from '../../liquid/project.js';
import type { DialysisLabs, DialysisState } from '../../liquid/types.js';
import type { Realm } from '../../realm/realm.js';
import { problemListFromConditions } from './conditions.js';

/**
 * Lab analyte → platform lab key, taken from the FHIR code registry rather than
 * restated here.
 *
 * `codeFor` is the repository's verified terminology surface: every entry it returns
 * carries `fidelity: 'verified'` and names the service and date it was checked
 * against. Writing `'718-7'` into this file instead would be the same kind of
 * plausible-looking literal that `src/ontology/seeds.ts` got wrong seven times.
 */
export const LAB_CODE_TO_KEY: Readonly<Record<string, keyof DialysisLabs>> = Object.freeze({
  [codeFor('lab', 'K').code]: 'K',
  [codeFor('lab', 'HGB').code]: 'HGB',
  [codeFor('lab', 'PHOS').code]: 'PHOS',
  [codeFor('lab', 'URR').code]: 'URR',
});

/**
 * Vital-sign code → platform vital key.
 *
 * Same sourcing, with ONE measured alias. Synthea emits its blood pressure panel as
 * LOINC `85354-9` (2,301 occurrences in the measured sample) while the registry —
 * and the ingest's own `eventToEffects` map — recognise `55284-4`. Both are
 * "blood pressure systolic and diastolic" panels carrying the same
 * `8480-6`/`8462-4` components, so they map to the same key. The alias is declared
 * rather than added to the registry because it is a property of what THIS GENERATOR
 * emits, not a new terminology claim.
 */
export const VITAL_CODE_TO_KEY: Readonly<Record<string, 'hr' | 'spo2' | 'temp' | 'rr' | 'bp' | 'systolic' | 'diastolic'>> = Object.freeze({
  [codeFor('vital', 'hr').code]: 'hr',
  [codeFor('vital', 'spo2').code]: 'spo2',
  [codeFor('vital', 'temp').code]: 'temp',
  [codeFor('vital', 'rr').code]: 'rr',
  [codeFor('vital', 'bp').code]: 'bp',
  [codeFor('vital', 'bp-systolic').code]: 'systolic',
  [codeFor('vital', 'bp-diastolic').code]: 'diastolic',
  '85354-9': 'bp',
});

/** Synthea's blood pressure panel code, measured from generated output. */
export const SYNTHEA_BP_PANEL = '85354-9';

export interface PatientVitals {
  readonly hr?: number;
  readonly spo2?: number;
  readonly temp?: number;
  readonly rr?: number;
  /** `systolic/diastolic`, as the platform's `lastVitals.bp` string. */
  readonly bp?: string;
}

/**
 * Everything Synthea can tell us about one patient, in platform vocabulary.
 *
 * `unmatchedConditions` is carried rather than counted because a specialty that is
 * thin in a population needs to know WHY it is thin: an unrecognised display is a
 * vocabulary gap, and a recognised one that is merely rare is a population fact.
 */
export interface PatientClinicalSummary {
  readonly localPatientId: string;
  readonly syntheaPatientId: string;
  readonly sex?: string;
  readonly birthDate?: string;
  /** Platform problem terms, deduplicated and in vocabulary order. */
  readonly problems: readonly string[];
  /** Displays that produced a problem term, for auditing the mapping. */
  readonly matchedConditions: readonly string[];
  /** Displays that matched nothing, for reporting coverage gaps. */
  readonly unmatchedConditions: readonly string[];
  /** Most recent value per analyte. A partial bag — Synthea rarely measures phosphate. */
  readonly labs: Partial<DialysisLabs>;
  readonly vitals: PatientVitals;
  readonly labObservations: number;
  readonly vitalObservations: number;
  /** Days between the newest observation and the reference instant. */
  readonly newestObservationDays?: number;
}

function observationCategory(resource: FhirResource): string | undefined {
  const cat = (resource as { category?: Array<{ coding?: Array<{ code?: string }> }> }).category;
  return cat?.[0]?.coding?.[0]?.code;
}

function codingCode(resource: FhirResource): string | undefined {
  return (resource as { code?: { coding?: Array<{ code?: string }> } }).code?.coding?.[0]?.code;
}

function displayOf(resource: FhirResource): string | undefined {
  return (resource as { code?: { coding?: Array<{ display?: string }> } }).code?.coding?.[0]?.display ?? undefined;
}

/** `systolic/diastolic` from a BP panel's components, when both are present. */
function bloodPressureOf(resource: FhirResource): string | undefined {
  const components = (resource as { component?: Array<{ code?: { coding?: Array<{ code?: string }> }; valueQuantity?: { value?: number } }> }).component;
  if (!components) return undefined;
  let systolic: number | undefined;
  let diastolic: number | undefined;
  for (const c of components) {
    const code = c.code?.coding?.[0]?.code;
    const value = c.valueQuantity?.value;
    if (typeof value !== 'number') continue;
    if (code === codeFor('vital', 'bp-systolic').code) systolic = value;
    if (code === codeFor('vital', 'bp-diastolic').code) diastolic = value;
  }
  return systolic !== undefined && diastolic !== undefined ? `${Math.round(systolic)}/${Math.round(diastolic)}` : undefined;
}

/**
 * Summarise one patient from their (already projected and renamed) bundle.
 *
 * Synthea writes one patient per file, so the bundle is the boundary. The patient is
 * identified by the SINGLE `Patient` resource present — not by a parameter — because
 * a caller that passed a mismatched id would silently attach one patient's
 * observations to another's chart.
 */
export function summarisePatient(bundle: Bundle, referenceAt: Date): PatientClinicalSummary | undefined {
  const entries = bundle.entry ?? [];
  const patient = entries.map((e) => e.resource).find((r): r is FhirResource => r?.resourceType === 'Patient');
  if (!patient || typeof patient.id !== 'string' || !patient.id) return undefined;

  const displays: string[] = [];
  const latestLab = new Map<keyof DialysisLabs, { value: number; at: number }>();
  const latestVital = new Map<string, { value: number | string; at: number }>();
  let labObservations = 0;
  let vitalObservations = 0;
  let newest = -Infinity;

  for (const entry of entries) {
    const resource = entry.resource;
    if (!resource) continue;
    if (resource.resourceType === 'Condition') {
      const d = displayOf(resource);
      if (d) displays.push(d);
      continue;
    }
    if (resource.resourceType !== 'Observation') continue;
    const category = observationCategory(resource);
    const code = codingCode(resource);
    if (!code) continue;
    const at = Date.parse((resource as { effectiveDateTime?: string }).effectiveDateTime ?? '');
    const when = Number.isNaN(at) ? 0 : at;
    if (when > newest) newest = when;

    if (category === 'laboratory') {
      labObservations++;
      const key = LAB_CODE_TO_KEY[code];
      const value = (resource as { valueQuantity?: { value?: number } }).valueQuantity?.value;
      if (!key || typeof value !== 'number') continue;
      const prev = latestLab.get(key);
      if (!prev || when > prev.at) latestLab.set(key, { value, at: when });
      continue;
    }
    if (category === 'vital-signs') {
      vitalObservations++;
      const key = VITAL_CODE_TO_KEY[code];
      if (!key) continue;
      if (key === 'bp' || key === 'systolic' || key === 'diastolic') {
        const bp = bloodPressureOf(resource);
        if (bp) {
          const prev = latestVital.get('bp');
          if (!prev || when > (prev.at as number)) latestVital.set('bp', { value: bp, at: when });
        }
        continue;
      }
      const value = (resource as { valueQuantity?: { value?: number } }).valueQuantity?.value;
      if (typeof value !== 'number') continue;
      const prev = latestVital.get(key);
      if (!prev || when > (prev.at as number)) latestVital.set(key, { value, at: when });
    }
  }

  const list = problemListFromConditions(displays);
  const labs: Partial<DialysisLabs> = {};
  for (const [key, entry] of latestLab) labs[key] = entry.value;

  const vitals: { hr?: number; spo2?: number; temp?: number; rr?: number; bp?: string } = {};
  const hr = latestVital.get('hr');
  const spo2 = latestVital.get('spo2');
  const temp = latestVital.get('temp');
  const rr = latestVital.get('rr');
  const bp = latestVital.get('bp');
  if (hr && typeof hr.value === 'number') vitals.hr = hr.value;
  if (spo2 && typeof spo2.value === 'number') vitals.spo2 = spo2.value;
  if (temp && typeof temp.value === 'number') vitals.temp = temp.value;
  if (rr && typeof rr.value === 'number') vitals.rr = rr.value;
  if (bp && typeof bp.value === 'string') vitals.bp = bp.value;

  return {
    localPatientId: patient.id,
    syntheaPatientId: patient.id,
    ...((patient as { gender?: string }).gender ? { sex: (patient as { gender?: string }).gender } : {}),
    ...((patient as { birthDate?: string }).birthDate ? { birthDate: (patient as { birthDate?: string }).birthDate } : {}),
    problems: list.problems,
    matchedConditions: list.matched.map((m) => m.display),
    unmatchedConditions: list.unmatched.map((u) => u.display),
    labs,
    vitals,
    labObservations,
    vitalObservations,
    ...(Number.isFinite(newest) ? { newestObservationDays: Math.round((referenceAt.getTime() - newest) / 86_400_000) } : {}),
  };
}

/** Age in whole years at a given instant, from a FHIR `date`. */
export function ageAt(birthDate: string | undefined, at: Date): number | undefined {
  if (!birthDate) return undefined;
  const born = Date.parse(birthDate);
  if (Number.isNaN(born)) return undefined;
  const years = (at.getTime() - born) / (365.25 * 86_400_000);
  return years >= 0 && years < 130 ? Math.floor(years) : undefined;
}

/** Access modalities, cycled deterministically — seeder-authored, see the header. */
const ACCESS_TYPES = ['avf', 'avf', 'avg', 'catheter'] as const;
const ACCESS_SITES = ['left-forearm', 'right-forearm', 'left-upper-arm'] as const;

export interface EnrichOptions {
  readonly facilityId: string;
  readonly unitIds: readonly string[];
  /** Realm instant the patient is admitted at. */
  readonly realmAt: Date;
  /**
   * Whether to seed `labs` and `lastVitals` on the patient.
   *
   * True for a Synthea population. It exists so a caller can seed the durable half
   * (problems, unit, vintage) WITHOUT asserting an initial clinical measurement —
   * useful for comparing a seeded engine against the static path.
   */
  readonly seedObservationState?: boolean;
}

export interface EnrichOutcome {
  readonly unitId: string;
  readonly age?: number;
  readonly problems: readonly string[];
  readonly trajectory: string;
  /** True when the patient already carried the values written here (a re-run). */
  readonly alreadyEnriched: boolean;
  /**
   * Did the graph projection agree with the bundle parse (§8 #7)?
   *
   * The graph is now the SOURCE — the bundle list is computed only to be compared
   * against it, and this flag is the comparison's result. A `false` here is the one
   * signal that distinguishes "this patient has no conditions" from "the graph
   * projection is broken", which otherwise look identical from `problems` alone.
   */
  readonly problemsReconciled: boolean;
}

/**
 * A patient's problem list, projected from the graph's `condition` entities (§8 #7).
 *
 * This is the destination the plan names: one source instead of two, and the entity
 * carries `onset` — which the flat `string[]` discards, and which is what a cohort
 * needs to say "newly diagnosed" rather than "has ever had".
 *
 * It works where the LABS version of the same idea does not, and the difference is
 * worth stating because the file's header comment over-generalises it: a `result`
 * entity has no `patientId` (a bare `Observation` never produces an `order` to link
 * through), so labs cannot be walked back from the graph. A `condition` entity DOES
 * carry one — `canonical.ts` writes `patientId: refId(c.subject)` — so conditions can.
 */
export function problemListFromGraph(realm: Realm, patientId: string): readonly string[] {
  const displays: (string | undefined)[] = [];
  for (const rec of realm.graph.listKind('condition')) {
    const st = rec.state as { patientId?: unknown; display?: unknown };
    if (st.patientId !== patientId) continue;
    displays.push(typeof st.display === 'string' ? st.display : undefined);
  }
  // `.problems` only. The result also carries `unmatched` and `matched`, which the
  // seed report aggregates separately — a projection that returned the whole object
  // would put a struct into `state.problemList`, and every cohort reads a string[].
  return problemListFromConditions(displays).problems;
}

/** Set equality, order-insensitive. The two sources do not share an insertion order. */
function sameProblemSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((term) => seen.has(term));
}

/**
 * Write the renal shape onto an ingested patient.
 *
 * Idempotent by construction, which matters because the seeder's partial-failure
 * guard may leave a realm that a later run re-enriches:
 *
 *   • every scalar goes through `graph.patch`, which merges;
 *   • the unit relation is added only when absent — `EntityGraph.addRelation` does
 *     NOT deduplicate (`rec.relations[rel].push(target)`), so an unguarded
 *     re-enrichment would accumulate a duplicate `in-unit` edge per run.
 */
export function enrichPatient(
  realm: Realm,
  summary: PatientClinicalSummary,
  index: number,
  state: DialysisState,
  opts: EnrichOptions,
): EnrichOutcome {
  const g = realm.graph;
  const urn = g.urnFor('patient', summary.localPatientId);
  const rec = g.get(urn);
  if (!rec) throw new Error(`enrich-target-missing: patient ${summary.localPatientId} is not in the realm`);

  const unitId = opts.unitIds.length > 0 ? opts.unitIds[index % opts.unitIds.length]! : `${opts.facilityId}-U1`;
  const age = ageAt(summary.birthDate, opts.realmAt);
  const existing = (rec.state ?? {}) as { access?: unknown; problemList?: unknown; dialysisVintageYears?: unknown };

  // Vintage and access are seeder-authored: Synthea has no concept of either
  // (plan §4.6). Deterministic on the patient's index so a re-seed is stable.
  const vintage = Math.round((0.5 + ((index * 1.7) % 13)) * 10) / 10;
  const access = {
    type: ACCESS_TYPES[index % ACCESS_TYPES.length]!,
    site: ACCESS_SITES[index % ACCESS_SITES.length]!,
    ageDays: 120 + ((index * 37) % 900),
    events: [],
  };

  // §8 #7 — the GRAPH is the source; the bundle parse is a reconciliation, not a
  // fallback.
  //
  // `fromBundle` is computed for exactly one reason: to be compared. `problems` is
  // the graph's projection regardless of whether they agree, because falling back on
  // a mismatch would make the two sources indistinguishable in the one case that
  // matters — and a silent fallback is how "the graph projection is broken" becomes
  // invisible. What surfaces the divergence instead is `problemsReconciled`, which
  // `seed.ts` aggregates into the seed report.
  //
  // This is the S3 lesson applied to the one step that can empty every cohort: a
  // report that reads only one of two independent facts cannot tell a working
  // projection from one that discards everything.
  const fromGraph = problemListFromGraph(realm, summary.localPatientId);
  const fromBundle = summary.problems;
  const problems = fromGraph;
  const problemsReconciled = sameProblemSet(fromGraph, fromBundle);

  const patch: Record<string, unknown> = {
    admitted: true,
    facilityId: opts.facilityId,
    unitId,
    admittedAt: opts.realmAt.toISOString(),
    dialysisVintageYears: existing.dialysisVintageYears ?? vintage,
    access: existing.access ?? access,
    sessions: [],
    accessObservations: [],
    accessAcoustic: [],
    // THE durable half. Never overwritten by the engine (§4.5), so this is what
    // decides which specialties the patient belongs to for as long as the realm runs.
    //
    // §8 #7 — projected from the graph's `condition` entities, not from a second parse
    // of the bundle. `problems` below is still derived from the bundle and is used for
    // ONE thing: confirming the two agree. It is not a fallback.
    problemList: problems,
    trajectory: trajectoryLabel(state),
  };
  if (age !== undefined) patch['age'] = age;
  if (opts.seedObservationState !== false) {
    if (Object.keys(summary.labs).length > 0) patch['labs'] = summary.labs;
    if (Object.keys(summary.vitals).length > 0) patch['lastVitals'] = { ...summary.vitals, at: opts.realmAt.toISOString() };
  }

  g.patch(urn, patch, 'population:synthea-enrich');

  // Guarded relation add — see the note above about `addRelation` not deduplicating.
  const unitUrn = g.urnFor('unit', unitId);
  if (g.get(unitUrn)) {
    const current = rec.relations['in-unit'] ?? [];
    if (!current.includes(unitUrn)) g.addRelation(urn, 'in-unit', unitUrn);
  }

  return {
    unitId,
    ...(age !== undefined ? { age } : {}),
    problems,
    trajectory: trajectoryLabel(state),
    alreadyEnriched: existing.access !== undefined && existing.problemList !== undefined,
    problemsReconciled,
  };
}
