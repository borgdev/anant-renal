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

// S3 — seeding a realm from a generated population, in the order the plan gives:
// ingest, then enrich, then prime (§5, "Three steps, in this order, and the order is
// the design").
//
//   ingest  — Synthea's FHIR through the EXISTING ingest path, so the realm gets
//             real conditions and real observations rather than a second data model.
//   enrich  — the durable half: unit, age, access, vintage, and the problem list.
//             `problemList` is the one piece of state the engine never overwrites, so
//             this is where Synthea's contribution sticks for the realm's whole life.
//   prime   — the transient half: the engine's initial condition, derived from the
//             measured haemoglobin rather than from the model's default.
//
// ---------------------------------------------------------------------------
// THE IDEMPOTENCY GUARD, AND WHY IT IS NOT A RETRY
// ---------------------------------------------------------------------------
// "Re-running generation produces no duplicates" is an exit criterion, and the
// obvious way to satisfy it — re-ingest and let the upserts converge — does not work
// on this platform. `result-lab` is not an upsert: the effect reducer calls
// `graph.create('result', \`${orderId}-result\`, …)` with no existence check, and
// `EntityGraph.create` THROWS `entity-exists` when the id is taken. A second ingest of
// the same bundle therefore does not merge, it throws out of `ingestFhirBundle`
// (`ingestResource` calls `realm.emit` unguarded, and `emit` calls `apply` unguarded).
//
// So idempotency is enforced BEFORE the work, by comparing the ids this population
// would occupy against the ids already in the realm:
//
//   none exist      → fresh seed, proceed
//   all exist       → `already-seeded`; report and do nothing
//   some exist      → `partial-population`; REFUSE
//
// Refusing the partial case is the point. A realm holding half a population is a
// realm whose cohorts, denominators and chair counts are all quietly wrong, and
// neither continuing (duplicates, or a throw) nor stopping silently (a realm that
// looks seeded) is better than saying so. The operator's remedy is to drop the realm.
//
// This assumes a realm is seeded ONCE, which is how realms are used: a generated
// population is an initial condition for a world, not a stream to be appended to. A
// deployment that needs to add patients to a live realm needs the ingest's `result`
// path hardened first — recorded as a limitation, not papered over here.

import type { FhirCtx } from '../../fhir/types.js';
import { ingestFhirBundle, type IngestBundleResult } from '../../fhir/bundle-ingest.js';
import type { Realm } from '../../realm/realm.js';
import { primeDialysisState, primeEngine, type DimensionSource, type PrimedDimension } from './prime.js';
import { enrichPatient, summarisePatient, type PatientClinicalSummary } from './enrich.js';
import { applyPatientIdMap, patientIdsIn, planPatientIds } from './identity.js';
import { projectBundle, type ProjectionOptions, type ProjectionResult } from './projection.js';
import { loadPopulation } from './population.js';
import { NON_REPRODUCIBLE_LAYERS } from './digest.js';
import type { ArtifactForm } from './manifest.js';
import type { FacilityKind } from '../source.js';

export interface SeedPopulationOptions {
  readonly realmId: string;
  readonly facilityId: string;
  readonly facilityKind: FacilityKind;
  readonly facilityName: string;
  /** Unit ids to create and place patients into, in declaration order. */
  readonly units: readonly string[];
  /** Root of the RAW artifact; defaults to the generator's directory. */
  readonly root?: string;
  /** Root of the PROJECTED artifact; defaults to the committed seed directory. */
  readonly seedRoot?: string;
  /** Read `raw-fhir` or `projected` explicitly. Default: whichever exists, projected first. */
  readonly form?: ArtifactForm | 'auto';
  readonly includeDeceased?: boolean;
  /** Cap the number of patient bundles read, for a smoke run. */
  readonly limit?: number;
  readonly projection?: ProjectionOptions;
  /**
   * Seed `labs` / `lastVitals` from the population. Default true. Set false to seed
   * only the durable half, so an engine comparison can start from the model default.
   */
  readonly seedObservationState?: boolean;
  /**
   * Give the renal cohort its dialysis labs from the renal domain rather than
   * from Synthea's observations (see `EnrichOptions.dialysisLabs`). Opt-in: a
   * general population's haemoglobin is normal, so writing it onto a dialysis
   * patient asserts a measurement about the wrong thing — but turning that into
   * the default would change what every existing caller's realm means.
   */
  readonly dialysisLabs?: boolean;
}

export type SeedVerdict = 'fresh' | 'already-seeded' | 'partial-population';

