/******************************************************************************
 * Chaos drill — inject a real DLQ incident, remediate it, and verify restore.
 *
 * Exercises the governed DLQ journey over HTTP exactly as an operator would:
 *
 *   1. baseline  — GET /admin/platform/dlq (pre-drill incident count)
 *   2. inject    — POST /admin/platform/dlq/_drill/seed (gated fixture, dev/demo)
 *   3. verify    — GET /admin/platform/dlq shows the incident (incidents +1)
 *   4. remediate — POST /admin/platform/dlq/:id/acknowledge (owned, durable)
 *   5. replay    — POST /admin/platform/dlq/:id/replay (idempotent, original key)
 *   6. restore   — GET /admin/platform/dlq shows the incident cleared
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/chaos-drill.mjs
 *   BASE_URL=... node scripts/chaos-drill.mjs --skip-replay   # no broker
 ******************************************************************************/

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const skipReplay = process.argv.includes('--skip-replay');
const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name} — ${detail}`); };

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: method !== 'GET' && method !== 'HEAD' ? (body === undefined ? '{}' : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  if (method === 'POST' && path === '/auth/login') {
    const sc = res.headers.get('set-cookie') ?? '';
    const m = /hh_session=([^;]+)/.exec(sc);
    if (m) cookie = `hh_session=${m[1]}`;
  }
  return { status: res.status, json };
}
const J = async (method, path, body) => {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
};

async function main() {
  console.log(`Chaos drill → ${BASE}${skipReplay ? ' (replay skipped)' : ''}\n`);
  const login = await api('POST', '/auth/login', { username: process.env.ADMIN_USER ?? 'admin', password: process.env.ADMIN_PASS ?? 'admin123' });
  step('admin login', login.status === 200 && Boolean(cookie), cookie ? 'session acquired' : 'MISSING');
  if (!cookie) { process.exitCode = 1; return; }

  // 1. Baseline.
  const before = await J('GET', '/admin/platform/dlq');
  const beforeIncidents = (before.incidents ?? []).length;
  step('DLQ baseline', true, `${beforeIncidents} incident(s), broker depth ${before.brokerDepth}, outbox pending ${before.outbox?.pending ?? '—'}`);

  // 2. Inject a synthetic bridge incident.
  let seeded;
  try {
    seeded = await J('POST', '/admin/platform/dlq/_drill/seed', { reason: 'chaos drill poison message', topic: 'anant.agent.output.v1' });
    step('inject DLQ incident', true, `seeded ${seeded.outboxId} → ${seeded.topic}`);
  } catch (e) {
    step('inject DLQ incident', false, e.message);
    console.log('\n  The seed fixture is gated to dev/demo/test (ANANT_ENV) or HH_ENABLE_DRILLS=1.');
    process.exitCode = 1; return;
  }

  // 3. Verify the incident is visible.
  const mid = await J('GET', '/admin/platform/dlq');
  const midItems = (mid.incidents ?? []).filter((i) => i.outboxId === seeded.outboxId);
  step('incident visible in DLQ', midItems.length === 1, midItems.length === 1 ? `1 matching incident` : 'not found');

  // 4. Remediate — acknowledge with an owner.
  const ack = await J('POST', `/admin/platform/dlq/${seeded.outboxId}/acknowledge`, { owner: 'drill-operator', reason: 'chaos drill ownership' });
  step('acknowledge (owned)', Boolean(ack.item?.owner), `owner ${ack.item?.owner}, status ${ack.item?.status}`);

  // 5. Replay — idempotent, original business key.
  if (!skipReplay) {
    try {
      const rp = await J('POST', `/admin/platform/dlq/${seeded.outboxId}/replay`, { owner: 'drill-operator', reason: 'chaos drill replay' });
      step('replay (idempotent)', Boolean(rp.replayId), `replay ${rp.replayId}`);
    } catch (e) {
      step('replay (idempotent)', false, `${e.message} — broker required; run against the compose boot or use --skip-replay`);
      results.push({ name: 'incident cleared', ok: false, detail: 'skipped' });
    }
  }

  // 6. Verify restore — incident no longer in the DLQ incidents list.
  const after = await J('GET', '/admin/platform/dlq');
  const stillThere = (after.incidents ?? []).filter((i) => i.outboxId === seeded.outboxId);
  step('incident cleared (restored)', stillThere.length === 0, stillThere.length === 0 ? 'DLQ incidents back to baseline' : 'still present');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nChaos drill complete — ${results.length - failed}/${results.length} checks passed.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
