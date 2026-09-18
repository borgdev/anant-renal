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

// S3 — getting a Synthea bundle through an ingest path that will not accept it.
//
// The plan (§6.1) says "feed Synthea's FHIR through `ingestFhirBundle`, the existing
// path — NO bespoke FHIR parser". Measuring the generator's actual output shows the
// existing path refuses that input outright, and the numbers decide the design:
//
//   One Synthea patient file ............  up to 17,272 entries
//   `MAX_BUNDLE_ENTRIES` ................                    500
//   A 150-patient population ............ 235,982 entries across 19 resource types
//
// So a Synthea bundle is over the ceiling by ~34x, and ingesting the population whole
// would mean ~236,000 entries — of which 20,213 are `Claim`, 20,213 are
// `ExplanationOfBenefit` and 11,134 are `DocumentReference`, none of which any
// consumer in this platform reads.
//
// This module therefore does two things, neither of which is parsing:
//
//   1. **Projects** the bundle to the resource types the platform actually maps,
//      declared as data (`RESOURCE_PROJECTION`) so the exclusions are reviewable and
//      the report can name what was left out and why.
//   2. **Chunks** the projection into ≤`MAX_BUNDLE_ENTRIES` `collection` bundles.
//
// Chunking is safe because `applyPatientIdMap` has already rewritten every patient
// reference to `Patient/<localId>`. The ingest resolves a reference to a realm entity
// through the graph, not through the bundle index, so a chunk boundary cannot strand
// a reference. Without that rewrite, splitting the bundle would be a wrong-patient
// bug rather than an optimisation — see `identity.ts`.
//
// `collection` is the right bundle type, not `transaction`. A transaction is atomic
// and would roll the whole realm back on any single failing entry; a seeded realm is
// built incrementally, and a partial failure has to leave a realm whose partial state
// the seeder's own guard can detect on the next attempt.
//
// ---------------------------------------------------------------------------
// THE RETENTION RULE, AND WHY IT IS NOT A TIME WINDOW
// ---------------------------------------------------------------------------
// The obvious bound on a lifetime of observations is "the last N days", and on real
// Synthea output that is the wrong instrument. Measured on a 150-patient population
// (174 bundles, 24 of them deceased):
//
//   window      patients with any lab   with haemoglobin   lab observations kept
//   30 days                     6/174                3                    171
//   90 days                    24/174               12                  1,442
//  365 days                    81/174               33                  3,161
//  10 years                   159/174              158                 36,289
//
// A 90-day window — the horizon `generateLongitudinalHistory` uses, so the intuitive
// choice — leaves **86% of the population with no laboratory data at all**. Synthea
// patients are not on a monitoring schedule; they see a provider when a clinical
// module sends them, which for most of this cohort is rarely. A window does not bound
// cost so much as delete the population.
//
// The rule used instead is **the most recent N observations per (patient, analyte)**.
// It bounds cost on exactly the axis that explodes — a patient's lifetime of repeat
// testing — while guaranteeing that every patient who has EVER had a test contributes
// its latest value. Measured:
//
//   N per (patient, analyte)   observations kept   haemoglobin coverage   potassium
//   N = 1                                  6,244              174/174     33/174
//   N = 3                                 14,878              174/174     33/174
//   N = 12                                36,513              174/174     33/174
//
// N = 1 already reaches full coverage, and raising it multiplies cost with no coverage
// gain, so it is the default. The history that N > 1 buys is not what S3 needs — S3
// seeds a patient's CURRENT clinical picture, and turning a pile of observations into
// a dated *history* is S4's job (plan §4.7). The knob is exposed rather than
// hard-coded so S4 can raise it deliberately and pay the cost knowingly.
//
// What no retention rule can fix: `result-lab` in the effect reducer stamps its entity
// with the REALM CLOCK, not the observation's `effectiveDateTime`, so an ingested
// observation keeps its value and loses its clinical date. At N = 1 the chart holds
// "this patient's latest known haemoglobin, as of seed time", which is a defensible
// thing to hold — but it is not a history, and the limitation is recorded in
// `docs/synthea-population-integration.md` and in the priming notes rather than
// papered over here.

