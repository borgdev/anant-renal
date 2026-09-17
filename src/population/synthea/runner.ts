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

// The Synthea runner (S2) — spawns the reference implementation.
//
// Generation is a BUILD-TIME activity, not a runtime one. This spawns a JVM,
// takes seconds to minutes, and is expected to run from a script — never from a
// request handler. That is why the interface is synchronous-shaped (a request in,
// a result out) and why the runner is injectable: CI must never need a JDK, and
// the tests substitute a fake the way `LiquidTrainer` substitutes its
// `TrainingRunner`.
//
// Two CLI traps found in S0 are encoded here rather than left to the caller,
// because all three fail SILENTLY if you get them wrong:
//
//   1. **`-o` does NOT mean output directory.** In the reference it means
//      *overflow population*. Passing a path there does not error — Synthea
//      writes to its default `output/` and the caller looks in the wrong place.
//      The output directory is set with `--exporter.baseDirectory=`.
//   2. **`java` on PATH is not necessarily a JDK 17.** S0 found `javac` at 17
//      while the `java` *runtime* was 1.8. Synthea requires a 17+ runtime. So this
//      resolves a JDK explicitly and refuses to fall back to a bare `java`.
//   3. **`--exporter.baseDirectory=` is a BASE, not the FHIR directory.** Synthea
//      appends its own `fhir/` to it, so passing `<dir>/fhir` writes to
//      `<dir>/fhir/fhir` and a reader that looks in `<dir>/fhir` finds NOTHING and
//      reports a successful run that produced zero patients. Found by running S2
//      for real against the checkout: the first live run printed `0 files` with
//      the digest of empty input. `fhirDirOf()` below is the single place that
//      rule is expressed, so it cannot drift.
//
// The engine is chosen on evidence (S0): PySynthea was run and emits
// `Unknown Unknown` as a patient name and a 1898 birth date for a living patient,
// in the exact fields our ingest reads. It is not supported here, and
// `--engine` does not exist as an option on purpose.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** What one generation run is asked to produce. */
export interface SyntheaRunRequest {
  /**
   * BASE directory for the run, mapped to `--exporter.baseDirectory=`.
   *
   * NOT the directory the bundles land in: Synthea appends `/fhir/` to this. Use
   * `fhirDirOf(baseDir)` to get the directory to read patients from — see trap 3
   * in the header.
   */
  readonly baseDir: string;
  /** Working directory containing the Synthea checkout (with `run_synthea`). */
  readonly syntheaRoot: string;
  /** Population size (`-p`). */
  readonly population: number;
  /** RNG seed (`-s`). Pin it — an unpinned population is not reproducible. */
  readonly seed: number;
  /** Reference date as `YYYYMMDD` (`-r`). */
  readonly referenceDate?: string;
  /** `-a min-max`, e.g. `18-90`. */
  readonly ageRange?: string;
  /** State and optionally city, passed positionally. */
  readonly state?: string;
  readonly city?: string;
}

export interface SyntheaRunResult {
  /** The BASE directory, as requested. Bundles are in `fhirDirOf(baseDir)`. */
  readonly baseDir: string;
  /** The exact argv used, for the manifest and for reproducing by hand. */
  readonly argv: readonly string[];
  readonly stdout: string;
  /** Parsed from `Records: total=N, alive=N, dead=N`. */
  readonly records?: { total: number; alive: number; dead: number };
}

/** Injected so tests run with no JVM and no network. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface JdkResolution {
  readonly javaHome: string;
  readonly javaVersion?: string;
  readonly source: 'explicit' | 'JAVA_HOME' | 'discovered';
}

/** Injectable so a test can describe a machine without impersonating one. */
export type JavaLocator = () => JdkResolution | undefined;

/** Where Synthea's `run_synthea` lives, by default. */
export const DEFAULT_SYNTHEA_ROOT = process.env.SYNTHEA_ROOT ?? join(process.cwd(), '.harness', 'synthea');

/** Minimum runtime the reference implementation documents. */
export const MIN_JAVA_MAJOR = 17;

/**
 * Find a JDK 17+ without trusting `java` on PATH.
 *
 * Order: an explicit JAVA_HOME, then a scan of the usual install roots. Bare
 * `java` is deliberately NOT an option — S0's machine had `javac` 17 and `java`
 * 1.8, so resolving by command name produces a run that fails at JVM startup for
 * a reason the error message does not explain.
 */
