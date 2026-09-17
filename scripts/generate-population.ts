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

// Generate one realm's synthetic population (S2).
//
//   npx tsx scripts/generate-population.ts --realm sim:ent-midtn-a --population 200
//
// Build-time, not runtime. Writes `synthea-population/<realmId>/` with the FHIR
// output and a manifest recording exactly how it was produced.
//
// PER REALM (§9.5): the population is keyed by realm, because one generated
// population must not seed two realms — they would mint the same patient ids for
// different people.
//
// Re-running with the same config is a no-op unless `--force`: the manifest is
// compared by config hash AND by an output digest, so a directory whose contents
// were changed by something else is regenerated rather than trusted.
//
// The manifest carries TWO digests, because reproducibility was measured rather
// than assumed and the answer differs by layer — see src/population/synthea/digest.ts.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  SyntheaRunner,
  DEFAULT_SYNTHEA_ROOT,
  fhirDirOf,
  type SyntheaRunRequest,
} from '../src/population/synthea/runner.js';
import { NON_REPRODUCIBLE_LAYERS, patientDigestOf } from '../src/population/synthea/digest.js';
import {
  configHashOf,
  isReusable,
  outputDigestOf,
  populationDir,
  readManifest,
  writeManifest,
  POPULATION_MANIFEST_VERSION,
  type PopulationConfig,
} from '../src/population/synthea/manifest.js';
import { projectPopulation } from '../src/population/synthea/project-population.js';

const ROOT = join(process.cwd(), 'synthea-population');

