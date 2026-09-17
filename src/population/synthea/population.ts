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

// S3 — reading a generated population.
//
// The artifact is `synthea-population/<realmId>/`: a manifest written by S2, and the
// FHIR bundles Synthea produced beside it. This module is the only thing that reads
// it, so the layout and the failure modes live in one place.
//
// TWO DECISIONS WORTH STATING.
//
// 1. **The manifest is required, and its absence is an error rather than a fallback.**
//    A directory of FHIR bundles with no manifest is an artifact of unknown
//    provenance: nobody can say which generator, which seed or which reference date
//    produced it, so nobody can reason about the population six months later. S2
//    exists to make that impossible, and this is where the guarantee is enforced at
//    read time. The error names the command that fixes it.
//
// 2. **Deceased patients are excluded by default.** Synthea's `-p N` requests N
//    *living* patients and then simulates a lifetime, so a 150-patient request
//    produced 174 bundles of which 24 recorded a death (measured). A realm is a
//    running world: seeding a patient who has died means admitting a corpse, and the
//    history that killed them (the encounter, the terminal condition) is exactly the
//    part the projection drops. Excluding them and REPORTING the count keeps the
//    realm's census honest. The knob exists for a retrospective deployment, where a
//    deceased cohort is the point.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle, FhirResource } from '../../fhir/types.js';
import { fhirDirOf } from './runner.js';
import {
  DEFAULT_POPULATION_ROOT,
  DEFAULT_SEED_ROOT,
  populationDir,
  readManifest,
  readSeedBundles,
  readSeedManifest,
  seedBundlesPath,
  seedDir,
  seedManifestPath,
  type ArtifactForm,
  type PopulationManifest,
} from './manifest.js';

/** Synthea writes these beside the patient bundles; they are not patients. */
const NON_PATIENT_FILES = /^(hospitalInformation|practitionerInformation)/;

export interface LoadedPopulation {
  readonly realmId: string;
  readonly manifest: PopulationManifest;
  /** Which form was read, so a caller knows whether it still has to project. */
  readonly form: ArtifactForm;
  /** The instant the population is current as of — the generator's reference date. */
  readonly referenceAt: Date;
  /**
   * Bundles to ingest. One per patient for `raw-fhir`; one per CHUNK for `projected`,
   * where a patient's chunks are consecutive and only the first carries a `Patient`.
   */
  readonly bundles: readonly Bundle[];
  /** Bundles read from disk. Equal to `patientsRead` for the raw form only. */
  readonly filesRead: number;
  /** Distinct patients represented, after the deceased filter. */
  readonly patientsRead: number;
  readonly deceasedExcluded: readonly string[];
  /** Bundles that could not be parsed. Non-empty means the artifact is damaged. */
  readonly unreadable: readonly string[];
  readonly directory: string;
}

export interface LoadOptions {
  /** Root of the RAW artifact. Defaults to `SYNTHEA_POPULATION_ROOT`, then `./synthea-population`. */
  readonly root?: string;
  /** Root of the PROJECTED artifact. Defaults to `SYNTHEA_SEED_ROOT`, then `./synthea-seeds`. */
  readonly seedRoot?: string;
  /** Keep patients with a recorded death. Default false — see the header. */
  readonly includeDeceased?: boolean;
  /** Cap the number of PATIENTS read, for a smoke run. Stops at a patient boundary. */
  readonly limit?: number;
  /**
   * Which form to read. Default `auto`, which prefers the projected artifact because it
   * is the committed one and therefore what a clone will have. An explicit form never
   * falls back — the same rule as the required manifest, for the same reason: silently
   * reading a different artifact than the one asked for is how a provenance guarantee
   * stops meaning anything.
   */
  readonly form?: ArtifactForm | 'auto';
}

/** Whether a Synthea `Patient` records a death. */
export function isDeceased(patient: FhirResource): boolean {
  const p = patient as { deceasedBoolean?: boolean; deceasedDateTime?: string };
  return p.deceasedBoolean === true || typeof p.deceasedDateTime === 'string';
}

function patientOf(bundle: Bundle): FhirResource | undefined {
  return (bundle.entry ?? []).map((e) => e.resource).find((r): r is FhirResource => r?.resourceType === 'Patient');
}

/** The instant the population is current as of, from the manifest. */
export function referenceInstantOf(manifest: PopulationManifest): Date {
  const pinned = manifest.config.referenceDate;
  if (pinned && /^\d{8}$/.test(pinned)) {
    const iso = `${pinned.slice(0, 4)}-${pinned.slice(4, 6)}-${pinned.slice(6, 8)}T00:00:00.000Z`;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return new Date(t);
  }
  // No pinned reference date: the run instant is the only defensible answer, and it
  // is derivable from the manifest rather than from the filesystem clock.
  return new Date(manifest.generatedAt);
}

/**
 * One artifact form, resolved to bundles plus where they came from.
 *
 * Both forms produce the same shape so that everything downstream — the deceased
 * filter, the patient-boundary limit, the reporting — is written once.
 */
interface Candidate {
  readonly form: ArtifactForm;
  readonly directory: string;
  readonly manifest: PopulationManifest;
  readonly bundles: readonly Bundle[];
  readonly filesRead: number;
  /** Files that could not be parsed. Non-empty means the artifact is damaged. */
  readonly unreadable: readonly string[];
}

