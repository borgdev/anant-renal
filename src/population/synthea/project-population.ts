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

// S6 — writing the committed form of a population.
//
// Synthea's output is a lifetime record per patient, and a measured 4,196 KB of it per
// patient, because the bulk is base64 clinical notes and billing. The projection drops
// 84.5x of that (49.6 KB per patient) — and crucially, it drops it in exactly the way
// the seeder is about to do anyway. So there is no reason to ship the raw form to a
// deployment that only ever seeds from it.
//
// ---------------------------------------------------------------------------
// WHY THE PROJECTION MOVES TO GENERATION TIME
// ---------------------------------------------------------------------------
// The seeder already projects. Doing it at generation time as well looks like
// duplication, and the reason it is not is arithmetic: 10 realms x 20 patients is
// **9.7 MB** projected against **820 MB** raw. The raw form cannot be committed — an
// 820 MB clone is not a demo — so without this step S6's exit criterion ("a fresh clone
// can reproduce the exact population a demo used") is unreachable: the clone would need
// Java 17 *and* a Synthea checkout *and* ten minutes of generation before it could seed
// anything.
//
// With it, the committed artifact IS the form the seeder reads, and the non-goal about
// a runtime JVM holds. The cost is stated rather than hidden: **changing a projection
// rule needs a regeneration**, because the artifact holds the projection's OUTPUT, not
// its inputs. The manifest records `artifactForm` and `projected` so a reader can tell
// the two apart and see what the rule produced.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY CARRIED OVER FROM THE RAW MANIFEST
// ---------------------------------------------------------------------------
// `configHash`, `patientDigest`, `config`, `records`, `argv` and `generatedAt` are
// copied unchanged. They describe the GENERATION, which projecting does not touch — so
// the raw and projected forms of one population share an identity, and comparing a
// realm's digest against the pool it came from still works. Only `outputDigest` is
// recomputed, because that is the question it answers: has THIS file been touched since
// we wrote it.

import { DEFAULT_POPULATION_ROOT, DEFAULT_SEED_ROOT, projectedDigestOf, seedDir, writeProjectedManifest, writeSeedBundles } from './manifest.js';
import { applyPatientIdMap, patientIdsIn, planPatientIds } from './identity.js';
import { projectBundle, type ProjectionOptions } from './projection.js';
import { loadPopulation } from './population.js';
import type { Bundle } from '../../fhir/types.js';

export interface ProjectPopulationOptions {
  readonly realmId: string;
  /** Root of the RAW artifact to read. Defaults to `SYNTHEA_POPULATION_ROOT`. */
  readonly rawRoot?: string;
  /** Root to write the PROJECTED artifact into. Defaults to `SYNTHEA_SEED_ROOT`. */
  readonly seedRoot?: string;
  readonly projection?: ProjectionOptions;
}

export interface ProjectPopulationResult {
  readonly realmId: string;
  readonly seedDirectory: string;
  readonly patients: number;
  readonly bundles: number;
  readonly inputEntries: number;
  readonly outputEntries: number;
  readonly outputDigest: string;
  readonly bytes: number;
}

/**
 * Project a realm's raw population into the committed form.
 *
 * Reads the RAW form explicitly. That is not a precaution — `loadPopulation` defaults to
 * whichever form it finds, so projecting a projected artifact would apply retention a
 * second time and report the residue as if it were a fresh measurement of the
 * population.
 *
 * `includeDeceased: true` here, unlike at seed time: the projected artifact is a
 * faithful record of what the generator produced, and the deceased filter is a SEEDING
 * decision (a realm is a running world, so admitting a corpse is wrong) rather than a
 * publishing one. Keeping them means the same artifact can seed a retrospective realm,
 * and it means the two forms hold the same patients.
 */
export function projectPopulation(opts: ProjectPopulationOptions): ProjectPopulationResult {
  const rawRoot = opts.rawRoot ?? DEFAULT_POPULATION_ROOT;
  const seedRoot = opts.seedRoot ?? DEFAULT_SEED_ROOT;

  const loaded = loadPopulation(opts.realmId, { root: rawRoot, form: 'raw-fhir', includeDeceased: true });
  const planned = planPatientIds(patientIdsIn(loaded.bundles), opts.realmId);

  const chunks: Bundle[] = [];
  let inputEntries = 0;
  let outputEntries = 0;
  let patients = 0;

  for (const bundle of loaded.bundles) {
    // Rename BEFORE projecting, exactly as the seeder does, so the projected artifact
    // holds realm-scoped local ids rather than Synthea's uuids. That is what makes
    // seeding from it a straight ingest with no rewrite step.
    applyPatientIdMap(bundle, planned);
    const projected = projectBundle(bundle, opts.projection ?? {});
    inputEntries += projected.report.inputEntries;
    outputEntries += projected.report.outputEntries;
    chunks.push(...projected.chunks);
    patients += 1;
  }

  const bundlesPath = writeSeedBundles(seedRoot, opts.realmId, chunks);
  const outputDigest = projectedDigestOf(bundlesPath);

  // After the bundles, because `outputDigest` is computed over them.
  writeProjectedManifest(seedRoot, {
    ...loaded.manifest,
    outputDigest,
    projected: { bundles: chunks.length, inputEntries, outputEntries },
  });

  return {
    realmId: opts.realmId,
    seedDirectory: seedDir(seedRoot, opts.realmId),
    patients,
    bundles: chunks.length,
    inputEntries,
    outputEntries,
    outputDigest,
    // Measured, not estimated: this is the number the artifact-policy decision rests on.
    bytes: Buffer.byteLength(JSON.stringify(chunks), 'utf8'),
  };
}