interface Args {
  realm?: string;
  population: number;
  seed: number;
  referenceDate?: string;
  ageRange?: string;
  state?: string;
  city?: string;
  force: boolean;
  dryRun: boolean;
  project: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { population: 200, seed: 20260917, force: false, dryRun: false, project: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => argv[++i] ?? '';
    if (a === '--realm') out.realm = next();
    else if (a === '--population') out.population = Number.parseInt(next(), 10);
    else if (a === '--seed') out.seed = Number.parseInt(next(), 10);
    else if (a === '--reference-date') out.referenceDate = next();
    else if (a === '--age-range') out.ageRange = next();
    else if (a === '--state') out.state = next();
    else if (a === '--city') out.city = next();
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--project') out.project = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Generate one realm\'s synthetic population.',
          '',
          '  --realm <id>            required; the realm this population is for',
          '  --population <n>        default 200 (S0: 25 gave ZERO renal and oncology patients)',
          '  --seed <n>              default 20260917',
          '  --reference-date <YMD>  Synthea -r; pins every date in the record',
          '  --age-range <min-max>   e.g. 18-90',
          '  --state <name> --city <name>',
          '  --force                 regenerate even if the manifest matches',
          '  --dry-run               report what would happen, generate nothing',
          '  --project               also write the COMMITTED projected artifact',
          '                          (synthea-seeds/<realm>/, ~50 KB/patient vs ~4.2 MB)',
          '',
          `Synthea checkout: ${DEFAULT_SYNTHEA_ROOT} (override with SYNTHEA_ROOT)`,
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return out;
}

/** Project the raw artifact into the COMMITTED form, and report what it produced. */
function projectAndReport(realmId: string): void {
  const projected = projectPopulation({ realmId });
  const perPatient = projected.patients > 0 ? `${(projected.bytes / projected.patients / 1024).toFixed(1)} KB/patient` : 'n/a';
  console.log(`projected  ${projected.seedDirectory}`);
  console.log(`bundles    ${projected.bundles} chunks from ${projected.patients} patients, ${projected.inputEntries} → ${projected.outputEntries} entries`);
  console.log(`size       ${(projected.bytes / 1024).toFixed(1)} KB (${perPatient}), digest ${projected.outputDigest}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.realm) {
    console.error('--realm is required. A population belongs to one realm (see docs/synthea-population-integration.md §9.5).');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(args.population) || args.population <= 0) {
    console.error(`--population must be a positive integer (got ${args.population}).`);
    process.exitCode = 1;
    return;
  }

  const runner = new SyntheaRunner();
  const pre = runner.preflight();
  if (!pre.ok) {
    console.error(pre.reason);
    process.exitCode = 1;
    return;
  }

  // `dir` is the BASE handed to Synthea; it appends `fhir/` to it, so the bundles
  // are one level below. `fhirDirOf` is the only place that rule lives.
  const dir = populationDir(ROOT, args.realm);
  const fhirDir = fhirDirOf(dir);
  const config: PopulationConfig = {
    // Resolved once and recorded. A population whose generator version is unknown
    // is one nobody can reproduce.
    generatorVersion: pre.jdk.javaVersion ? `jdk-${pre.jdk.javaVersion}` : 'unknown',
    population: args.population,
    seed: args.seed,
    ...(args.referenceDate ? { referenceDate: args.referenceDate } : {}),
    ...(args.ageRange ? { ageRange: args.ageRange } : {}),
    ...(args.state ? { state: args.state } : {}),
    ...(args.city ? { city: args.city } : {}),
  };
  const configHash = configHashOf(config);

  const existing = readManifest(ROOT, args.realm);
  const reuse = isReusable(existing, config, fhirDir);
  console.log(`realm      ${args.realm}`);
  console.log(`jdk        ${pre.jdk.javaHome} (${pre.jdk.javaVersion ?? '?'}, ${pre.jdk.source})`);
  console.log(`config     ${configHash}  seed=${config.seed} population=${config.population}`);
  console.log(`existing   ${reuse.reusable ? 'reusable' : `regenerating — ${reuse.reason}`}`);

  if (args.dryRun) {
    console.log(args.force || !reuse.reusable ? 'dry-run: would generate' : 'dry-run: would skip (nothing to do)');
    return;
  }
  if (reuse.reusable && !args.force) {
    console.log(`kept       ${fhirDir} (${existing?.fileCount ?? 0} files, digest ${existing?.outputDigest})`);
    // Still project: the raw artifact being reusable says nothing about whether the
    // committed form exists, and re-projecting is idempotent for an unchanged pool.
    if (args.project) projectAndReport(args.realm);
    return;
  }

  const request: SyntheaRunRequest = {
    baseDir: dir,
    syntheaRoot: DEFAULT_SYNTHEA_ROOT,
    population: args.population,
    seed: args.seed,
    ...(args.referenceDate ? { referenceDate: args.referenceDate } : {}),
    ...(args.ageRange ? { ageRange: args.ageRange } : {}),
    ...(args.state ? { state: args.state } : {}),
    ...(args.city ? { city: args.city } : {}),
  };

  // Remove the previous run's bundles FIRST. Synthea appends to whatever is
  // already there, so regenerating over an existing directory leaves the old
  // patients in place — observed as `--force` growing a 29-file population to 31
  // and reporting a digest over the union of two runs. The manifest is not inside
  // `fhir/`, so it survives and still describes the run that produced it.
  rmSync(fhirDir, { recursive: true, force: true });

  const result = await runner.run(request);
  const { digest, fileCount } = outputDigestOf(fhirDir);
  const patients = patientDigestOf(fhirDir);

  // Reported, not enforced: a population whose patient layer changed under the
  // same config is the one case where the config hash alone would have said
  // "reusable" about different people.
  if (existing && existing.patientDigest !== patients.digest) {
    console.log(`population changed  ${existing.patientDigest} → ${patients.digest}`);
  }
  if (patients.unreadable.length > 0) {
    console.error(`warn       ${patients.unreadable.length} bundle(s) unreadable; the patient digest is incomplete`);
  }

  const path = writeManifest(ROOT, {
    manifestVersion: POPULATION_MANIFEST_VERSION,
    realmId: args.realm,
    generator: 'synthea-reference',
    config,
    configHash,
    outputDigest: digest,
    patientDigest: patients.digest,
    patientCount: patients.patientCount,
    nonReproducible: NON_REPRODUCIBLE_LAYERS,
    generatedAt: new Date().toISOString(),
    fileCount,
    argv: result.argv,
    records: result.records!,
  });

  console.log(`records    total=${result.records!.total} alive=${result.records!.alive} dead=${result.records!.dead}`);
  console.log(`patients   ${patients.patientCount} bundles, patient digest ${patients.digest}`);
  console.log(`output     ${fhirDir} (${fileCount} files, output digest ${digest})`);
  console.log(`manifest   ${path}`);
  if (args.project) projectAndReport(args.realm);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
