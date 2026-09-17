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

// S2 — the Synthea runner, its manifest, and the guarantees they carry.
//
// These tests run with NO JDK and NO Synthea checkout, which is the point of the
// injectable `CommandRunner`. A test suite that needed a JVM would be a suite
// nobody runs, and the failure mode of the seam is exactly the kind of thing CI
// has to be able to catch.
//
// All three CLI traps S0 found are pinned here, because all three fail SILENTLY:
//
//   * `-o` is OVERFLOW POPULATION in the reference, not output directory. Getting
//     it wrong writes to Synthea's default directory and the caller looks in the
//     wrong place with no error. The assertion is that the argv contains
//     `--exporter.baseDirectory=` and does NOT contain a bare `-o`.
//   * `--exporter.baseDirectory=` is a BASE, not the FHIR directory: Synthea
//     appends `fhir/` to it. Getting it wrong writes to `<dir>/fhir/fhir` while
//     the caller reads `<dir>/fhir`, so a completed run is reported as `0 files`.
//     Found by running S2 for real, not by reading the docs.
//   * `java` on PATH may not be a JDK 17. S0's machine had `javac` 17 and `java`
//     1.8. Discovery therefore reads JDK `release` files and refuses to fall back
//     to a bare command name.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SyntheaRunner,
  buildArgv,
  discoverJdk,
  fhirDirOf,
  parseRecords,
  type CommandRunner,
  type JdkResolution,
  type SyntheaRunRequest,
} from '../src/population/synthea/runner.js';
import {
  configHashOf,
  isReusable,
  outputDigestOf,
  readManifest,
  writeManifest,
  POPULATION_MANIFEST_VERSION,
  type PopulationConfig,
  type PopulationManifest,
} from '../src/population/synthea/manifest.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'synthea-s2-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A machine with a JDK 17, without needing one. */
const FAKE_JDK: JdkResolution = { javaHome: '/fake/jdk-17', javaVersion: '17', source: 'discovered' };

const REQUEST: SyntheaRunRequest = {
  baseDir: '/tmp/pop',
  syntheaRoot: '/tmp/pop/synthea',
  population: 25,
  seed: 4242,
  referenceDate: '20260901',
  ageRange: '18-90',
  state: 'Massachusetts',
};

/** Records every call and replies with a Synthea-shaped summary. */
function fakeCommandRunner(records = 'Records: total=25, alive=24, dead=1', code = 0): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const runner: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env, cwd: opts.cwd });
    return { stdout: `Some preamble\n${records}\n`, stderr: '', code };
  };
  return { runner, calls };
}

describe('S2 — the argv carries the traps S0 found', () => {
  it('sets the output directory with --exporter.baseDirectory, never with -o', () => {
    const argv = buildArgv(REQUEST);
    expect(argv).toContain(`--exporter.baseDirectory=${REQUEST.baseDir}`);
    // The trap: `-o` means overflow population here, and would send output to the
    // default directory with no error at all.
    expect(argv).not.toContain('-o');
    expect(argv.some((a) => a.startsWith('-o') && !a.startsWith('--'))).toBe(false);
  });

  it('treats baseDirectory as a BASE — the base is not where the bundles land', () => {
    // The trap that a real run exposed: `--exporter.baseDirectory=<dir>` makes
    // Synthea write to `<dir>/fhir`, NOT `<dir>`. Passing `<dir>/fhir` produced
    // `<dir>/fhir/fhir` and a run that reported `0 files` while exiting 0.
    const argv = buildArgv(REQUEST);
    expect(argv).toContain(`--exporter.baseDirectory=${REQUEST.baseDir}`);
    expect(argv).not.toContain(`--exporter.baseDirectory=${REQUEST.baseDir}/fhir`);
    // ...and the reader must look one level down, not at the base.
    expect(fhirDirOf(REQUEST.baseDir)).toBe(`${REQUEST.baseDir}/fhir`);
    expect(fhirDirOf(REQUEST.baseDir)).not.toBe(REQUEST.baseDir);
    // The property that made this silent: nesting fhirDirOf is not idempotent, so
    // the mistake cannot be "fixed" by applying it twice either.
    expect(fhirDirOf(fhirDirOf(REQUEST.baseDir))).not.toBe(fhirDirOf(REQUEST.baseDir));
  });

  it('passes seed, population, reference date and age range positionally-correct', () => {
    const argv = buildArgv(REQUEST);
    expect(argv.slice(0, 6)).toEqual(['-p', '25', '-s', '4242', '-r', '20260901']);
    expect(argv).toContain('-a');
    expect(argv).toContain('18-90');
    // State/city go last, positionally, after the options.
    expect(argv[argv.length - 1]).toBe('Massachusetts');
  });
});

