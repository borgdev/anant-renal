#!/usr/bin/env node
// Flake probe — run a test file repeatedly and report outcome disagreement.
//
// Why this exists: a flaky test is indistinguishable from a real regression when
// you see it once. The auth-session TTL bug (a 1 ms TTL, passing alone and
// failing roughly one full-suite run in ten) cost real diagnosis time precisely
// because "it failed in a full run" has two explanations and only one of them is
// your change.
//
// Passing alone is NOT evidence a test is sound — it is evidence the test is not
// sensitive to load. This runs it under repetition and reports disagreement,
// which is the only signal that actually distinguishes the two cases.
//
// Usage:
//   node scripts/flake-probe.mjs                      # built-in timing-sensitive set
//   node scripts/flake-probe.mjs tests/foo.test.ts    # specific files
//   node scripts/flake-probe.mjs --runs 5 --all-timing-sensitive
//
// Exit code 1 if any file disagreed across runs, so it can gate a release check.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const runs = runsIdx === -1 ? 3 : Number(args[runsIdx + 1]);
const explicit = args.filter((a) => !a.startsWith('--') && a.endsWith('.ts'));

// Files that assert against real time: clocks, TTLs, sleeps and pauses. These are
// where a flake hides, because their assertions are correct on an idle machine.
const TIMING_SENSITIVE = [
  'tests/auth.test.ts',
  'tests/auth-session-persistence.test.ts',
  'tests/realm-lifecycle.test.ts',
  'tests/simulator.test.ts',
  'tests/fleet-governor.test.ts',
  'tests/event-broker-conformance.test.ts',
  'tests/outbox-drain.test.ts',
  'tests/longitudinal.test.ts',
];

const files = explicit.length > 0 ? explicit : TIMING_SENSITIVE;

console.log(`flake probe: ${files.length} file(s) x ${runs} runs\n`);

const results = [];

for (const file of files) {
  const outcomes = [];
  for (let i = 0; i < runs; i += 1) {
    const res = spawnSync(
      'npx',
      ['vitest', 'run', file, '--no-file-parallelism', '--reporter', 'basic'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, KNOWLEDGE_STORE_DIR: `/tmp/flake-probe-${process.pid}` },
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    // A run "passed" only if vitest exited 0 AND reported no failed tests.
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const failedCount = /Tests\s+(\d+) failed/.exec(out)?.[1];
    outcomes.push(res.status === 0 && !failedCount ? 'pass' : 'FAIL');
  }
  const unique = [...new Set(outcomes)];
  const verdict = unique.length === 1 ? (unique[0] === 'pass' ? 'stable' : 'STABLE-FAIL') : 'FLAKY';
  results.push({ file, outcomes, verdict });
  console.log(`${verdict.padEnd(12)} ${file}  [${outcomes.join(' ')}]`);
}

const flaky = results.filter((r) => r.verdict === 'FLAKY');
const broken = results.filter((r) => r.verdict === 'STABLE-FAIL');

console.log('');
if (flaky.length > 0) {
  console.log(`${flaky.length} flaky: ${flaky.map((f) => f.file).join(', ')}`);
}
if (broken.length > 0) {
  console.log(`${broken.length} failing every run (a real failure, not a flake): ${broken.map((f) => f.file).join(', ')}`);
}
if (flaky.length === 0 && broken.length === 0) {
  console.log(`no flake detected across ${files.length * runs} runs`);
}
console.log('NOTE: "stable" here means "not load-sensitive", not "correct". A test can be');
console.log('      stably wrong — see the vacuous-assertion guards in realm-lifecycle.test.ts.');

process.exit(flaky.length > 0 || broken.length > 0 ? 1 : 0);