import { MAX_BUNDLE_ENTRIES } from '../../fhir/bundle-ingest.js';
import type { Bundle, FhirResource } from '../../fhir/types.js';
import { isRecognisedCondition } from './conditions.js';

/** How the platform treats one Synthea resource type. */
export interface ProjectionRule {
  readonly resourceType: string;
  /**
   * `always`     — kept for every patient, unretained.
   * `series`     — a repeat measurement series, retained per (patient, analyte).
   * `vocabulary` — kept when `conditions.ts` recognises it as a clinical problem.
   * `never`      — dropped, with the reason recorded.
   */
  readonly keep: 'always' | 'series' | 'vocabulary' | 'never';
  /** The field carrying the clinical instant, for `series` rules (newest wins). */
  readonly dateField?: string;
  /** Why this rule — read by the report and by anyone auditing the population. */
  readonly reason: string;
}

/**
 * The projection, declared.
 *
 * Every `never` here is a decision, not an oversight, and the counts are the measured
 * totals for a 150-patient population so a reader can see the size of what is being
 * left out.
 */
export const RESOURCE_PROJECTION: readonly ProjectionRule[] = Object.freeze([
  {
    resourceType: 'Patient',
    keep: 'always',
    reason: 'The subject. Without it nothing else has a chart to attach to.',
  },
  {
    resourceType: 'Condition',
    keep: 'vocabulary',
    reason:
      'The platform problem list (plan §4.5 — the one piece of state the engine never overwrites). ' +
      'Filtered to recognised clinical problems: of 5,965 conditions in the sample, the most frequent are ' +
      '"Medication review due" (1,193), "Stress" (433) and "Gingivitis" (433), none of which belong on a ' +
      'problem list. Unmatched displays are reported rather than silently dropped.',
  },
  {
    resourceType: 'Observation',
    keep: 'series',
    dateField: 'effectiveDateTime',
    reason:
      'The source of `labs` and `lastVitals` — the only engine dimensions Synthea can actually supply ' +
      '(plan §4.6). Restricted to `laboratory` and `vital-signs`; `survey`/`social-history`/`exam` ' +
      'observations are not measurements of the patient\'s physiology. Retained per (patient, analyte).',
  },
  {
    resourceType: 'MedicationRequest',
    keep: 'series',
    dateField: 'authoredOn',
    reason: 'Active medication, so the medication views are not empty. Retained per patient, newest first.',
  },

  // ---------------------------------------------------------------- excluded ---
  {
    resourceType: 'Encounter',
    keep: 'never',
    reason:
      'DELIBERATE, and the least obvious exclusion here. Synthea emits ~64 encounters per patient, and each ' +
      'one becomes an `admit-patient` or `discharge-patient` effect. Two things go wrong: it costs ~11,000 ' +
      'effects, and because a historical encounter ENDS in `finished`, the LAST one to apply leaves most ' +
      'patients `admitted: false` — the opposite of what a live dialysis realm needs. Admission state is a ' +
      'platform fact the seeder sets from the facility seed, not something to reconstruct from a lifetime of ' +
      'appointments. Losing `admit-patient.emrEpisodeId` costs nothing here: that field exists for EMR ' +
      'continuity (F3) and a generated population has no live EMR to be continuous with.',
  },
  {
    resourceType: 'Procedure',
    keep: 'never',
    reason: '28,434 entries. The access pack reads `record-access` effects, not Procedure resources; no S3 consumer.',
  },
  {
    resourceType: 'DiagnosticReport',
    keep: 'never',
    reason: '20,481 entries. A structural kind exists but nothing reads it; every constituent Observation is already ingested.',
  },
  {
    resourceType: 'Claim',
    keep: 'never',
    reason: '20,213 entries. Billing history belongs to a payer deployment and would create 20k `insurance` entities.',
  },
  {
    resourceType: 'ExplanationOfBenefit',
    keep: 'never',
    reason:
      '20,213 entries. Dropped as a payment record — but its `contained` Coverage is LIFTED first, ' +
      'because that is the only place Synthea puts the payer: measured on the pinned artifact, ZERO of ' +
      'the 28,447 Coverage resources are bundle entries, all of them are nested here. Without the lift this ' +
      'exclusion would discard the payer axis silently, and because the payer lives in `contained` a ' +
      '`Coverage` rule in this table could never fire — the loop below walks `bundle.entry` only.',
  },
  {
    resourceType: 'DocumentReference',
    keep: 'never',
    reason: '11,134 entries. Clinical notes as base64 attachments; no reader, and the payload is the bulk of the bundle size.',
  },
  {
    resourceType: 'Medication',
    keep: 'never',
    reason: '4,347 entries. The catalogue a MedicationRequest points at. Dropped because the order is made self-describing first — its `medicationReference` is resolved and inlined as `medicationCodeableConcept` in this same pass, so the code survives the exclusion. It did NOT before: the order carried a reference and no code, and every ingested order read `code: \'unknown\'`.',
  },
  {
    resourceType: 'MedicationAdministration',
    keep: 'never',
    reason: '4,347 entries. Administration during an encounter the realm does not hold.',
  },
  {
    resourceType: 'SupplyDelivery',
    keep: 'never',
    reason: '4,137 entries. Logistics.',
  },
  {
    resourceType: 'Immunization',
    keep: 'never',
    reason:
      '2,572 entries, and clinically real — omitted because the consumer does not read it. The infection ' +
      'pack\'s prevention path reads patient STATE (`immunisationHistory`), not `immunization` entities, so ' +
      'ingesting these would create 2,572 entities that no rule consults. Deriving that state is an S5 item; ' +
      'ingesting the resources first would be work with no reader.',
  },
  {
    resourceType: 'ImagingStudy',
    keep: 'never',
    reason: '787 entries. Radiotherapy/imaging history with no consumer in the current packs.',
  },
  {
    resourceType: 'CarePlan',
    keep: 'never',
    reason: '589 entries. Synthea care plans are wellness plans, and the platform owns care plans as effects (`update-care-plan`).',
  },
  {
    resourceType: 'CareTeam',
    keep: 'never',
    reason: '589 entries. Synthea populates these with its own practitioner roster, which §9.5 keeps out of the realm.',
  },
  {
    resourceType: 'AllergyIntolerance',
    keep: 'never',
    reason: '190 entries. Structural kind exists, but no pack reads allergies today.',
  },
  {
    resourceType: 'Device',
    keep: 'never',
    reason: '973 entries. Synthea devices are not vascular accesses; access is seeder-authored in `enrich.ts`.',
  },
  {
    resourceType: 'Provenance',
    keep: 'never',
    reason: '174 entries. Synthea provenance describes Synthea, not this realm.',
  },
]);

