#!/usr/bin/env node
// CLI: compile a directory of mixed entity files into a Healthcare Harness pack.
//
// Usage:
//   node scripts/compile-entity-pack.mjs --input ./examples/entity-packs/mixed-sample \
//        --pack-id my-clinic-custom --owner-org demo-clinic
//   Add --dry-run to preview without writing.
//   Add --ollama to enrich narrative docs via a running Ollama.

import { writeFileSync, mkdirSync } from 'node:fs';
import { compileEntityPack } from '../dist/src/entity-compiler/index.js';

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const input = arg('--input');
const packId = arg('--pack-id');
const ownerOrg = arg('--owner-org', 'unknown-org');
const dryRun = arg('--dry-run', false) === true;
const useOllama = arg('--ollama', false) === true;

if (!input || !packId) {
  console.error('Usage: compile-entity-pack --input <dir> --pack-id <id> [--owner-org <org>] [--dry-run] [--ollama]');
  process.exit(1);
}

const result = await compileEntityPack({
  inputPath: input,
  packId,
  ownerOrg,
  displayName: packId,
  useOllama,
  dryRun,
});

console.log('\n=== Compile report ===');
console.log(JSON.stringify(result.report, null, 2));

mkdirSync('/home/user/workspace/hh-admin-ui', { recursive: true });
writeFileSync(
  '/home/user/workspace/hh-admin-ui/entity-compiler-report.json',
  JSON.stringify(result.report, null, 2),
);
console.log('\nWrote report to hh-admin-ui/entity-compiler-report.json');
console.log(`Entities loaded: ${result.report.entitiesLoaded}  ` +
            `emitted: ${result.report.entitiesEmitted}  ` +
            `rejected: ${result.report.entitiesRejected}  ` +
            `agents: ${result.report.agentsGenerated}${dryRun ? '  (dry-run \u2014 nothing written)' : ''}`);
