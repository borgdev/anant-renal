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

// Durable Postgres bootstrap, shared by the dev and production entry points.
//
// Why this exists: the dev profile used to hand the app an in-memory stand-in for
// `PostgresEventStore`. That object is ALSO the persistence adapter's backing
// store, so the entire swarm workspace — cohort definitions and memberships,
// outcome episodes, evidence reviews, releases, NBA decisions — was discarded on
// every restart, while every endpoint kept returning 200. Nothing failed; the
// state simply was not there, and a "durable" decision recorded a minute earlier
// was gone.
//
// A missing DATABASE is the failure that hid it: Postgres was listening, the
// credentials worked, and the connection was refused only because the database
// had never been created — so the durable path was never once exercised. That is
// why this module creates the database itself rather than requiring a manual
// `createdb` step nobody would remember.

import { Pool } from 'pg';
import { PostgresEventStore } from './postgres-event-store.js';

export interface PostgresStoreOptions {
  readonly databaseUrl: string;
  readonly schema: string;
}

export interface DurableStore {
  readonly store: PostgresEventStore;
  readonly pool: Pool;
  readonly database: string;
  readonly schema: string;
}

/** Database name from a connection URL (path component, without the leading `/`). */
export function databaseNameOf(databaseUrl: string): string {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!name) throw new Error(`no database name in connection string: ${databaseUrl}`);
  return decodeURIComponent(name);
}

/** Connection URL pointing at the `postgres` maintenance database. */
function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * Create the target database when it does not exist.
 *
 * Idempotent, and deliberately tolerant: if the maintenanace database is
 * unreachable (managed Postgres often hides it) or the role cannot create
 * databases, the caller still proceeds — a later connection error is then the
 * real, attributable failure rather than a masked one.
 */
export async function ensureDatabaseExists(databaseUrl: string): Promise<{ created: boolean; note?: string }> {
  const name = databaseNameOf(databaseUrl);
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return { created: false, note: `database name "${name}" is not a plain identifier; skipping auto-create` };
  }
  const admin = new Pool({ connectionString: maintenanceUrl(databaseUrl), max: 1 });
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount && found.rowCount > 0) return { created: false };
    // CREATE DATABASE cannot be parameterised; `name` is validated above and
    // quoted as an identifier.
    await admin.query(`CREATE DATABASE "${name}"`);
    return { created: true };
  } catch (err) {
    return { created: false, note: err instanceof Error ? err.message : String(err) };
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/**
 * Open the durable event/ledger/audit store, creating the database and schema if
 * they are missing. Throws with an actionable message rather than degrading
 * quietly — callers decide whether a memory fallback is acceptable, and must say
 * so out loud when it is.
 */
export async function openDurableStore(opts: PostgresStoreOptions): Promise<DurableStore> {
  const database = databaseNameOf(opts.databaseUrl);
  const ensured = await ensureDatabaseExists(opts.databaseUrl);
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 20 });
  try {
    const store = new PostgresEventStore(pool, opts.schema);
    await store.applyMigrations();
    // A pool is lazy: prove the connection before reporting success, so a
    // "durable" store is never returned for a database that cannot be reached.
    await pool.query('SELECT 1');
    return { store, pool, database, schema: opts.schema };
  } catch (err) {
    await pool.end().catch(() => undefined);
    const hint = ensured.created ? ' (database was just created — was it reachable?)' : '';
    throw new Error(
      `durable store unavailable: ${err instanceof Error ? err.message : String(err)}` +
      ` [database=${database} schema=${opts.schema}${hint}]`,
    );
  }
}

/** Live reachability probe used by /health, so readiness reports the truth. */
export async function postgresReachable(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
