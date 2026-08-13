import { buildApp } from '../dist/src/server/app.js';
import { PostgresEventStore } from '../dist/src/server/postgres-event-store.js';
import { Telemetry } from '../dist/src/server/telemetry.js';
import { ckdNavigationPack } from '../dist/packs/ckd-navigation/index.js';

const store = new PostgresEventStore({ mode: 'memory' });
const telemetry = new Telemetry({ sink: () => {}, clock: () => Date.now() });
const app = await buildApp({
  store, telemetry, packs: [ckdNavigationPack],
  authenticate: async () => ({ subjectId: 's', actorId: 's', roles: ['admin'], scopes: [], purposeOfUse: 'operations' }),
  checkHealth: async () => ({ db: true, redis: true }),
});
async function post(url, body) { const r = await app.inject({ method: 'POST', url, payload: body }); return { status: r.statusCode, body: r.json() }; }
const r1 = await post('/admin/knowledge/agent/turn', { question: 'describe nlm.rxnorm' });
console.log('react turn:', r1.status, 'strategy=' + r1.body.strategy, 'steps=' + r1.body.steps.length);
console.log('  answer:', r1.body.answer);
const r2 = await post('/admin/knowledge/agent/turn', { question: 'compare kidney workflow sources across all packs step by step' });
console.log('plan turn:', r2.status, 'strategy=' + r2.body.strategy, 'steps=' + r2.body.steps.length);
console.log('  answer:', r2.body.answer);
await app.close();