describe('S2 — the runner refuses to run rather than half-run', () => {
  it('reports a preflight reason instead of spawning when no JDK 17 exists', async () => {
    const { runner: cmd, calls } = fakeCommandRunner();
    const runner = new SyntheaRunner(cmd, () => undefined);
    const pre = runner.preflight();
    expect(pre.ok).toBe(false);
    if (!pre.ok) {
      // The message has to be actionable: it says a RUNTIME is needed, not just a
      // JDK on PATH, because that is the confusion S0 hit.
      expect(pre.reason).toMatch(/RUNTIME/);
      expect(pre.reason).toMatch(/JAVA_HOME/);
    }
    await expect(runner.run(REQUEST)).rejects.toThrow(/synthea-unavailable/);
    expect(calls).toHaveLength(0);
  });

  it('fails when the script is missing rather than pretending it ran', async () => {
    const { runner: cmd } = fakeCommandRunner();
    const runner = new SyntheaRunner(cmd, () => FAKE_JDK);
    await expect(runner.run({ ...REQUEST, syntheaRoot: '/definitely/not/here' })).rejects.toThrow(/synthea-not-found/);
  });

  it('treats a missing summary line as an incomplete run', async () => {
    // A run that produced no `Records:` line did not finish. Carrying on would write
    // a manifest describing a population that does not exist.
    const root = scratch();
    writeFileSync(join(root, 'run_synthea'), '#!/bin/sh\n', 'utf8');
    const { runner: cmd } = fakeCommandRunner('nothing useful here');
    const runner = new SyntheaRunner(cmd, () => FAKE_JDK);
    await expect(runner.run({ ...REQUEST, syntheaRoot: root })).rejects.toThrow(/synthea-incomplete/);
  });

  it('passes JAVA_HOME to the child, because java on PATH cannot be trusted', async () => {
    const { runner: cmd, calls } = fakeCommandRunner();
    const runner = new SyntheaRunner(cmd, () => FAKE_JDK);
    // The script path must exist for the runner to proceed.
    const root = scratch();
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'run_synthea'), '#!/bin/sh\n', 'utf8');
    await runner.run({ ...REQUEST, syntheaRoot: root });
    expect(calls[0]?.env.JAVA_HOME).toBe(FAKE_JDK.javaHome);
  });

  it('parses the summary Synthea actually prints', () => {
    expect(parseRecords('Records: total=233, alive=200, dead=33')).toEqual({ total: 233, alive: 200, dead: 33 });
    expect(parseRecords('no summary')).toBeUndefined();
  });
});

describe('S2 — JDK discovery does not trust the command name', () => {
  it('prefers an explicit JAVA_HOME that qualifies', () => {
    const root = scratch();
    const home = join(root, 'jdk17');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'java'), '', 'utf8');
    writeFileSync(join(home, 'release'), 'JAVA_VERSION="17.0.20"\n', 'utf8');
    const found = discoverJdk({ JAVA_HOME: home }, []);
    expect(found?.source).toBe('JAVA_HOME');
    expect(found?.javaVersion).toBe('17');
  });

  it('ignores a JAVA_HOME that is too old and looks elsewhere', () => {
    // The S0 situation: an 8 on the machine while 17 exists. A JAVA_HOME pointing
    // at 8 must not be accepted just because it is set.
    const root = scratch();
    const eight = join(root, 'jdk8');
    mkdirSync(join(eight, 'bin'), { recursive: true });
    writeFileSync(join(eight, 'bin', 'java'), '', 'utf8');
    writeFileSync(join(eight, 'release'), 'JAVA_VERSION="1.8.0_502"\n', 'utf8');

    const jvmRoot = join(root, 'jvm');
    const seventeen = join(jvmRoot, 'java-17-openjdk-amd64');
    mkdirSync(join(seventeen, 'bin'), { recursive: true });
    writeFileSync(join(seventeen, 'bin', 'java'), '', 'utf8');
    writeFileSync(join(seventeen, 'release'), 'JAVA_VERSION="17.0.20"\n', 'utf8');

    const found = discoverJdk({ JAVA_HOME: eight }, [jvmRoot]);
    expect(found?.source).toBe('discovered');
    expect(found?.javaHome).toBe(seventeen);
  });

  it('finds nothing when only pre-17 JDKs exist', () => {
    const root = scratch();
    const eight = join(root, 'jdk8');
    mkdirSync(join(eight, 'bin'), { recursive: true });
    writeFileSync(join(eight, 'bin', 'java'), '', 'utf8');
    writeFileSync(join(eight, 'release'), 'JAVA_VERSION="1.8.0_502"\n', 'utf8');
    expect(discoverJdk({}, [root])).toBeUndefined();
  });
});

