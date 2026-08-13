// Live end-to-end proof: boot the knowledge layer and run a real sync against
// public APIs. No mocks. Prints an outcome summary that must show non-zero
// artifacts fetched + written to disk.

import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapKnowledgeLayer } from '../dist/src/knowledge/index.js';

const storeDir = process.env.STORE_DIR ?? '/home/user/workspace/.harness/knowledge-live';
if (existsSync(storeDir) && process.env.FRESH === '1') rmSync(storeDir, { recursive: true, force: true });
mkdirSync(storeDir, { recursive: true });

const events = [];
const { engine, sources, adapters } = bootstrapKnowledgeLayer({
  storeDir,
  onEvent: (e) => events.push(e),
});

console.log(`Sources: ${sources.list().length}`);
console.log(`Adapters bound: ${adapters.list().length}`);

// Run a bounded slice on the truly-public adapters.
const targets = process.argv.slice(2);
const defaultTargets = ['nlm.rxnorm', 'openfda.drug.enforcement', 'nlm.medlineplus', 'clinicaltrials.gov'];
const list = targets.length > 0 ? targets : defaultTargets;

for (const id of list) {
  process.stdout.write(`\n== ${id}\n`);
  const r = await engine.run({ sourceId: id, actor: 'live-script' });
  if (!r.ok) { console.error(`  FAILED: ${r.error}`); continue; }
  console.log(`  ok · fetched=${r.summary?.totalFetched} · extracted=${r.summary?.totalExtracted} · changes=${r.summary?.changes.length}`);
  const dir = join(storeDir, id, 'artifacts');
  if (existsSync(dir)) {
    const files = readdirSync(dir);
    console.log(`  artifacts on disk: ${files.length}`);
    if (files.length > 0) console.log(`  first: ${files[0]}`);
  }
}
console.log(`\n${events.length} events emitted; last: ${events.at(-1)?.type}`);
