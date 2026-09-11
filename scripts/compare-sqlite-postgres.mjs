// Compare every table between the legacy SQLite file and Postgres before any
// cleanup: deleting the file is only safe if the state in it is already elsewhere.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import pg from 'pg';

const DB_PATH = process.env.HH_DB_PATH ?? '.harness/data/harness.db';
if (!existsSync(DB_PATH)) {
  // Already migrated and cleaned up — the expected end state, not an error.
  console.log(`no SQLite database at ${DB_PATH} — nothing to verify (already migrated and removed).`);
  process.exit(0);
}

const lite = new DatabaseSync(DB_PATH, { readOnly: true });
const pool = new pg.Pool({ connectionString: process.env.HH_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/healthcare_harness' });

const liteTables = lite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const pgTables = new Set((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name));

const count = (sql, t) => { try { return sql.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n; } catch { return -1; } };
const pgCount = async (t) => { try { return (await pool.query(`SELECT count(*)::int AS n FROM public."${t}"`)).rows[0].n; } catch { return -1; } };

let missing = 0;
let outboxRows = 0;
console.log('table                        sqlite     postgres   status');
for (const t of liteTables) {
  const l = count(lite, t);
  if (!pgTables.has(t)) { console.log(`${t.padEnd(28)} ${String(l).padStart(8)}   ${'—'.padStart(8)}   ONLY IN SQLITE`); missing += 1; continue; }
  const p = await pgCount(t);
  const ok = p >= l;
  if (!ok) missing += 1;
  if (t === 'event_outbox') outboxRows = l;
  console.log(`${t.padEnd(28)} ${String(l).padStart(8)}   ${String(p).padStart(8)}   ${ok ? 'present in postgres' : 'NOT FULLY MIGRATED'}`);
}

console.log(`\ntables with data missing from Postgres: ${missing}`);
console.log(`event_outbox in sqlite: ${outboxRows} rows (transport log, intentionally not migrated)`);

const size = statSync(DB_PATH).size;
console.log(`sqlite db file: ${(size / 1024 / 1024).toFixed(0)} MB`);

lite.close();
await pool.end();
