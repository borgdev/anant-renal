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

// The ASYNC seeding seam (S4).
//
// S1 built `PatientSource` and deliberately kept it synchronous — a generated
// population is read from artifacts produced ahead of time, so the async work
// belongs in generation and the realm-seeding path stays testable. That holds for
// the static source and does NOT hold for Synthea, because seeding a generated
// population is not "pick some patients": it is ingest → enrich → prime, where
// ingest goes through `ingestFhirBundle` and prime forks the trajectory engine.
// There is no honest synchronous version of that.
//
// So there are two seams, and they are different shapes on purpose:
//
//   `PatientSource`  (sync)  — the STATIC path. `populateFacility` creates the
//                              patients. Kept as-is, because the unit suite
//                              depends on it and it needs no artifact.
//   `PopulationSeeder` (async) — the REALM path. The seeder owns the whole
//                              facility, because for a generated population the
//                              facility is not created by us and the patients are
//                              not ours to mint.
//
// Widening `PatientSource` to async was the alternative and was rejected: it would
// push `await` into `populateFacility`, and therefore into every test that seeds a
// realm, to buy nothing for the static path. The two paths have genuinely different
// contracts, so they get genuinely different seams.
//
// What this file does NOT do is decide *which* seeder a deployment uses. That is the
// caller's, and today it is the presence of a `population` block in the request
// (§8 #4, "opt-in, per realm") — static stays the default.

import type { FacilityKind } from './source.js';
import type { FacilitySeed, PopulateHistoryOptions } from './source.js';
import type { Realm } from '../realm/realm.js';
import { populateFacility } from '../realm/sim-populator.js';
import { seedRealmFromPopulation, type SeedPopulationReport } from './synthea/seed.js';

/**
 * The facility kind assumed when a request does not name one.
 *
 * Named rather than inlined because it was written as a bare `?? 'dialysis'` in two
 * places, and a default written twice is a default that can drift.
 */
export const DEFAULT_FACILITY_KIND: FacilityKind = 'dialysis';

/**
 * Where a generated population's artifact lives, and how much of it to read.
 *
 * Deliberately NOT the whole of `SeedPopulationOptions`: `form` and `seedRoot` are
 * absent because no route accepts them. A request that could name an artifact form
 * would be able to point the seeder at raw FHIR in production, which §8 #2 decided
 * against — the committed form is projected, and letting a caller override that is a
 * footgun rather than a feature. They stay settable in-process for tests.
 */
export interface PopulationArtifactSpec {
  /** Root of the committed artifact. Defaults to the configured seed directory. */
  readonly root?: string;
  /** Cap the patient bundles read, for a smoke run. */
  readonly limit?: number;
  readonly includeDeceased?: boolean;
  /**
   * Seed `labs` / `lastVitals` from the population. Default true. Set false to seed
   * only the durable half, so an engine comparison can start from the model default.
   */
  readonly seedObservationState?: boolean;
}

/** Everything a seeder needs to stand up one facility inside a realm. */
export interface SeederRequest {
  readonly facilityId: string;
  readonly facilityKind?: FacilityKind;
  readonly facilityName?: string;
  /** Unit codes, in declaration order. */
  readonly units: readonly string[];
  /**
   * Required by the static seeder, ignored by the population seeder.
   *
   * A generated population counts its own patients, so a request that names a
   * `population` source has nothing meaningful to put here. Optional rather than
   * required so one request shape serves both, with the static seeder failing loudly
   * when the count is missing instead of defaulting to a number nobody chose.
   */
  readonly patientCount?: number;
  /** Static path only: seed a deterministic 90-day lab/vitals history at creation. */
  readonly history?: PopulateHistoryOptions;
  /** Population path only. */
  readonly artifact?: PopulationArtifactSpec;
}

/** What every seeder returns, so a caller can stay agnostic about which ran. */
export interface SeedOutcome {
  readonly seederId: string;
  readonly facilityId: string;
  readonly unitIds: readonly string[];
  readonly patientIds: readonly string[];
  /**
   * The population seeder's full report — ingest counts, projection retained,
   * enrichment terms, priming sources. Absent for the static seeder, which has
   * nothing to report because nothing was interpreted.
   */
  readonly report?: SeedPopulationReport;
}

/**
 * A seeder stands up a whole facility: the facility, its units, and its patients.
 *
 * Async for both implementations even though one of them is synchronous internally.
 * A seam whose signature depended on which side you were on would not be a seam, and
 * the callers that matter (`POST /admin/realms`, realm restore) are async already.
 */
export interface PopulationSeeder {
  readonly id: string;
  readonly describe: string;
  seed(realm: Realm, request: SeederRequest): Promise<SeedOutcome>;
}

/** Thrown when the static seeder is asked to run without a patient count. */
export class MissingPatientCountError extends Error {
  constructor(facilityId: string) {
    super(
      `the static seeder needs patientCount for facility '${facilityId}': a generated ` +
      'population counts its own patients, the static round-robin cannot invent one.',
    );
    this.name = 'MissingPatientCountError';
  }
}

/**
 * The static path, behind the async interface.
 *
 * Wraps `populateFacility` — unchanged, still the default, still dependency-free.
 * This is the same call the route made before the seam existed, so a realm created
 * without a `population` block behaves exactly as it did.
 */
