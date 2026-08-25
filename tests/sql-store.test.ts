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

// Storage abstraction — SqlDb dialect seam + SqlStore durability.
//
// The whole point: the store writes portable SQL; swapping SQLite for Postgres is just a
// different SqlDb. These tests prove (a) placeholder rewrite (the Postgres dialect difference),
// (b) a full save/load round-trip on SQLite, (c) durability across store instances (file DB).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteSqlDb, SqlStore, rewritePlaceholders } from '../src/server/sql/index.js';

describe('dialect seam', () => {
  it('rewrites ? placeholders to Postgres $n', () => {
    expect(rewritePlaceholders('WHERE realm_id = ? AND kind = ?')).toBe('WHERE realm_id = $1 AND kind = $2');
    expect(rewritePlaceholders('no placeholders')).toBe('no placeholders');
  });
});

describe('SqlStore (sqlite)', () => {
  it('round-trips realm snapshots, billing, nudges, and counterfactual runs', async () => {
    const db = new SqliteSqlDb(':memory:');
    const store = new SqlStore(db);
    await store.applyMigrations();

    await store.saveRealmSnapshot({ realmId: 'realm:a', mode: 'sim', createdAt: new Date().toISOString(), snapshotJson: JSON.stringify({ seq: 7, patients: 3 }) });
    await store.saveRealmSnapshot({ realmId: 'realm:a', mode: 'sim', createdAt: new Date().toISOString(), snapshotJson: JSON.stringify({ seq: 9, patients: 3 }) });

    const realms = await store.listRealmSnapshots();
    expect(realms).toHaveLength(1);
    expect(realms[0]!.realmId).toBe('realm:a');
    expect(JSON.parse(realms[0]!.snapshotJson).seq).toBe(9);

    await store.saveBilling({ id: 'b1', realmId: 'realm:a', period: '2026-08', plan: 'default', reportJson: JSON.stringify({ dollars: 42 }) });
    expect((await store.listBilling('realm:a')).length).toBe(1);

    await store.saveNudge({
      id: 'n1', realmId: 'realm:a', patientId: 'p1', channel: 'in-app', nudgeKind: 'phosphate-reminder',
      expectedEffectJson: JSON.stringify({ diet_phosphate_violation: -0.4 }), status: 'delivered', sentAt: new Date().toISOString(),
    });
    await store.updateNudgeObserved('n1', new Date().toISOString(), JSON.stringify({ phosphate: 0.4 }));
    const nudge = await store.getNudge('n1');
    expect(nudge?.status).toBe('observed');

    await store.saveCounterfactual({ id: 'cf1', label: 'gentle', inputJson: '{}', reportJson: '{}', createdAt: new Date().toISOString() });
    expect((await store.listCounterfactuals()).length).toBe(1);
    await store.removeCounterfactual('cf1');
    expect((await store.listCounterfactuals()).length).toBe(0);

    await db.close();
  });

  it('persists across store instances (durability on a file DB)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-sql-'));
    const path = join(dir, 'harness.db');
    try {
      const db1 = new SqliteSqlDb(path);
      const s1 = new SqlStore(db1);
      await s1.applyMigrations();
      await s1.saveRealmSnapshot({ realmId: 'realm:durable', mode: 'twin', createdAt: new Date().toISOString(), snapshotJson: JSON.stringify({ seq: 1 }) });
      await db1.close();

      const db2 = new SqliteSqlDb(path);
      const s2 = new SqlStore(db2);
      await s2.applyMigrations();
      const realms = await s2.listRealmSnapshots();
      expect(realms).toHaveLength(1);
      expect(realms[0]!.realmId).toBe('realm:durable');
      await db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
