#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Clean up the demo — stop the simulator + drop its sim:* realms, remove the
// demo decision fabric (outcome episodes / NBA decisions), prune the delivered
// event-outbox backlog (the disk-filler), then run age-based retention.
//
//   node scripts/cleanup-demo.mjs            # via the running server (HTTP)
//   node scripts/cleanup-demo.mjs --direct   # direct SQLite cleanup (server STOPPED)
//   node scripts/cleanup-demo.mjs --keep 5000
//
// HTTP mode logs in as the seeded console admin (admin / admin123; override
// with HH_ADMIN_USER / HH_ADMIN_PASS) and POSTs /admin/demo/cleanup so the
// server's in-memory caches AND the DB stay consistent.
//
// --direct opens .harness/data/harness.db (HH_DB_PATH) with busy_timeout,
// prunes delivered outbox rows, deletes the demo workspace kinds + sim
// fleet/specs/snapshots, then VACUUMs to return disk. Stop the server first.
// ---------------------------------------------------------------------------

import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const direct = args.includes('--direct');
const confirm = args.includes('--confirm');
const keepIdx = args.indexOf('--keep');
const keep = keepIdx >= 0 ? Math.max(0, Math.min(50000, Math.floor(Number(args[keepIdx + 1]) || 1000))) : 1000;
const port = process.env.HH_HTTP_PORT ?? '3000';
const base = `http://127.0.0.1:${port}`;
const dbPath = process.env.HH_DB_PATH ?? '.harness/data/harness.db';

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

async function httpCleanup() {
  console.log(`[cleanup] server mode → ${base}`);
  const user = process.env.HH_ADMIN_USER ?? 'admin';
  const pass = process.env.HH_ADMIN_PASS ?? 'admin123';
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
    redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!login.ok || !cookie) {
    console.error(`[cleanup] login failed (${login.status}) — is the server running on ${base}? ${await login.text()}`);
    process.exit(1);
  }
  const res = await fetch(`${base}/admin/demo/cleanup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ keepOutbox: keep }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[cleanup] cleanup failed (${res.status}): ${j.error ?? JSON.stringify(j)}`);
    process.exit(1);
  }
  console.log('[cleanup] ok — report:');
  console.log(JSON.stringify(j.report ?? j, null, 2));
}

function directCleanup() {
  if (!existsSync(dbPath)) { console.error(`[cleanup] db not found: ${dbPath}`); process.exit(1); }
  if (!confirm && process.stdin.isTTY) {
    process.stdout.write(`[cleanup] wipe demo data + VACUUM ${dbPath}? type 'yes' to continue: `);
    // read a single line synchronously from stdin
  }
  const before = statSync(dbPath).size;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  const t0 = performance.now();

  // Fold any pending WAL frames into the main file and truncate the WAL, so the
  // VACUUM below can actually shrink the file.
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }

  const outbox = db.prepare(
    `DELETE FROM event_outbox WHERE status = 'delivered' AND id NOT IN (
       SELECT id FROM event_outbox WHERE status = 'delivered' ORDER BY created_at DESC LIMIT ?)`).run(keep);
  const wsKinds = db.prepare(`DELETE FROM swarm_workspace WHERE kind IN (?, ?)`).run('outcome-episode', 'nba-decision');
  const fleet = db.prepare(`DELETE FROM simulator_fleet`).run();
  const specs = db.prepare(`DELETE FROM realm_specs WHERE realm_id LIKE 'sim:%'`).run();
  const snaps = db.prepare(`DELETE FROM realm_snapshots WHERE realm_id LIKE 'sim:%'`).run();

  db.exec('VACUUM');
  db.close();
  const after = statSync(dbPath).size;
  console.log('[cleanup] direct DB cleanup complete');
  console.log(`  event_outbox delivered pruned : ${outbox.changes}`);
  console.log(`  workspace demo kinds removed  : ${wsKinds.changes}`);
  console.log(`  simulator_fleet cleared       : ${fleet.changes}`);
  console.log(`  sim:* realm_specs removed     : ${specs.changes}`);
  console.log(`  sim:* realm_snapshots removed : ${snaps.changes}`);
  console.log(`  file size ${mb(before)} → ${mb(after)} (freed ${mb(before - after)}) in ${(performance.now() - t0).toFixed(0)}ms`);
}

async function main() {
  if (direct) {
    if (!confirm && process.stdin.isTTY) {
      process.stdout.write(`[cleanup] wipe demo data + VACUUM ${dbPath}? type 'yes' to continue: `);
      const answer = await new Promise((resolve) => {
        const buf = [];
        process.stdin.on('data', (chunk) => {
          buf.push(chunk);
          if (String(chunk).includes('\n')) { process.stdin.pause(); resolve(Buffer.concat(buf).toString('utf8')); }
        });
      });
      if (answer.trim().toLowerCase() !== 'yes') { console.log('[cleanup] aborted'); process.exit(0); }
    }
    return directCleanup();
  }
  return httpCleanup();
}

main().catch((e) => { console.error('[cleanup]', e); process.exit(1); });