export const StaticPopulationSeeder: PopulationSeeder = {
  id: 'static',
  describe: 'Hand-written round-robin over fixed arrays (no generator, no install)',

  async seed(realm: Realm, request: SeederRequest): Promise<SeedOutcome> {
    if (request.patientCount === undefined) throw new MissingPatientCountError(request.facilityId);

    const facility: FacilitySeed = {
      facilityId: request.facilityId,
      kind: request.facilityKind ?? DEFAULT_FACILITY_KIND,
      name: request.facilityName ?? request.facilityId,
      units: [...request.units],
      patientCount: request.patientCount,
    };

    const out = populateFacility(
      realm,
      facility,
      request.history,
    );

    return {
      seederId: StaticPopulationSeeder.id,
      facilityId: out.facilityId,
      unitIds: out.unitIds,
      patientIds: out.patientIds,
    };
  },
};

/**
 * The generated-population path, behind the same interface.
 *
 * Wraps S3's `seedRealmFromPopulation` — ingest → enrich → prime — applying the
 * defaults the two call sites used to apply themselves.
 */
export const SyntheaPopulationSeeder: PopulationSeeder = {
  id: 'synthea',
  describe: 'Generated population read from a committed projected artifact',

  async seed(realm: Realm, request: SeederRequest): Promise<SeedOutcome> {
    const artifact = request.artifact ?? {};
    const facilityKind = request.facilityKind ?? DEFAULT_FACILITY_KIND;

    const report = await seedRealmFromPopulation(realm, {
      realmId: realm.id,
      facilityId: request.facilityId,
      facilityKind,
      facilityName: request.facilityName ?? request.facilityId,
      units: request.units,
      ...(artifact.root !== undefined ? { root: artifact.root } : {}),
      ...(artifact.limit !== undefined ? { limit: artifact.limit } : {}),
      ...(artifact.includeDeceased !== undefined
        ? { includeDeceased: artifact.includeDeceased }
        : {}),
      ...(artifact.seedObservationState !== undefined
        ? { seedObservationState: artifact.seedObservationState }
        : {}),
    });

    return {
      seederId: SyntheaPopulationSeeder.id,
      facilityId: request.facilityId,
      unitIds: [...request.units].map((u) => `${request.facilityId}-${u}`),
      patientIds: [],
      report,
    };
  },
};

/** Both seeders, keyed by id, for a caller that stores the choice. */
export const POPULATION_SEEDERS: Readonly<Record<string, PopulationSeeder>> = Object.freeze({
  [StaticPopulationSeeder.id]: StaticPopulationSeeder,
  [SyntheaPopulationSeeder.id]: SyntheaPopulationSeeder,
});

export function seederById(id: string): PopulationSeeder {
  const found = POPULATION_SEEDERS[id];
  if (!found) {
    throw new Error(
      `unknown seeder '${id}': known are ${Object.keys(POPULATION_SEEDERS).join(', ')}`,
    );
  }
  return found;
}

/** The shape a route payload or a persisted realm spec arrives in. */
export interface SeederPayload {
  readonly facilityId: string;
  readonly facilityKind?: string;
  readonly facilityName?: string;
  readonly units: readonly string[];
  readonly root?: string;
  readonly limit?: number;
  readonly includeDeceased?: boolean;
  readonly seedObservationState?: boolean;
  /** Renal-domain dialysis labs for the CKD/ESRD cohort. Default false. */
  readonly dialysisLabs?: boolean;
}

/**
 * Turn a route payload or a restored realm spec into a `SeederRequest`.
 *
 * This is the reason the seam is worth having at all. The same mapping was written
 * twice — once in `POST /admin/realms`, once in `realm-restore.ts` — and each copy
 * re-derived the facility defaults inline. Both happened to be right, but that was
 * agreement by copying rather than by construction: adding one artifact field means
 * editing both, and forgetting one produces a realm whose population differs
 * depending on whether it was freshly created or restored from the database. That is
 * a divergence nothing would report, because both outcomes look healthy.
 *
 * The `artifact` block is only attached when the payload actually carries artifact
 * configuration, so a `population` request with no `root` still produces a static-LOOK
 * request shape rather than one advertising options it does not have.
 */
export function seederRequestFrom(payload: SeederPayload): SeederRequest {
  const hasArtifact =
    payload.root !== undefined
    || payload.limit !== undefined
    || payload.includeDeceased !== undefined
    || payload.seedObservationState !== undefined
    || payload.dialysisLabs !== undefined;

  return {
    facilityId: payload.facilityId,
    ...(payload.facilityKind !== undefined ? { facilityKind: payload.facilityKind } : {}),
    ...(payload.facilityName !== undefined ? { facilityName: payload.facilityName } : {}),
    units: payload.units,
    ...(hasArtifact
      ? {
          artifact: {
            ...(payload.root !== undefined ? { root: payload.root } : {}),
            ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
            ...(payload.includeDeceased !== undefined
              ? { includeDeceased: payload.includeDeceased }
              : {}),
            ...(payload.seedObservationState !== undefined
              ? { seedObservationState: payload.seedObservationState }
              : {}),
            ...(payload.dialysisLabs !== undefined
              ? { dialysisLabs: payload.dialysisLabs }
              : {}),
          },
        }
      : {}),
  };
}