export function discoverJdk(env: NodeJS.ProcessEnv = process.env, roots: readonly string[] = ['/usr/lib/jvm']): JdkResolution | undefined {
  const fromEnv = env.JAVA_HOME;
  if (fromEnv && existsSync(join(fromEnv, 'bin', 'java'))) {
    const major = javaMajorAt(fromEnv);
    if (major !== undefined && major >= MIN_JAVA_MAJOR) {
      return { javaHome: fromEnv, javaVersion: String(major), source: 'JAVA_HOME' };
    }
  }
  const candidates: Array<{ home: string; major: number }> = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const home = join(root, entry);
      const major = javaMajorAt(home);
      if (major !== undefined) candidates.push({ home, major });
    }
  }
  // Highest qualifying version wins, so a machine with 17 and 21 does not depend
  // on directory ordering.
  const best = candidates.filter((c) => c.major >= MIN_JAVA_MAJOR).sort((a, b) => b.major - a.major)[0];
  if (!best) return undefined;
  return { javaHome: best.home, javaVersion: String(best.major), source: 'discovered' };
}

/**
 * Read a JDK's major version from its `release` file.
 *
 * Deliberately not by executing `java -version`: this is called while resolving
 * WHICH java to execute, and shelling out to every candidate is both slow and the
 * thing being avoided. The `release` file is a documented part of a JDK image.
 */
function javaMajorAt(javaHome: string): number | undefined {
  if (!existsSync(join(javaHome, 'bin', 'java'))) return undefined;
  const release = join(javaHome, 'release');
  if (!existsSync(release)) return undefined;
  try {
    if (!statSync(release).isFile()) return undefined;
    const text = readFileSync(release, 'utf8');
    const match = /JAVA_VERSION="(\d+)/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse Synthea's own summary line. Absent means the run did not complete. */
export function parseRecords(stdout: string): { total: number; alive: number; dead: number } | undefined {
  const m = /Records:\s*total=(\d+),\s*alive=(\d+),\s*dead=(\d+)/.exec(stdout);
  if (!m) return undefined;
  return { total: Number(m[1]), alive: Number(m[2]), dead: Number(m[3]) };
}

/**
 * Where Synthea writes the generated bundles, given the base directory it was
 * handed.
 *
 * The one place trap 3 from the header is expressed. Synthea appends `fhir/` to
 * whatever base it is given, so this is the directory an ingest reads from.
 */
export function fhirDirOf(baseDir: string): string {
  return join(baseDir, 'fhir');
}

/** The argv for one run. Exported so the manifest can record it and a human can replay it. */
export function buildArgv(request: SyntheaRunRequest): string[] {
  const argv = ['-p', String(request.population), '-s', String(request.seed)];
  if (request.referenceDate) argv.push('-r', request.referenceDate);
  if (request.ageRange) argv.push('-a', request.ageRange);
  // NOT `-o`. See the header: `-o` is overflow population and would silently send
  // the output to Synthea's default directory instead.
  argv.push(`--exporter.baseDirectory=${request.baseDir}`);
  if (request.state) argv.push(request.state);
  if (request.city) argv.push(request.city);
  return argv;
}

export class SyntheaRunner {
  constructor(
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
    private readonly locateJdk: JavaLocator = () => discoverJdk(),
  ) {}

  /** Whether a generation run is possible on this machine, and why not. */
  preflight(): { ok: true; jdk: JdkResolution } | { ok: false; reason: string } {
    const jdk = this.locateJdk();
    if (!jdk) {
      return {
        ok: false,
        reason:
          `no JDK ${MIN_JAVA_MAJOR}+ found. Synthea needs a ${MIN_JAVA_MAJOR}+ RUNTIME — a JDK on PATH is not enough, ` +
          `because the java runtime and the javac compiler can differ (S0 found javac 17 with java 1.8). ` +
          `Install one (e.g. \`sudo apt install openjdk-${MIN_JAVA_MAJOR}-jdk\`) or set JAVA_HOME to a ${MIN_JAVA_MAJOR}+ JDK.`,
      };
    }
    return { ok: true, jdk };
  }

  /**
   * Run one generation.
   *
   * Throws rather than returning a partial result: a run that produced no
   * `Records:` line did not finish, and a caller that carried on would write a
   * manifest describing a population that does not exist.
   */
  async run(request: SyntheaRunRequest): Promise<SyntheaRunResult> {
    const pre = this.preflight();
    if (!pre.ok) throw new Error(`synthea-unavailable: ${pre.reason}`);
    const script = join(request.syntheaRoot, 'run_synthea');
    if (!existsSync(script)) {
      throw new Error(`synthea-not-found: ${script} does not exist — clone the reference implementation or set SYNTHEA_ROOT`);
    }

    const argv = buildArgv(request);
    const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: pre.jdk.javaHome };
    const { stdout, stderr, code } = await this.commandRunner(script, argv, { cwd: request.syntheaRoot, env });
    if (code !== 0) {
      throw new Error(`synthea-failed: exit ${code}${stderr.trim() ? ` — ${stderr.trim().slice(-500)}` : ''}`);
    }
    const records = parseRecords(stdout);
    if (!records) {
      throw new Error(`synthea-incomplete: no "Records:" summary in output, so the run did not finish`);
    }
    return { baseDir: request.baseDir, argv, stdout, records };
  }
}

const defaultCommandRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ stdout, stderr, code: code ?? 1 }));
  });