const RULES = new Map(RESOURCE_PROJECTION.map((r) => [r.resourceType, r]));

/**
 * Most recent observations kept per (patient, analyte).
 *
 * 1 is the measured optimum for seeding a current clinical picture — see the header.
 */
export const DEFAULT_PER_ANALYTE_HISTORY = 1;

/** Most recent medication requests kept per patient. */
export const DEFAULT_MAX_MEDICATIONS = 20;

/** Observation categories that are measurements of the patient, and are kept. */
export const SERIES_CATEGORIES: readonly string[] = ['laboratory', 'vital-signs'];

export interface ProjectionOptions {
  /**
   * Observations to keep per (patient, analyte). Raising this buys history, not
   * coverage — read the measurements in the header before changing it.
   */
  readonly perAnalyteHistory?: number;
  readonly maxMedications?: number;
  /**
   * Optional additional age bound. NOT applied by default: a window is the wrong
   * instrument on this data (a 90-day window empties 86% of the population), so the
   * per-analyte cap is what bounds cost. Available for a deployment that knows its
   * population is dense enough for a window to be meaningful.
   */
  readonly maxAgeDays?: number;
  /** Instant the population is current as of. Used for the optional age bound only. */
  readonly referenceAt?: Date;
  /** Categories treated as a measurement series; defaults to `SERIES_CATEGORIES`. */
  readonly seriesCategories?: readonly string[];
}

