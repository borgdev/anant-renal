// Boot the full Fastify app, hit knowledge routes, print outcomes.
// Proves M20j (admin routes) wired end-to-end against real HTTP.

import { buildApp } from '../dist/src/server/app.js';
import { PostgresEventStore } from '../dist/src/server/postgres-event-store.js';
import { Telemetry } from '../dist/src/server/telemetry.js';
import { ckdNavigationPack } from '../dist/packs/ckd-navigation/index.js';
import { dialysisProviderPack } from '../dist/packs/dialysis-provider/index.js';
import { hospitalAtHomePack } from '../dist/packs/hospital-at-home/index.js';

const store = new PostgresEventStore({ mode: 'memory' });
const telemetry = new Telemetry({ sink: () => {}, clock: () => Date.now() });
const app = await buildApp({
  store, telemetry,
  packs: [ckdNavigationPack, dialysisProviderPack, hospitalAtHomePack],
  authenticate: async () => ({ subjectId: 'smoke', actorId: 'smoke', roles: ['admin'], scopes: [], purposeOfUse: 'operations' }),
  checkHealth: async () => ({ db: true, redis: true }),
});

async function get(path) { const r = await app.inject({ method: 'GET', url: path }); console.log(path, '·', r.statusCode); return r.json(); }
async function post(path, body) { const r = await app.inject({ method: 'POST', url: path, payload: body }); console.log('POST', path, '·', r.statusCode); return r.json(); }

const sources = await get('/admin/knowledge/sources');
console.log(`sources: ${sources.sources.length}`);
console.log(`  first: ${sources.sources[0].id} · adapter=${sources.sources[0].adapter} · needsCreds=${sources.sources[0].credentialsRequired.length}`);

const reach = await get('/admin/knowledge/reach');
console.log(`reach entries: ${reach.table.length} · top: ${reach.table[0].sourceId} → ${reach.table[0].packs.length} packs`);

const rxn = await get('/admin/knowledge/sources/nlm.rxnorm');
console.log(`nlm.rxnorm: ${rxn.spec.name} · manifest=${rxn.manifest ? 'yes' : 'no'}`);

const fanout = await get('/admin/knowledge/subscriptions/source/nlm.rxnorm');
console.log(`fanout for nlm.rxnorm: packs=${fanout.fanout.totalPacks} agents=${fanout.fanout.totalAgents}`);

const test = await post('/admin/knowledge/test-credential/nlm.rxnorm', {});
console.log(`credential-test nlm.rxnorm: ok=${test.ok} · ${test.message}`);

// Trigger a real sync
const sync = await post('/admin/knowledge/sync/openfda.drug.enforcement', { actor: 'smoke' });
console.log(`sync openfda: ok=${sync.ok} · extracted=${sync.summary?.totalExtracted} · changes=${sync.summary?.changes.length}`);

const arts = await get('/admin/knowledge/artifacts/openfda.drug.enforcement?limit=3');
console.log(`artifacts: total=${arts.total} · sample=${arts.artifacts[0]?.title.slice(0, 60)}`);

const due = await get('/admin/knowledge/schedule/due');
console.log(`due sources: ${due.due.length} · top: ${due.due[0]?.sourceId}`);

await app.close();