export interface SeedPopulationReport {
  readonly realmId: string;
  readonly directory: string;
  readonly provenance: {
    readonly generatorVersion: string;
    readonly configHash: string;
    readonly patientDigest: string;
    readonly patientCount: number;
    readonly referenceAt: string;
    readonly nonReproducible: readonly string[];
    /**
     * Which artifact form was read. `projected` means the bundles arrived already
     * renamed and already reduced, so the seeder ingested them as-is; `raw-fhir` means
     * it projected them here.
     */
    readonly artifactForm: ArtifactForm;
  };
  readonly guard: {
    readonly verdict: SeedVerdict;
    readonly planned: number;
    readonly alreadyPresent: number;
    readonly detail: string;
  };
  readonly patients: {
    readonly seeded: number;
    readonly excludedDeceased: number;
    readonly bundlesRead: number;
  };
  readonly ingest: {
    readonly chunks: number;
    readonly applied: number;
    readonly skipped: number;
    readonly structuralUpserts: number;
    readonly effectsApplied: number;
    readonly effectsRejected: number;
    /** Distinct skip reasons, so a systematic failure is visible rather than a number. */
    readonly skipReasons: ReadonlyArray<{ reason: string; count: number }>;
  };
  readonly projection: {
    readonly inputEntries: number;
    readonly outputEntries: number;
    readonly kept: ReadonlyArray<{ resourceType: string; count: number }>;
    readonly dropped: ReadonlyArray<{ resourceType: string; count: number; reason: string }>;
    readonly filteredOut: ReadonlyArray<{ resourceType: string; count: number; reason: string }>;
    readonly retainedAway: ReadonlyArray<{ resourceType: string; count: number; reason: string }>;
  };
  readonly enrich: {
    readonly unitCounts: ReadonlyArray<{ unitId: string; patients: number }>;
    readonly problemTerms: ReadonlyArray<{ term: string; patients: number }>;
    readonly unmatchedConditions: ReadonlyArray<{ display: string; patients: number }>;
    readonly ageRange: { min: number; max: number } | null;
    readonly withoutProblems: number;
    /**
     * Patients whose graph-projected problem list disagreed with the bundle parse
     * (§8 #7). Should be ZERO.
     *
     * The graph is the source and the bundle parse is retained only to be compared
     * against it, so a non-zero count here is the single signal that distinguishes
     * "these patients have no conditions" from "the graph projection is broken" —
     * two states that are identical from every other number in this report.
     */
    readonly problemReconcileMisses: number;
  };
  readonly prime: {
    readonly engine: 'liquid' | 'absent';
    readonly seeded: number;
    readonly reason: string;
    readonly bySource: ReadonlyArray<{ source: DimensionSource; dimensions: number; patients: number }>;
    readonly noSourceDimensions: readonly string[];
    readonly saturated: ReadonlyArray<{ patient: string; detail: string }>;
  };
  readonly observations: {
    readonly withLabs: number;
    readonly withVitals: number;
    readonly newestDays: { min: number; median: number; max: number } | null;
  };
  readonly durationMs: number;
}