export interface ProjectionReport {
  readonly kept: ReadonlyArray<{ resourceType: string; count: number }>;
  readonly dropped: ReadonlyArray<{ resourceType: string; count: number; reason: string }>;
  /** Entries that passed the type rule but failed its category, vocabulary or age filter. */
  readonly filteredOut: ReadonlyArray<{ resourceType: string; count: number; reason: string }>;
  /** Entries removed by the retention cap, so the cost of the cap is visible. */
  readonly retainedAway: ReadonlyArray<{ resourceType: string; count: number; reason: string }>;
  readonly inputEntries: number;
  readonly outputEntries: number;
  readonly chunks: number;
  readonly perAnalyteHistory: number;
  readonly maxAgeDays: number | null;
}

export interface ProjectionResult {
  readonly chunks: Bundle[];
  readonly report: ProjectionReport;
}

/** The clinical instant a resource is dated at, per its rule. */
function resourceDate(resource: FhirResource, field: string | undefined): number | undefined {
  if (!field) return undefined;
  const raw = (resource as unknown as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

/** The classification an Observation is filed under (`laboratory`, `vital-signs`, …). */
function observationCategory(resource: FhirResource): string | undefined {
  const cat = (resource as { category?: Array<{ coding?: Array<{ code?: string }> }> }).category;
  return cat?.[0]?.coding?.[0]?.code;
}

/** The analyte an Observation measures — what retention keys on. */
function observationCode(resource: FhirResource): string {
  const coding = (resource as { code?: { coding?: Array<{ code?: string }> } }).code?.coding?.[0];
  return coding?.code ?? '(uncoded)';
}

function displayOf(resource: FhirResource): string | undefined {
  return (resource as { code?: { coding?: Array<{ display?: string }> } }).code?.coding?.[0]?.display ?? undefined;
}

/** The realm-local patient id this bundle is about, after `applyPatientIdMap`. */
function patientIdIn(bundle: Bundle): string | undefined {
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource as { resourceType?: string; id?: string } | undefined;
    if (r?.resourceType === 'Patient' && typeof r.id === 'string' && r.id) return r.id;
  }
  return undefined;
}

/**
 * The payer on the patient's NEWEST claim.
 *
 * Synthea nests a `Coverage` inside every `ExplanationOfBenefit`, and that Coverage is the
 * only place the payer appears. Two measured properties decide the rule:
 *
 *   • the Coverage has NO date of its own — the date is on the claim that contains it, so
 *     "the patient's payer" has to be defined as the payer on the newest claim. 138 of 246
 *     patients carry more than one payer across their lifetime record, so without a rule
 *     the choice would be arbitrary rather than merely inconvenient;
 *   • `payor[0]` is `{ display: 'Humana' }` — a name and no reference, and
 *     `ExplanationOfBenefit.insurer` is absent on all 28,447 claims. So the payer's
 *     identity in this data IS its name; there is no id to resolve.
 */
function payerFromClaims(bundle: Bundle): string | undefined {
  let newestAt = Number.NEGATIVE_INFINITY;
  let payer: string | undefined;
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource as
      | {
          resourceType?: string;
          created?: string;
          billablePeriod?: { start?: string };
          contained?: Array<{ resourceType?: string; payor?: Array<{ display?: string }> }>;
        }
      | undefined;
    if (r?.resourceType !== 'ExplanationOfBenefit') continue;
    const name = r.contained?.find((c) => c.resourceType === 'Coverage')?.payor?.[0]?.display;
    if (typeof name !== 'string' || name.length === 0) continue;
    const raw = r.billablePeriod?.start ?? r.created;
    const at = raw ? Date.parse(raw) : Number.NaN;
    // An undated claim is only used when nothing dated has been seen, so a NaN cannot
    // displace a real date. Both date fields are present on 100% of measured claims.
    if (payer !== undefined && !(at > newestAt)) continue;
    payer = name;
    newestAt = Number.isNaN(at) ? newestAt : at;
  }
  return payer;
}

