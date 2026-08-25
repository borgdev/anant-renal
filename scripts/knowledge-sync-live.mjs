/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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