/** Presence ids currently in the realm, so an ingest's transient presence can be found. */
function presenceIds(realm: Realm): Set<string> {
  return new Set(realm.presences.list().map((p) => p.presenceId));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function toRows<K extends string>(map: Map<K, number>, keyName: string, valueName: string, limit?: number): Array<Record<string, string | number>> {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return (limit !== undefined ? rows.slice(0, limit) : rows).map(([k, v]) => ({ [keyName]: String(k), [valueName]: v }));
}

/** Create the facility and its units, so patients have somewhere to be admitted. */
function ensureFacility(realm: Realm, opts: SeedPopulationOptions): string[] {
  const g = realm.graph;
  const facilityUrn = g.urnFor('facility', opts.facilityId);
  if (!g.get(facilityUrn)) g.create('facility', opts.facilityId, { kind: opts.facilityKind, name: opts.facilityName });
  const unitIds: string[] = [];
  for (const u of opts.units) {
    const id = `${opts.facilityId}-${u}`;
    const urn = g.urnFor('unit', id);
    if (!g.get(urn)) {
      const rec = g.create('unit', id, { code: u, facilityId: opts.facilityId });
      g.addRelation(rec.urn, 'in-facility', facilityUrn);
    }
    unitIds.push(id);
  }
  return unitIds;
}

/**
 * Seed a realm from its generated population.
 *
 * Async because the ingest path is (`ingestFhirBundle` returns a Promise). The realm
 * must already exist and have its clock at the instant the population should be
 * admitted at — the seeder reads `realm.clock.realmAt` and never the wall clock, so a
 * seeded realm is reproducible.
 */
export async function seedRealmFromPopulation(realm: Realm, opts: SeedPopulationOptions): Promise<SeedPopulationReport> {
  const startedAt = Date.now();
  const loaded = loadPopulation(opts.realmId, {
    ...(opts.root !== undefined ? { root: opts.root } : {}),
    ...(opts.seedRoot !== undefined ? { seedRoot: opts.seedRoot } : {}),
    ...(opts.form !== undefined ? { form: opts.form } : {}),
    ...(opts.includeDeceased !== undefined ? { includeDeceased: opts.includeDeceased } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });

  // ---- identity: assign realm-scoped ids BEFORE anything is written -----------
  //
  // A `projected` artifact was already renamed when it was written, so re-planning here
  // would be a no-op that silently depends on the local ordinal sort order matching the
  // order the ordinals were assigned in. It happens to hold (zero-padded ids up to
  // `MAX_LOCAL_PATIENTS`), but relying on it would make a correctness property of the
  // ingest rest on a string-sort coincidence, so the two forms take different paths.
  const alreadyRenamed = loaded.form === 'projected';
  const planned = alreadyRenamed ? new Map<string, string>() : planPatientIds(patientIdsIn(loaded.bundles), opts.realmId);
  const plannedIds = alreadyRenamed ? patientIdsIn(loaded.bundles) : [...planned.values()];
  const present = plannedIds.filter((id) => realm.graph.get(realm.graph.urnFor('patient', id)));

  const verdict: SeedVerdict = plannedIds.length === 0
    ? 'fresh'
    : present.length === 0
      ? 'fresh'
      : present.length === plannedIds.length
        ? 'already-seeded'
        : 'partial-population';

  const provenance = {
    generatorVersion: loaded.manifest.config.generatorVersion,
    configHash: loaded.manifest.configHash,
    patientDigest: loaded.manifest.patientDigest,
    patientCount: loaded.manifest.patientCount,
    referenceAt: loaded.referenceAt.toISOString(),
    nonReproducible: NON_REPRODUCIBLE_LAYERS,
    artifactForm: loaded.form,
  };

  if (verdict === 'partial-population') {
    throw new Error(
      `partial-population: ${present.length} of ${plannedIds.length} planned patients already exist in ${opts.realmId}. ` +
      'A realm is seeded once; refusing rather than duplicating or silently continuing. Drop and recreate the realm, ' +
      `or point it at a different population directory.`,
    );
  }

  if (verdict === 'already-seeded') {
    return {
      realmId: opts.realmId,
      directory: loaded.directory,
      provenance,
      guard: { verdict, planned: plannedIds.length, alreadyPresent: present.length, detail: 'every planned patient id is already present — nothing ingested' },
      patients: { seeded: 0, excludedDeceased: loaded.deceasedExcluded.length, bundlesRead: loaded.patientsRead },
      ingest: { chunks: 0, applied: 0, skipped: 0, structuralUpserts: 0, effectsApplied: 0, effectsRejected: 0, skipReasons: [] },
      projection: { inputEntries: 0, outputEntries: 0, kept: [], dropped: [], filteredOut: [], retainedAway: [] },
      enrich: { unitCounts: [], problemTerms: [], unmatchedConditions: [], ageRange: null, withoutProblems: 0, problemReconcileMisses: 0 },
      prime: { engine: realm.trajectoryEngine === 'liquid' ? 'liquid' : 'absent', seeded: 0, reason: 'skipped — already seeded', bySource: [], noSourceDimensions: [], saturated: [] },
      observations: { withLabs: 0, withVitals: 0, newestDays: null },
      durationMs: Date.now() - startedAt,
    };
  }

  const unitIds = ensureFacility(realm, opts);

  // ---- 1. ingest -------------------------------------------------------------
  const realmAt = realm.clock.realmAt;
  const ctx: FhirCtx = {
    realmId: opts.realmId,
    facilityId: opts.facilityId,
    scopeId: opts.realmId,
    sourceId: 'synthea-population',
    // Realm time, not wall time — the platform's standing convention, and the reason
    // a seeded realm is reproducible.
    ingestedAt: realmAt.toISOString(),
  };

  const ingestTotals = { chunks: 0, applied: 0, skipped: 0, structuralUpserts: 0, effectsApplied: 0, effectsRejected: 0 };
  const skipReasons = new Map<string, number>();
  const keptTotals = new Map<string, number>();
  const droppedTotals = new Map<string, { count: number; reason: string }>();
  const filteredTotals = new Map<string, { count: number; reason: string }>();
  const retainedTotals = new Map<string, { count: number; reason: string }>();
  let inputEntries = 0;
  let outputEntries = 0;

  for (const bundle of loaded.bundles) {
    applyPatientIdMap(bundle, planned);
    // A `projected` artifact is ALREADY the output of this step — renamed and reduced —
    // so projecting it again would apply retention a second time and report the residue
    // as if it were a fresh measurement of the population. The form is recorded in the
    // manifest and resolved by the loader, so this is a read rather than a guess.
    const projected: ProjectionResult = loaded.form === 'projected'
      ? {
          chunks: [bundle],
          report: {
            kept: [],
            dropped: [],
            filteredOut: [],
            retainedAway: [],
            inputEntries: (bundle.entry ?? []).length,
            outputEntries: (bundle.entry ?? []).length,
            chunks: 1,
            perAnalyteHistory: 0,
            maxAgeDays: null,
          },
        }
      : projectBundle(bundle, opts.projection ?? {});
    inputEntries += projected.report.inputEntries;
    outputEntries += projected.report.outputEntries;
    for (const row of projected.report.kept) keptTotals.set(row.resourceType, (keptTotals.get(row.resourceType) ?? 0) + row.count);
    for (const row of projected.report.dropped) {
      const entry = droppedTotals.get(row.resourceType) ?? { count: 0, reason: row.reason };
      entry.count += row.count;
      droppedTotals.set(row.resourceType, entry);
    }
    for (const row of projected.report.filteredOut) {
      const entry = filteredTotals.get(row.resourceType) ?? { count: 0, reason: row.reason };
      entry.count += row.count;
      filteredTotals.set(row.resourceType, entry);
    }
    for (const row of projected.report.retainedAway) {
      const entry = retainedTotals.get(row.resourceType) ?? { count: 0, reason: row.reason };
      entry.count += row.count;
      retainedTotals.set(row.resourceType, entry);
    }

    for (const chunk of projected.chunks) {
      const before = presenceIds(realm);
      const result: IngestBundleResult = await ingestFhirBundle(realm, ctx, chunk, {
        presenceInit: { agentSpecId: 'population-seed', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], facilityId: opts.facilityId, unitId: unitIds[0] ?? 'U1' },
        ...(unitIds[0] ? { defaultUnitId: unitIds[0] } : {}),
      });
      // `ingestFhirBundle` spawns a presence per call and never retires it (verified:
      // it spawns at bundle-ingest.ts and there is no matching retire). Left alone, a
      // population seed would leave one stale presence per CHUNK — hundreds of them,
      // which the operator console counts and displays.
      for (const id of presenceIds(realm)) {
        if (!before.has(id)) realm.retirePresence(id);
      }
      ingestTotals.chunks++;
      ingestTotals.applied += result.applied;
      ingestTotals.skipped += result.skipped;
      ingestTotals.structuralUpserts += result.summary.structuralUpserts;
      ingestTotals.effectsApplied += result.summary.effectsApplied;
      ingestTotals.effectsRejected += result.summary.effectsRejected;
      for (const reason of result.summary.skipped) skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    }
  }

  // ---- 2 + 3. enrich and prime ----------------------------------------------
  // Summaries are computed from the (renamed) bundle rather than from the realm graph
  // because ingested `result` entities carry no patient reference — see the header of
  // `enrich.ts` for the measurement and the reasoning.
  const summaries: PatientClinicalSummary[] = [];
  for (const bundle of loaded.bundles) {
    const summary = summarisePatient(bundle, loaded.referenceAt);
    if (summary) summaries.push(summary);
  }

  const unitCounts = new Map<string, number>();
  const problemCounts = new Map<string, number>();
  const unmatchedCounts = new Map<string, number>();
  const ages: number[] = [];
  const newestDays: number[] = [];
  const primedBySource = new Map<DimensionSource, { dimensions: number; patients: Set<string> }>();
  const noSourceDimensions = new Set<string>();
  const saturated: Array<{ patient: string; detail: string }> = [];
  let withLabs = 0;
  let withVitals = 0;
  let withoutProblems = 0;
  let problemReconcileMisses = 0;
  let primedCount = 0;
  let engine: 'liquid' | 'absent' = 'absent';
  let primeReason = '';

  summaries.forEach((summary, index) => {
    const primed = primeDialysisState({
      labs: summary.labs,
      // Conditional spreads: `exactOptionalPropertyTypes` rejects assigning a
      // possibly-undefined value to an optional property, and a present-but-undefined
      // `hr` would read as "measured" to `primeDialysisState`.
      vitals: {
        ...(summary.vitals.hr !== undefined ? { hr: summary.vitals.hr } : {}),
        ...(summary.vitals.spo2 !== undefined ? { spo2: summary.vitals.spo2 } : {}),
      },
    });
    for (const d of primed.dimensions) {
      const bucket = primedBySource.get(d.source) ?? { dimensions: 0, patients: new Set<string>() };
      bucket.dimensions++;
      bucket.patients.add(summary.localPatientId);
      primedBySource.set(d.source, bucket);
      if (d.source === 'no-source') noSourceDimensions.add(d.dim);
    }
    for (const s of primed.saturated) saturated.push({ patient: summary.localPatientId, detail: s });

    const outcome = enrichPatient(realm, summary, index, primed.state, {
      facilityId: opts.facilityId,
      unitIds,
      realmAt,
      ...(opts.seedObservationState !== undefined ? { seedObservationState: opts.seedObservationState } : {}),
      ...(opts.dialysisLabs !== undefined ? { dialysisLabs: opts.dialysisLabs } : {}),
    });
    unitCounts.set(outcome.unitId, (unitCounts.get(outcome.unitId) ?? 0) + 1);
    if (outcome.age !== undefined) ages.push(outcome.age);
    // Counted from the OUTCOME, not from `summary`: the graph projection is what was
    // actually written to `state.problemList`, and a report describing the bundle
    // parse instead would be a report about a source nothing reads any more. It is
    // also the S3 lesson — the report and the written state are two independent
    // facts, and only reading both can tell them apart.
    if (outcome.problems.length === 0) withoutProblems++;
    for (const p of outcome.problems) problemCounts.set(p, (problemCounts.get(p) ?? 0) + 1);
    if (!outcome.problemsReconciled) problemReconcileMisses++;
    for (const u of summary.unmatchedConditions) unmatchedCounts.set(u, (unmatchedCounts.get(u) ?? 0) + 1);

    const primed2 = primeEngine(realm, summary.localPatientId, primed.state);
    engine = primed2.engine;
    primeReason = primed2.reason;
    if (primed2.seeded) primedCount++;

    if (Object.keys(summary.labs).length > 0) withLabs++;
    if (Object.keys(summary.vitals).length > 0) withVitals++;
    if (summary.newestObservationDays !== undefined) newestDays.push(summary.newestObservationDays);
  });

  const asReasonRows = (map: Map<string, { count: number; reason: string }>): Array<{ resourceType: string; count: number; reason: string }> =>
    [...map.entries()].map(([resourceType, v]) => ({ resourceType, count: v.count, reason: v.reason })).sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType));

  return {
    realmId: opts.realmId,
    directory: loaded.directory,
    provenance,
    guard: { verdict, planned: plannedIds.length, alreadyPresent: 0, detail: 'no planned patient id was present — ingested' },
      patients: { seeded: summaries.length, excludedDeceased: loaded.deceasedExcluded.length, bundlesRead: loaded.patientsRead },
    ingest: {
      ...ingestTotals,
      skipReasons: toRows(skipReasons, 'reason', 'count', 25) as Array<{ reason: string; count: number }>,
    },
    projection: {
      inputEntries,
      outputEntries,
      kept: [...keptTotals.entries()].map(([resourceType, count]) => ({ resourceType, count })).sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType)),
      dropped: asReasonRows(droppedTotals),
      filteredOut: asReasonRows(filteredTotals),
      retainedAway: asReasonRows(retainedTotals),
    },
    enrich: {
      unitCounts: (toRows(unitCounts, 'unitId', 'patients') as Array<{ unitId: string; patients: number }>),
      problemTerms: (toRows(problemCounts, 'term', 'patients') as Array<{ term: string; patients: number }>),
      unmatchedConditions: (toRows(unmatchedCounts, 'display', 'patients', 15) as Array<{ display: string; patients: number }>),
      ageRange: ages.length > 0 ? { min: Math.min(...ages), max: Math.max(...ages) } : null,
      withoutProblems,
      problemReconcileMisses,
    },
    prime: {
      engine,
      seeded: primedCount,
      reason: primeReason,
      bySource: [...primedBySource.entries()]
        .map(([source, v]) => ({ source, dimensions: v.dimensions, patients: v.patients.size }))
        .sort((a, b) => b.patients - a.patients || a.source.localeCompare(b.source)),
      noSourceDimensions: [...noSourceDimensions].sort(),
      saturated: saturated.slice(0, 20),
    },
    observations: {
      withLabs,
      withVitals,
      newestDays: newestDays.length > 0 ? { min: Math.min(...newestDays), median: median(newestDays), max: Math.max(...newestDays) } : null,
    },
    durationMs: Date.now() - startedAt,
  };
}

export type { PrimedDimension };
