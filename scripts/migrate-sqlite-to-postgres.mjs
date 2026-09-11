// Migrate product state from the SQLite harness database into Postgres.
//
// Why this exists: the dev profile historically persisted SqlStore state to
// SQLite (`.harness/data/harness.db`). Pointing the runtime at Postgres without
// moving that data would leave every realm, patient, workspace document and
// console session behind — no error, just an empty system, which is the exact
// failure mode this whole change set is about.
//
// Idempotent: rows are inserted with ON CONFLICT DO NOTHING, so re-running is safe
// and never clobbers a newer Postgres row.
//
//   npm run storage:migrate -- --dry-run
//   npm run storage:migrate
//   npm run storage:migrate -- --include-outbox
//
// Switching backends is a two-step procedure, and the second step matters:
//
//   1. npm run storage:migrate        (move the state)
//   2. npm run storage:verify         (prove every table is present in Postgres)
//
// Only delete the SQLite file (~1.5 GB with its WAL) once `storage:verify`
// reports every state table present. Do not infer it from the app working: a
// harness running on Postgres happily serves a system whose old state sat in a
// file nobody ever read again.
//
// `event_outbox` is skipped by default: it is a transport log (1M+ delivered rows,
// ~1.3 GB) rather than state, and re-sending historical events is not desired.
// `auth_sessions` rows are migrated but are ephemeral — they expire or get pruned.

import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = flag('dry-run');
const INCLUDE_OUTBOX = flag('include-outbox');
const FROM = value('from', '.harness/data/harness.db');
const TO = value('to', process.env.HH_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/healthcare_harness');
const SCHEMA = value('schema', process.env.HH_DATABASE_SCHEMA ?? 'public');
const BATCH = 500;

/** SQLite yields BigInt for wide integers; pg needs a value it can bind. */
function normalise(v) {
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v);
  return v;
}

const lite = new DatabaseSync(FROM, { readOnly: true });
const pool = new pg.Pool({ connectionString: TO, max: 4 });

const liteTables = lite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const pgTables = new Set(
  (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [SCHEMA])).rows.map((r) => r.table_name),
);

console.log(`source: ${FROM}`);
console.log(`target: ${TO} (schema ${SCHEMA})`);
console.log(`sqlite tables: ${liteTables.length} | postgres tables: ${pgTables.size}\n`);

let totalInserted = 0;
let totalSkipped = 0;
const moved = [];

for (const table of liteTables) {
  if (!pgTables.has(table)) {
    console.log(`  ${table.padEnd(26)} skipped (absent in Postgres)`);
    continue;
  }
  if (table === 'event_outbox' && !INCLUDE_OUTBOX) {
    const n = lite.prepare('SELECT count(*) AS n FROM event_outbox').get().n;
    console.log(`  ${table.padEnd(26)} skipped (transport log, ${n} rows — pass --include-outbox to move it)`);
    continue;
  }

  const cols = lite.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const rows = lite.prepare(`SELECT * FROM "${table}"`).all();
  if (rows.length === 0) {
    console.log(`  ${table.padEnd(26)} 0 rows`);
    continue;
  }

  if (DRY_RUN) {
    console.log(`  ${table.padEnd(26)} would insert ${rows.length} row(s)`);
    continue;
  }

  const colList = cols.map((c) => `"${c}"`).join(', ');
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const tuples = batch.map((row, r) => {
      const placeholders = cols.map((c, cIdx) => {
        values.push(normalise(row[c]));
        return `$${r * cols.length + cIdx + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const result = await pool.query(
      `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += result.rowCount ?? 0;
  }
  const skipped = rows.length - inserted;
  totalInserted += inserted;
  totalSkipped += skipped;
  moved.push({ table, inserted, skipped });
  console.log(`  ${table.padEnd(26)} inserted ${String(inserted).padStart(6)} | already present ${skipped}`);
}

console.log(`\n${DRY_RUN ? 'dry run: ' : ''}inserted ${totalInserted}, already present ${totalSkipped}`);
if (moved.some((m) => m.skipped > 0)) {
  console.log('(rows already present were left untouched — this migration never overwrites newer state)');
}

lite.close();
await pool.end();
