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

// Realm restore-on-boot (B3 hardening).
//
// The RealmRegistry is process-global and in-memory, so every dev restart
// wipes realms (the classic `tsx watch` foot-gun). Realm creation specs are
// persisted to the SqlStore (`realm_specs`); this helper rebuilds each realm
// from its spec on boot — same mode/trajectory engine and the same seeded
// facility/units/patients — so the console comes back with its worlds intact.

import type { SqlStore } from './sql/sql-store.js';
import type { RealmMode } from '../realm/types.js';
import { RealmRegistry, populateFacility, restoreSnapshot, type RealmSnapshotV1 } from '../realm/index.js';
import { buildHealthcareHypergraphSchema } from '../../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../realm/hypergraph-bridge.js';

export interface RealmCreationSpec {
  seed?: Parameters<typeof populateFacility>[1];
  trajectoryEngine?: 'legacy' | 'liquid';
}

/** Rebuild every persisted realm that isn't already live. Returns the restored ids. */
export async function restoreRealmsFromSpecs(store: Pick<SqlStore, 'listRealmSpecs' | 'getRealmSnapshot'>): Promise<string[]> {
  const restored: string[] = [];
  try {
    const specs = await store.listRealmSpecs();
    for (const row of specs) {
      if (RealmRegistry.get(row.realmId)) continue;
      const engine = (row.trajectoryEngine ?? '') as 'liquid' | 'legacy' | '';
      const build = () => RealmRegistry.create({
        id: row.realmId,
        mode: (row.mode ?? 'sim') as RealmMode,
        ...(engine ? { trajectoryEngine: engine } : {}),
        hypergraph: new RealmHypergraph(buildHealthcareHypergraphSchema(), row.realmId),
      });

      // Prefer a full portable snapshot (entities + presences + ledger + HITL) when one exists.
      let snapshot: RealmSnapshotV1 | null = null;
      try {
        const snapRow = await store.getRealmSnapshot(row.realmId);
        if (snapRow) snapshot = JSON.parse(snapRow.snapshotJson) as RealmSnapshotV1;
      } catch { snapshot = null; }
      if (snapshot?.version === 'hh-realm-snapshot@1') {
        try {
          const realm = restoreSnapshot(snapshot, build);
          realm.start();
          restored.push(row.realmId);
          continue;
        } catch { /* fall through to spec rebuild */ }
      }

      // Fallback: rebuild from the creation spec (structure only).
      let parsed: RealmCreationSpec = {};
      try { parsed = JSON.parse(row.specJson) as RealmCreationSpec; } catch { parsed = {}; }
      const realm = build();
      if (parsed.seed) populateFacility(realm, parsed.seed);
      realm.start();
      restored.push(row.realmId);
    }
  } catch {
    /* storage is best-effort — the console still boots without persisted realms */
  }
  return restored;
}
