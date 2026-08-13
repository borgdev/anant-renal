// Boots the knowledge layer against workspace storage and prints:
//   - Total sources by category / tier / cadence
//   - Reach table (source -> packs that use it)
//   - Per-pack knowledge bill (what the pack needs, freshness, blocking)

import { bootstrapKnowledgeLayer } from '../dist/src/knowledge/index.js';

const events = [];
const reg = bootstrapKnowledgeLayer({
  storeDir: '/home/user/workspace/.harness/knowledge',
  onEvent: (e) => { events.push(e); },
});

const all = reg.list();
const byCategory = {}; const byTier = {}; const byCadence = {};
for (const s of all) {
  byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  byTier[s.tier] = (byTier[s.tier] || 0) + 1;
  byCadence[s.cadence] = (byCadence[s.cadence] || 0) + 1;
}

console.log('══════════════════════════════════════════════════════════');
console.log(' Healthcare Harness — Knowledge Layer report');
console.log('══════════════════════════════════════════════════════════\n');
console.log(`Sources registered:    ${all.length}`);
console.log(`Subscriptions loaded:  ${reg.reachTable().reduce((n, r) => n + r.packs.length, 0)}`);
console.log(`Events emitted:        ${events.length}\n`);

console.log('── Sources by category ────────────────────────────────');
for (const [k, v] of Object.entries(byCategory).sort((a,b) => b[1] - a[1])) console.log(`  ${k.padEnd(30)} ${v}`);
console.log('\n── Sources by access tier ─────────────────────────────');
for (const [k, v] of Object.entries(byTier)) console.log(`  ${k.padEnd(30)} ${v}`);
console.log('\n── Sources by default cadence ─────────────────────────');
for (const [k, v] of Object.entries(byCadence)) console.log(`  ${k.padEnd(30)} ${v}`);

console.log('\n── Reach table: source → packs consuming it ───────────');
for (const row of reg.reachTable().slice(0, 20)) {
  const src = reg.get(row.sourceId);
  const fan = reg.fanout(row.sourceId);
  console.log(`  ${row.sourceId.padEnd(38)} ${String(row.packs.length).padStart(2)} packs, ${String(row.usages).padStart(2)} usages, effective cadence: ${fan.effectiveCadence}${fan.anyBlocking ? ' [BLOCKING]' : ''}`);
  console.log(`      ${(src?.name || '').slice(0,90)}`);
  console.log(`      packs: ${row.packs.join(', ')}`);
}

const uniquePacks = new Set();
for (const list of reg.reachTable()) for (const p of list.packs) uniquePacks.add(p);
console.log('\n── Per-pack knowledge bill ────────────────────────────');
for (const packId of [...uniquePacks].sort()) {
  const bill = reg.bill(packId);
  console.log(`\n  ${packId}`);
  console.log(`    total sources:      ${bill.totalSources}`);
  console.log(`    blocking:           ${bill.blockingSources.length} (${bill.blockingSources.slice(0,3).join(', ')}${bill.blockingSources.length > 3 ? ', …' : ''})`);
  console.log(`    by category:        ${Object.entries(bill.byCategory).map(([k,v]) => `${k}:${v}`).join(', ')}`);
  console.log(`    by tier:            ${Object.entries(bill.byTier).map(([k,v]) => `${k}:${v}`).join(', ')}`);
}

console.log('\n══════════════════════════════════════════════════════════\n');
