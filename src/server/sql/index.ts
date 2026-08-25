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

// SQL storage facade — build a SqlDb from env and open a ready SqlStore.
//
//   HH_STORAGE=sqlite   (default) → SqliteSqlDb at HH_DB_PATH (default .harness/data/harness.db)
//   HH_STORAGE=postgres           → PostgresSqlDb at HH_DATABASE_URL
//   HH_DB_PATH=:memory:           → in-memory SQLite (tests)
//
// The store layer is dialect-agnostic; only this factory picks the SqlDb.

import { resolve } from 'node:path';
import { PostgresSqlDb, SqliteSqlDb, type SqlDb } from './sql-db.js';
import { SqlStore } from './sql-store.js';

export { SqlStore } from './sql-store.js';
export type { RealmSnapshotRow, BillingRow, NudgeRow, CounterfactualRunRow, FacilityRow, UnitRow, PatientRow } from './sql-store.js';
export { SqliteSqlDb, PostgresSqlDb, rewritePlaceholders, type SqlDb, type SqlDialect } from './sql-db.js';

export function buildSqlDb(): SqlDb {
  const storage = process.env.HH_STORAGE ?? 'sqlite';
  if (storage === 'postgres') {
    return new PostgresSqlDb(process.env.HH_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/healthcare_harness');
  }
  const path = process.env.HH_DB_PATH ?? resolve(process.cwd(), '.harness', 'data', 'harness.db');
  return new SqliteSqlDb(path);
}

/** Open a SqlStore over the configured dialect, migrations applied. */
export async function openSqlStore(): Promise<{ store: SqlStore; db: SqlDb }> {
  const db = buildSqlDb();
  const store = new SqlStore(db);
  await store.applyMigrations();
  return { store, db };
}

// Lazily-opened process-wide singleton. Tests (NODE_ENV=test) get an in-memory SQLite;
// everything else uses HH_STORAGE / HH_DB_PATH. Routes share one store so nudges/counterfactuals
// written through one route are visible to the others.
let cached: { store: SqlStore; db: SqlDb } | undefined;

export async function getSqlStore(): Promise<SqlStore> {
  if (!cached) {
    const db = process.env.NODE_ENV === 'test' ? new SqliteSqlDb(':memory:') : buildSqlDb();
    const store = new SqlStore(db);
    await store.applyMigrations();
    cached = { store, db };
  }
  return cached.store;
}
