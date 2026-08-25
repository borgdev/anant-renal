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