describe('S2 — the manifest is provenance, not decoration', () => {
  const CONFIG: PopulationConfig = {
    generatorVersion: 'jdk-17',
    population: 200,
    seed: 4242,
    referenceDate: '20260901',
  };

  /** A complete manifest. Built here so adding a field is one edit, not six. */
  function mkManifest(overrides: Partial<PopulationManifest> = {}): PopulationManifest {
    return {
      manifestVersion: POPULATION_MANIFEST_VERSION,
      realmId: 'sim:test-a',
      generator: 'synthea-reference',
      config: CONFIG,
      configHash: configHashOf(CONFIG),
      outputDigest: 'abc123',
      patientDigest: 'pabc123',
      patientCount: 3,
      nonReproducible: ['practitioner-roster', 'provider-display-names'],
      generatedAt: '2026-09-17T00:00:00.000Z',
      fileCount: 3,
      argv: ['-p', '200'],
      records: { total: 200, alive: 199, dead: 1 },
      ...overrides,
    };
  }

  it('hashes the config so different inputs cannot claim the same identity', () => {
    const base = configHashOf(CONFIG);
    expect(configHashOf({ ...CONFIG })).toBe(base);
    // Each of these changes the population. If any left the hash unmoved, two
    // different populations would share an identity.
    for (const changed of [
      { ...CONFIG, seed: 4243 },
      { ...CONFIG, population: 201 },
      { ...CONFIG, referenceDate: '20260902' },
      { ...CONFIG, generatorVersion: 'jdk-21' },
      { ...CONFIG, state: 'Texas' },
    ]) {
      expect(configHashOf(changed), JSON.stringify(changed)).not.toBe(base);
    }
  });

  it('round-trips through disk', () => {
    const root = scratch();
    const path = writeManifest(root, mkManifest());
    expect(readFileSync(path, 'utf8')).toContain('"realmId": "sim:test-a"');
    expect(readManifest(root, 'sim:test-a')?.configHash).toBe(configHashOf(CONFIG));
    // A realm with no population is undefined, not a default object — the caller
    // must not be able to mistake "absent" for "generated".
    expect(readManifest(root, 'never-generated')).toBeUndefined();
  });

  it('digests output so a changed file cannot pass as the same population', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.json'), '{"a":1}', 'utf8');
    writeFileSync(join(dir, 'b.json'), '{"b":2}', 'utf8');
    const first = outputDigestOf(dir);
    expect(first.fileCount).toBe(2);
    expect(outputDigestOf(dir).digest).toBe(first.digest);

    writeFileSync(join(dir, 'b.json'), '{"b":3}', 'utf8');
    expect(outputDigestOf(dir).digest).not.toBe(first.digest);
    // A rename with identical contents is still a different population.
    writeFileSync(join(dir, 'b.json'), '{"b":2}', 'utf8');
    rmSync(join(dir, 'b.json'));
    writeFileSync(join(dir, 'c.json'), '{"b":2}', 'utf8');
    expect(outputDigestOf(dir).digest).not.toBe(first.digest);
  });

  it('reuses only when config AND output both match', () => {
    const root = scratch();
    const dir = join(root, 'sim:x', 'fhir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'p.json'), '{"p":1}', 'utf8');
    const { digest } = outputDigestOf(dir);
    const manifest = mkManifest({
      realmId: 'sim:x',
      outputDigest: digest,
      fileCount: 1,
      patientCount: 1,
      argv: [],
      records: { total: 1, alive: 1, dead: 0 },
    });

    expect(isReusable(manifest, CONFIG, dir).reusable).toBe(true);

    // Config changed → regenerate, even though the bytes are identical.
    expect(isReusable(manifest, { ...CONFIG, seed: 1 }, dir).reusable).toBe(false);
    // Output changed → regenerate, even though the config is identical.
    writeFileSync(join(dir, 'p.json'), '{"p":2}', 'utf8');
    expect(isReusable(manifest, CONFIG, dir).reusable).toBe(false);
    // No output at all → regenerate rather than trust an empty directory.
    rmSync(join(dir, 'p.json'));
    expect(isReusable(manifest, CONFIG, dir).reason).toMatch(/no FHIR output/);
    // No manifest → regenerate. Absence is not a match.
    expect(isReusable(undefined, CONFIG, dir).reusable).toBe(false);
  });
});