/** The projected form, or `undefined` when this realm has no projected artifact. */
function tryProjected(realmId: string, root: string): Candidate | undefined {
  const manifest = readSeedManifest(root, realmId);
  if (!manifest) return undefined;
  const bundles = readSeedBundles(root, realmId);
  if (bundles === undefined) {
    throw new Error(
      `population-incomplete: manifest exists at ${seedManifestPath(root, realmId)} but ${seedBundlesPath(root, realmId)} does not. ` +
      `Re-project it: npm run population:generate -- --realm ${realmId} --project`,
    );
  }
  return { form: 'projected', directory: seedDir(root, realmId), manifest, bundles, filesRead: bundles.length, unreadable: [] };
}

/** The raw form, or `undefined` when this realm has no raw artifact. */
function tryRaw(realmId: string, root: string): Candidate | undefined {
  const manifest = readManifest(root, realmId);
  if (!manifest) return undefined;
  const directory = fhirDirOf(populationDir(root, realmId));
  if (!existsSync(directory)) {
    throw new Error(
      `population-incomplete: manifest exists but ${directory} does not. ` +
      'Re-generate with --force (the manifest describes output that is no longer present).',
    );
  }
  const files = readdirSync(directory)
    .filter((f) => f.endsWith('.json') && !NON_PATIENT_FILES.test(f))
    .sort();

  const bundles: Bundle[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    try {
      bundles.push(JSON.parse(readFileSync(join(directory, file), 'utf8')) as Bundle);
    } catch {
      unreadable.push(file);
    }
  }
  return { form: 'raw-fhir', directory, manifest, bundles, filesRead: files.length, unreadable };
}

/**
 * Load one realm's generated population.
 *
 * Throws with a remedy when the artifact is missing or the manifest does not describe
 * the directory, rather than seeding a partial population.
 */
export function loadPopulation(realmId: string, opts: LoadOptions = {}): LoadedPopulation {
  const rawRoot = opts.root ?? DEFAULT_POPULATION_ROOT;
  const seedRoot = opts.seedRoot ?? DEFAULT_SEED_ROOT;
  const requested = opts.form ?? 'auto';

  let candidate: Candidate | undefined;
  if (requested === 'projected') candidate = tryProjected(realmId, seedRoot);
  else if (requested === 'raw-fhir') candidate = tryRaw(realmId, rawRoot);
  else candidate = tryProjected(realmId, seedRoot) ?? tryRaw(realmId, rawRoot);

  if (!candidate) {
    throw new Error(
      `population-not-found: no artifact for ${realmId} under ${seedRoot} or ${rawRoot}. ` +
      `Generate one first: npm run population:generate -- --realm ${realmId} --population 200`,
    );
  }

  // §9.5: a population belongs to ONE realm. The directory name is the realm id, so a
  // manifest naming a different one means the artifact was copied rather than generated
  // — and seeding it would mint this realm's patients from another realm's people.
  if (candidate.manifest.realmId !== realmId) {
    throw new Error(
      `population-mislabelled: ${candidate.directory} holds the population for ${candidate.manifest.realmId}, not ${realmId}. ` +
      'Re-generate it for this realm rather than reusing another realm\'s artifact.',
    );
  }

  const bundles: Bundle[] = [];
  const deceased: string[] = [];
  const unreadable = [...candidate.unreadable];
  let patientsRead = 0;

  // `skippingDeceased` exists because the projected form CHUNKS a patient's resources
  // across bundles. Excluding only the chunk that carries the `Patient` would leave the
  // rest of that patient's observations behind, and an effect that arrives for an
  // unknown patient CREATES one (`record-vitals`) — so a partially-excluded patient is
  // a phantom chart, not a smaller population.
  let skippingDeceased = false;

  for (const bundle of candidate.bundles) {
    const patient = patientOf(bundle);

    if (patient) {
      // A patient BOUNDARY — the only place it is safe to stop for `limit`, because the
      // chunks that follow belong to this patient.
      if (opts.limit !== undefined && patientsRead >= opts.limit) break;
      skippingDeceased = !opts.includeDeceased && isDeceased(patient);
      if (skippingDeceased) {
        deceased.push(patient.id ?? `(bundle ${bundles.length})`);
        continue;
      }
      patientsRead += 1;
      bundles.push(bundle);
      continue;
    }

    if (candidate.form === 'raw-fhir') {
      // One file is one patient in the raw form, so a bundle with no `Patient` is a
      // damaged file rather than a continuation.
      unreadable.push(`(bundle ${bundles.length})`);
      continue;
    }
    if (skippingDeceased) continue;
    bundles.push(bundle);
  }

  if (unreadable.length > 0) {
    // Refuse rather than seed around it: a population missing patients because files
    // were corrupt would look like a smaller population, not like a broken artifact.
    throw new Error(`population-unreadable: ${unreadable.length} file(s) could not be parsed: ${unreadable.slice(0, 5).join(', ')}`);
  }

  return {
    realmId,
    manifest: candidate.manifest,
    form: candidate.form,
    referenceAt: referenceInstantOf(candidate.manifest),
    bundles,
    filesRead: candidate.filesRead,
    patientsRead,
    deceasedExcluded: deceased,
    unreadable,
    directory: candidate.directory,
  };
}