interface RetentionGroup {
  readonly type: string;
  readonly reason: string;
  readonly cap: number;
  readonly items: Array<{ resource: FhirResource; at: number }>;
}

/**
 * Project one Synthea bundle into ≤`MAX_BUNDLE_ENTRIES`-entry `collection` bundles.
 *
 * The `Patient` is forced into the FIRST chunk (and only the first) so the patient
 * entity exists before any effect in a later chunk references it. That is not merely
 * tidy: `record-vitals` CREATES a patient when the id is unknown, so an effect that
 * reached the realm before its patient would mint a second chart under whichever id
 * the reference carried.
 */
export function projectBundle(bundle: Bundle, opts: ProjectionOptions = {}): ProjectionResult {
  const perAnalyte = Math.max(1, opts.perAnalyteHistory ?? DEFAULT_PER_ANALYTE_HISTORY);
  const maxMeds = Math.max(1, opts.maxMedications ?? DEFAULT_MAX_MEDICATIONS);
  const categories = opts.seriesCategories ?? SERIES_CATEGORIES;
  const maxAgeDays = opts.maxAgeDays;
  const cutoff = maxAgeDays !== undefined && opts.referenceAt ? opts.referenceAt.getTime() - maxAgeDays * 86_400_000 : undefined;

  const keptCounts = new Map<string, number>();
  const droppedCounts = new Map<string, { count: number; reason: string }>();
  const filteredCounts = new Map<string, { count: number; reason: string }>();
  const retainedCounts = new Map<string, { count: number; reason: string }>();

  const note = (map: Map<string, { count: number; reason: string }>, type: string, reason: string): void => {
    const entry = map.get(type) ?? { count: 0, reason };
    entry.count += 1;
    map.set(type, entry);
  };
  const keep = (type: string): void => {
    keptCounts.set(type, (keptCounts.get(type) ?? 0) + 1);
  };

  const patient: FhirResource[] = [];
  /**
   * Recognised `Condition`s, kept in full.
   *
   * A SEPARATE accumulator from `patient` and `groups` because a condition is neither
   * a singleton nor a retained series — it is a cumulative list. It exists as its own
   * array because the first version of this function incremented the `kept` counter
   * for a condition and then `continue`d without pushing it anywhere: every recognised
   * condition was discarded while the report said thousands were kept. That is the
   * failure mode this array makes impossible, and it is why
   * `tests/population-projection.test.ts` asserts on the CHUNK CONTENTS and not only on
   * the report — a report can corroborate its own bug.
   */
  // Synthea puts the drug code on a SEPARATE `Medication` resource and points at it with
  // `medicationReference`, so excluding `Medication` (see its rule below) excluded the only
  // copy of the code — every order ingested as `code: 'unknown'`. Measured on the pinned
  // artifact: 3,008 MedicationRequests, all by reference, none carrying
  // `medicationCodeableConcept`. That is what made the exclusion's own stated reason false
  // ("the order carries the drug code" — it did not), and a reason that is wrong is worse
  // than no reason, because it stops the next reader from checking.
  //
  // So the code is resolved here and inlined, which makes that sentence TRUE rather than
  // deleting it. `urn:uuid:` references are bundle-local by definition, so the catalogue
  // entry is always in this same bundle; an unresolvable reference is left alone and takes
  // the existing `'unknown'` path in `canonical.ts` rather than being papered over.
  const medicationCodes = new Map<string, { system?: string; code?: string; display?: string }>();
  for (const entry of bundle.entry ?? []) {
    const res = entry.resource as
      | { resourceType?: string; id?: string; code?: { coding?: Array<{ system?: string; code?: string; display?: string }> } }
      | undefined;
    if (!res || res.resourceType !== 'Medication') continue;
    const coding = res.code?.coding?.[0];
    if (!coding?.code) continue;
    for (const key of [res.id, entry.fullUrl]) {
      if (typeof key === 'string' && key.length > 0) medicationCodes.set(key, coding);
    }
  }

  // ---- the payer, lifted out of the payment record ---------------------------
  //
  // This is a SECOND lift, and it exists for the same reason as the drug code above: an
  // exclusion was dropping a fact a consumer reads, and the exclusion's own reason did not
  // mention it. The difference is that the payer is not merely on the far side of a
  // reference — it is on the far side of an array the projection never walks.
  //
  // Synthea puts `Coverage` in `ExplanationOfBenefit.contained`, so it is invisible to
  // both of this module's entry-level paths: the type rule (there is no entry to match) and
  // the loop below. A `Coverage` row in `RESOURCE_PROJECTION` would therefore be an inert
  // rule — it would read as implemented, change nothing, and be trusted, which is the
  // failure this file's header already catalogues twice.
  //
  // One synthesized Coverage PER PATIENT, not the 118 the claims carry. Every Coverage in
  // the pool shares the literal id `"coverage"`, so lifting them as they stand would
  // upsert them all onto a single entity and give one arbitrary patient the realm's only
  // payer. Keying on the patient makes the entity unique and the fact current.
  const payerName = payerFromClaims(bundle);
  const lifted: FhirResource[] = [];
  const subject = patientIdIn(bundle);
  if (payerName !== undefined && subject !== undefined) {
    lifted.push({
      resourceType: 'Coverage',
      id: `${subject}-coverage`,
      status: 'active',
      type: { text: payerName },
      beneficiary: { reference: `Patient/${subject}` },
      // A display, matching the source. `structuralState` reads the display only because
      // there is no reference to read — see the `insurance` branch in `canonical.ts`.
      payor: [{ display: payerName }],
    } as unknown as FhirResource);
    keep('Coverage');
  }

  const vocabulary: FhirResource[] = [];
  const groups = new Map<string, RetentionGroup>();

  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource as FhirResource | undefined;
    if (!resource || typeof resource.resourceType !== 'string') continue;
    const rule = RULES.get(resource.resourceType);
    if (!rule) {
      // An unrecognised type is reported, never silently ignored: a new Synthea
      // module would otherwise vanish without trace.
      note(droppedCounts, resource.resourceType, 'no projection rule — reported so a new Synthea module cannot vanish silently');
      continue;
    }
    if (rule.keep === 'never') {
      note(droppedCounts, resource.resourceType, rule.reason);
      continue;
    }
    if (rule.keep === 'always') {
      patient.push(resource);
      keep(resource.resourceType);
      continue;
    }
    if (rule.keep === 'vocabulary') {
      if (!isRecognisedCondition(displayOf(resource))) {
        note(filteredCounts, resource.resourceType, 'display matched no problem-vocabulary rule (see conditions.ts)');
        continue;
      }
      // A problem list is cumulative, so conditions are kept in FULL — retention
      // applies to measurement series, not to statements of what the patient has.
      vocabulary.push(resource);
      keep(resource.resourceType);
      continue;
    }

    // A drug order carries its code by REFERENCE. Inline it so the kept resource is
    // self-describing, which is what the `Medication` exclusion below assumes.
    if (resource.resourceType === 'MedicationRequest') {
      const mr = resource as { medicationCodeableConcept?: unknown; medicationReference?: { reference?: string } };
      const target = mr.medicationReference?.reference;
      if (mr.medicationCodeableConcept === undefined && typeof target === 'string') {
        const coding = medicationCodes.get(target);
        if (coding) {
          // Double cast: `resource` is narrowed to `MedicationRequest` here, which has no
          // index signature, so it does not overlap `Record<string, unknown>` directly.
          (resource as unknown as Record<string, unknown>)['medicationCodeableConcept'] = { coding: [coding] };
        }
      }
    }

    // ---- series ----
    let groupKey: string;
    let cap: number;
    let retentionReason: string;
    if (resource.resourceType === 'Observation') {
      const category = observationCategory(resource);
      if (!categories.includes(category ?? '')) {
        note(filteredCounts, resource.resourceType, `category '${category ?? '(none)'}' is not a patient measurement`);
        continue;
      }
      groupKey = `${category}|${observationCode(resource)}`;
      cap = perAnalyte;
      retentionReason = `most recent ${perAnalyte} per (patient, analyte)`;
    } else {
      groupKey = 'all';
      cap = maxMeds;
      retentionReason = `most recent ${maxMeds} per patient`;
    }
    const at = resourceDate(resource, rule.dateField);
    if (at === undefined) {
      note(filteredCounts, resource.resourceType, `no ${rule.dateField ?? 'date'}`);
      continue;
    }
    if (cutoff !== undefined && at < cutoff) {
      note(filteredCounts, resource.resourceType, `older than the ${maxAgeDays}-day age bound`);
      continue;
    }
    const key = `${resource.resourceType}|${groupKey}`;
    const group = groups.get(key) ?? { type: resource.resourceType, reason: retentionReason, cap, items: [] };
    group.items.push({ resource, at });
    groups.set(key, group);
  }

  // ---- retention: newest-first within each group, then cap -------------------
  const ordered: FhirResource[] = [];
  for (const group of groups.values()) {
    group.items.sort((a, b) => b.at - a.at);
    const keptItems = group.items.length > group.cap ? group.items.slice(0, group.cap) : group.items;
    for (const item of keptItems) {
      ordered.push(item.resource);
      keep(group.type);
    }
    if (keptItems.length < group.items.length) {
      const entry = retainedCounts.get(group.type) ?? { count: 0, reason: group.reason };
      entry.count += group.items.length - keptItems.length;
      retainedCounts.set(group.type, entry);
    }
  }

  // Ordering: Patient first (so no effect can find an unknown patient and mint a
  // second chart), then the structural group (conditions and the lifted payer), then the
  // retained series. Conditions and coverage are structural — they carry no effect — so
  // their position among themselves is free, but placing them before the series keeps a
  // chunk's structural work ahead of its effects for the same patient.
  const all: FhirResource[] = [...patient, ...vocabulary, ...lifted, ...ordered];
  const chunks = chunkResources(all, bundle.id ?? 'population');

  const asRows = (map: Map<string, { count: number; reason: string }>): Array<{ resourceType: string; count: number; reason: string }> =>
    [...map.entries()]
      .map(([resourceType, v]) => ({ resourceType, count: v.count, reason: v.reason }))
      .sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType));

  return {
    chunks,
    report: {
      kept: [...keptCounts.entries()].map(([resourceType, count]) => ({ resourceType, count })).sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType)),
      dropped: asRows(droppedCounts),
      filteredOut: asRows(filteredCounts),
      retainedAway: asRows(retainedCounts),
      inputEntries: (bundle.entry ?? []).length,
      outputEntries: all.length,
      chunks: chunks.length,
      perAnalyteHistory: perAnalyte,
      maxAgeDays: maxAgeDays ?? null,
    },
  };
}

/**
 * Split resources into `collection` bundles under the ingest's entry ceiling.
 *
 * Chunk ids are `${sourceId}-c${index}`: DISTINCT per chunk, because the ingest's
 * idempotency ledger keys on `bundle.id` and two chunks sharing an id would collide as
 * a content conflict (409) rather than dedupe. Deterministic, so re-seeding the same
 * artifact replays rather than re-applies.
 */
export function chunkResources(resources: readonly FhirResource[], sourceId: string, size = MAX_BUNDLE_ENTRIES): Bundle[] {
  const chunks: Bundle[] = [];
  for (let i = 0; i < resources.length; i += size) {
    chunks.push({
      resourceType: 'Bundle',
      type: 'collection',
      id: `${sourceId}-c${chunks.length + 1}`,
      entry: resources.slice(i, i + size).map((resource) => ({ resource })),
    });
  }
  return chunks;
}
