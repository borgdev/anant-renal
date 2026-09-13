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

/******************************************************************************
 * Load drill — hammer the read surfaces and report latency + error rate.
 *
 * Concurrently exercises the endpoints a real operator/exec session touches:
 *   - GET /health                     (infra health)
 *   - GET /api/context                (session context — the exec shell)
 *   - GET /admin/platform/packs       (Pack Studio registry)
 *   - GET /admin/platform/dlq         (ops DLQ view)
 *   - GET /admin/swarm/state          (exec runtime state)
 *
 * Usage:
 *   CONCURRENCY=32 REQUESTS=400 BASE_URL=http://127.0.0.1:3000 node scripts/load-drill.mjs
 ******************************************************************************/

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const REQUESTS = Number(process.env.REQUESTS ?? 400);
const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name} — ${detail}`); };

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: method !== 'GET' && method !== 'HEAD' ? (body === undefined ? '{}' : JSON.stringify(body)) : undefined,
  });
  if (method === 'POST' && path === '/auth/login') {
    const sc = res.headers.get('set-cookie') ?? '';
    const m = /hh_session=([^;]+)/.exec(sc);
    if (m) cookie = `hh_session=${m[1]}`;
  }
  return res;
}

const TARGETS = [
  { name: '/health', path: '/health' },
  { name: '/api/context', path: '/api/context' },
  { name: '/admin/platform/packs', path: '/admin/platform/packs' },
  { name: '/admin/platform/dlq', path: '/admin/platform/dlq' },
  { name: '/admin/swarm/state', path: '/admin/swarm/state' },
];

async function main() {
  console.log(`Load drill → ${BASE} · ${REQUESTS} requests × concurrency ${CONCURRENCY}\n`);
  const login = await api('POST', '/auth/login', { username: process.env.ADMIN_USER ?? 'admin', password: process.env.ADMIN_PASS ?? 'admin123' });
  step('admin login', login.status === 200 && Boolean(cookie), cookie ? 'session acquired' : 'MISSING');
  if (!cookie) { process.exitCode = 1; return; }

  const stats = new Map(TARGETS.map((t) => [t.name, { ok: 0, fail: 0, lat: [] }]));
  let inflight = 0;
  let scheduled = 0;
  const runOne = async (target) => {
    const s = stats.get(target.name);
    const t0 = performance.now();
    try {
      const res = await api('GET', target.path);
      const ms = performance.now() - t0;
      s.lat.push(ms);
      if (res.ok) s.ok += 1; else s.fail += 1;
    } catch { s.fail += 1; }
  };
  const pump = async () => {
    while (scheduled < REQUESTS) {
      if (inflight >= CONCURRENCY) return;
      inflight += 1; scheduled += 1;
      const target = TARGETS[scheduled % TARGETS.length];
      runOne(target).finally(() => { inflight -= 1; pump(); });
    }
  };
  const t0 = performance.now();
  await pump();
  while (inflight > 0) await new Promise((r) => setTimeout(r, 25));
  const wall = performance.now() - t0;

  let allOk = true;
  for (const t of TARGETS) {
    const s = stats.get(t.name);
    const lat = s.lat.sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length * 0.5)] ?? 0;
    const p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
    const p99 = lat[Math.floor(lat.length * 0.99)] ?? 0;
    const ok = s.fail === 0;
    if (!ok) allOk = false;
    step(`${t.name} (${s.ok + s.fail} req)`, ok, `p50 ${p50.toFixed(0)}ms · p95 ${p95.toFixed(0)}ms · p99 ${p99.toFixed(0)}ms · ${s.fail} errors`);
  }
  console.log(`\nWall time ${(wall / 1000).toFixed(2)}s · ${(REQUESTS / (wall / 1000)).toFixed(0)} req/s · ${allOk ? 'no errors' : 'ERRORS DETECTED'}`);
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
