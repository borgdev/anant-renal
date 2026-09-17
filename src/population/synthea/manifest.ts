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

// The population manifest (S2) — what was generated, from what, and proof it has
// not changed since.
//
// A generated population is an ARTIFACT, and an artifact without provenance is a
// thing nobody can reason about six months later. Three questions have to be
// answerable from the file alone:
//
//   1. **What produced this?** Generator, version, seed, and the exact argv. The
//      argv matters because S0 found `-o` meaning two different things across the
//      two implementations — a reader has to be able to replay the run by hand.
//   2. **Is it the same population I saw before?** A SEED is not sufficient:
//      Synthea's output also depends on the reference date, the module set and the
//      generator version, so the manifest carries a `configHash` over exactly
//      those inputs.
//   3. **Has the output drifted, or is it a different population?** These are two
//      questions, and a first version of this file answered both with one hash,
//      which was wrong: measured across two runs with identical `--seed` and
//      `--reference-date`, a legitimate regeneration does NOT reproduce the bytes
//      (the provider layer is regenerated at random), so a single byte digest
//      compared "different" every single time — a cache that can never hit while
//      looking like a careful check. Hence `outputDigest` (untouched since
//      generated?) and `patientDigest` (same population?) are separate, and
//      `nonReproducible` records what is known NOT to reproduce — see `digest.ts`
//      for the measurements.
//
// This is the population's equivalent of the provenance carried on every
// canonical event (`sourceId`, `observedAt`, `ingestedAt`) — the platform already
// insists that a fact says where it came from, and a population is a fact.
//
// PER REALM, per the §9.5 decision: the directory is keyed by realm id, because
// one generated population must not seed two realms — they would mint the same
// patient ids for different people.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const POPULATION_MANIFEST_VERSION = 2;

/**
 * The inputs a population's identity depends on.
 *
 * Anything omitted here is an input whose change would leave two different
 * populations claiming the same `configHash` — which is the failure mode this
 * whole file exists to prevent.
 */
export interface PopulationConfig {
  /** Synthea commit/version string. Output changes between releases. */
  readonly generatorVersion: string;
  readonly population: number;
  readonly seed: number;
  /** `YYYYMMDD`. Changes every birth date and every observation date. */
  readonly referenceDate?: string;
  readonly ageRange?: string;
  readonly state?: string;
  readonly city?: string;
}

export interface PopulationManifest {
  readonly manifestVersion: number;
  readonly realmId: string;
  readonly generator: 'synthea-reference';
  readonly config: PopulationConfig;
  /** Stable hash over `config`. Equal hashes ⇒ same inputs. */
  readonly configHash: string;
  /**
   * Hash over the raw bytes as produced. Equal hashes ⇒ the directory is
   * untouched since generation.
   *
   * NOT a population identity — see `patientDigest`. A legitimate regeneration
   * never reproduces these bytes, because the provider layer is not reproducible.
   */
  readonly outputDigest: string;
  /**
   * Hash over the normalised patient layer. Equal hashes ⇒ the same population.
   *
   * This is the field to compare when asking whether two directories hold the
   * same patients; it survives regeneration, which `outputDigest` cannot.
   */
  readonly patientDigest: string;
  /** Bundles `patientDigest` covers. A digest over zero files proves nothing. */
  readonly patientCount: number;
  /** Layers this generator does not reproduce, recorded rather than assumed. */
  readonly nonReproducible: readonly string[];
  readonly generatedAt: string;
  readonly fileCount: number;
  /** The argv used, so the run can be replayed by hand. */
  readonly argv: readonly string[];
  /** Synthea's own summary, as reported. */
  readonly records: { total: number; alive: number; dead: number };
}

/**
 * Stable stringify, so a hash cannot depend on key order.
 *
 * Exported because `digest.ts` needs the same definition of "stable": two
 * different canonicalisations of the same data would produce two hashes that
 * disagree for a reason nobody could find.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function configHashOf(config: PopulationConfig): string {
  return createHash('sha256').update(canonical(config)).digest('hex').slice(0, 16);
}

/**
 * Hash the generated files.
 *
 * Sorted by filename so the digest does not depend on directory order, and the
 * filename is folded into each entry so a rename with identical contents is still
 * a different population.
 */
export function outputDigestOf(dir: string): { digest: string; fileCount: number } {
  if (!existsSync(dir)) return { digest: 'empty', fileCount: 0 };
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(join(dir, name)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex').slice(0, 16), fileCount: names.length };
}

/**
 * Where generated populations live, by default.
 *
 * Shared by the generator (`scripts/generate-population.ts`) and the seeder
 * (`population.ts`) so a realm cannot be generated into one directory and read from
 * another. `SYNTHEA_POPULATION_ROOT` overrides it — the generator's root is a
 * build-time choice, but the seeder may run in a deployment where the artifacts were
 * shipped separately.
 */
export const DEFAULT_POPULATION_ROOT = process.env.SYNTHEA_POPULATION_ROOT ?? join(process.cwd(), 'synthea-population');

/**
 * `synthea-population/<realmId>/` — per realm, per §9.5.
 *
 * This is the BASE passed to Synthea, so the layout on disk is:
 *
 *   <realmId>/manifest.json   this file
 *   <realmId>/fhir/*.json     the generated bundles (Synthea appends `fhir/`)
 *   <realmId>/metadata/       Synthea's own run metadata
 *
 * Use `fhirDirOf()` from `runner.ts` rather than appending `'fhir'` by hand.
 */
export function populationDir(root: string, realmId: string): string {
  return join(root, realmId);
}

export function manifestPath(root: string, realmId: string): string {
  return join(populationDir(root, realmId), 'manifest.json');
}

export function writeManifest(root: string, manifest: PopulationManifest): string {
  const dir = populationDir(root, manifest.realmId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

export function readManifest(root: string, realmId: string): PopulationManifest | undefined {
  const path = manifestPath(root, realmId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PopulationManifest;
  } catch {
    return undefined;
  }
}

/**
 * Whether an existing artifact can be reused for a requested config.
 *
 * Reuse requires BOTH hashes to match. Comparing only the config would accept a
 * directory whose contents were changed by something else; comparing only the
 * digest would accept a population generated under different inputs that happened
 * to produce identical bytes. Regenerating is the safe answer to either.
 */
export function isReusable(
  existing: PopulationManifest | undefined,
  requested: PopulationConfig,
  fhirDir: string,
): { reusable: boolean; reason: string } {
  if (!existing) return { reusable: false, reason: 'no manifest' };
  if (existing.configHash !== configHashOf(requested)) {
    return { reusable: false, reason: `config changed (${existing.configHash} → ${configHashOf(requested)})` };
  }
  const { digest, fileCount } = outputDigestOf(fhirDir);
  if (fileCount === 0) return { reusable: false, reason: 'no FHIR output present' };
  if (digest !== existing.outputDigest) {
    return { reusable: false, reason: `output changed (${existing.outputDigest} → ${digest})` };
  }
  return { reusable: true, reason: 'config and output both match' };
}
