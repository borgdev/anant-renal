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
import { DEFAULT_POPULATION_ROOT, manifestPath, populationDir, readManifest, type PopulationManifest } from './manifest.js';

/** Synthea writes these beside the patient bundles; they are not patients. */
const NON_PATIENT_FILES = /^(hospitalInformation|practitionerInformation)/;

export interface LoadedPopulation {
  readonly realmId: string;
  readonly manifest: PopulationManifest;
  /** The instant the population is current as of — the generator's reference date. */
  readonly referenceAt: Date;
  /** Patient bundles, in filename order, with deceased patients removed. */
  readonly bundles: readonly Bundle[];
  readonly filesRead: number;
  readonly deceasedExcluded: readonly string[];
  /** Files that could not be parsed. Non-empty means the artifact is damaged. */
  readonly unreadable: readonly string[];
  readonly directory: string;
}

export interface LoadOptions {
  readonly root?: string;
  /** Keep patients with a recorded death. Default false — see the header. */
  readonly includeDeceased?: boolean;
  /** Cap the number of bundles read, for a smoke run. */
  readonly limit?: number;
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
 * Load one realm's generated population.
 *
 * Throws with a remedy when the artifact is missing or the manifest does not describe
 * the directory, rather than seeding a partial population.
 */
export function loadPopulation(realmId: string, opts: LoadOptions = {}): LoadedPopulation {
  const root = opts.root ?? DEFAULT_POPULATION_ROOT;
  const directory = fhirDirOf(populationDir(root, realmId));

  const manifest = readManifest(root, realmId);
  if (!manifest) {
    throw new Error(
      `population-not-found: no manifest at ${manifestPath(root, realmId)}. ` +
      `Generate one first: npm run population:generate -- --realm ${realmId} --population 200`,
    );
  }
  if (!existsSync(directory)) {
    throw new Error(
      `population-incomplete: manifest exists but ${directory} does not. ` +
      'Re-generate with --force (the manifest describes output that is no longer present).',
    );
  }

  const files = readdirSync(directory)
    .filter((f) => f.endsWith('.json') && !NON_PATIENT_FILES.test(f))
    .sort();
  const selected = opts.limit !== undefined ? files.slice(0, opts.limit) : files;

  const bundles: Bundle[] = [];
  const deceased: string[] = [];
  const unreadable: string[] = [];

  for (const file of selected) {
    let parsed: Bundle;
    try {
      parsed = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Bundle;
    } catch {
      unreadable.push(file);
      continue;
    }
    const patient = patientOf(parsed);
    if (!patient) {
      unreadable.push(file);
      continue;
    }
    if (!opts.includeDeceased && isDeceased(patient)) {
      deceased.push(patient.id ?? file);
      continue;
    }
    bundles.push(parsed);
  }

  if (unreadable.length > 0) {
    // Refuse rather than seed around it: a population missing patients because files
    // were corrupt would look like a smaller population, not like a broken artifact.
    throw new Error(`population-unreadable: ${unreadable.length} file(s) could not be parsed: ${unreadable.slice(0, 5).join(', ')}`);
  }

  return {
    realmId,
    manifest,
    referenceAt: referenceInstantOf(manifest),
    bundles,
    filesRead: selected.length,
    deceasedExcluded: deceased,
    unreadable,
    directory,
  };
}
