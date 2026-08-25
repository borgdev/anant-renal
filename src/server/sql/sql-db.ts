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

// Dialect-agnostic SQL access — the swap seam the storage design depends on.
//
// A `SqlDb` owns a connection and knows its parameter-binding dialect; the store layer only
// ever writes PORTABLE SQL ('?' placeholders + positional params + TEXT/REAL columns), so
// swapping SQLite for Postgres (or any SQL dialect) means constructing a different `SqlDb` —
// the store code never changes. This is the whole point of the design: SQLite for local/dev/
// tests, Postgres for production, same store, zero re-architecture.
//
// Placeholder convention: `?` → SQLite native; Postgres adapter rewrites `?` → `$1..$n`.

export type SqlDialect = 'sqlite' | 'postgres';

export interface SqlDb {
  readonly dialect: SqlDialect;
  /** Run a write statement; resolves with the number of affected rows. */
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Run a query; resolves with the result rows. */
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run DDL (a single portable statement per call). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Rewrite `?` placeholders to Postgres `$1..$n`. Pure + unit-testable. */
export function rewritePlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// ---- SQLite (node:sqlite, built into Node 22.5+) ----

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
type SqliteDatabase = import('node:sqlite').DatabaseSync;

// Loaded lazily via createRequire so Vite/vitest never tries to resolve `node:sqlite` as a
// package (it predates Vite's builtin list, which would otherwise strip the `node:` prefix).
function sqliteModule(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  return require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
}

export class SqliteSqlDb implements SqlDb {
  readonly dialect = 'sqlite' as const;
  private readonly db: SqliteDatabase;

  constructor(path: string = ':memory:') {
    // `node:sqlite` won't create missing parent directories, so ensure the containing
    // directory exists for file-backed databases (tests use :memory:, which needs nothing).
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new (sqliteModule().DatabaseSync)(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Wait up to 5s for the write lock instead of throwing SQLITE_BUSY instantly.
    // Without this, concurrent writers (outbox flusher + realm snapshots + a
    // reloaded process) race and crash with "database is locked".
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const res = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(res.changes ?? 0) };
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as unknown as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---- Postgres (pg) — same store, different SqlDb ----

import { Pool } from 'pg';

export class PostgresSqlDb implements SqlDb {
  readonly dialect = 'postgres' as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  private rewrite(sql: string): string {
    return rewritePlaceholders(sql);
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const r = await this.pool.query(this.rewrite(sql), params as unknown[]);
    return { changes: r.rowCount ?? 0 };
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(this.rewrite(sql), params as unknown[]);
    return r.rows as unknown as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
