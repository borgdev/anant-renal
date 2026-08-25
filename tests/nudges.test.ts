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

// M25 — Nudge Ledger + channel adapters.
//
// A rehearsed nudge is delivered through a channel adapter, recorded in the ledger (with
// rehearsal/variant provenance + expected effect), and the loop closes when the twin observes
// a response — persisted via the swappable SqlStore.

import { describe, expect, it } from 'vitest';
import { Realm, populateFacility } from '../src/realm/index.js';
import { InAppNudgeChannel, NudgeLedger, StubNudgeChannel, sqliteNudgePersistence } from '../src/realm/nudges.js';
import { SqliteSqlDb, SqlStore } from '../src/server/sql/index.js';

describe('Nudge Ledger (M25)', () => {
  it('delivers + observes a nudge and persists the lifecycle', async () => {
    const db = new SqliteSqlDb(':memory:');
    const store = new SqlStore(db);
    await store.applyMigrations();
    const ledger = new NudgeLedger(sqliteNudgePersistence(store));

    const rec = await ledger.deliver(
      {
        realmId: 'realm:a', patientId: 'p1', channel: 'sms', nudgeKind: 'phosphate-reminder',
        expectedEffect: { diet_phosphate_violation: -0.4 }, rehearsalId: 'cf-1', variantId: 'insistent', expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      new StubNudgeChannel('sms'),
    );
    expect(rec.status).toBe('delivered');
    expect(rec.channelReceipt).toMatch(/^sms-stub-/);
    expect((await store.listNudges('realm:a')).length).toBe(1);
    const persisted = await store.getNudge(rec.id);
    expect(persisted?.rehearsalId).toBe('cf-1');
    expect(persisted?.variantId).toBe('insistent');

    await ledger.observe(rec.id, { phosphate: 0.4, messageRead: true });
    const row = await store.getNudge(rec.id);
    expect(row?.status).toBe('observed');
    expect(JSON.parse(row!.observedOutcomeJson!).phosphate).toBe(0.4);
    await db.close();
  });

  it('in-app channel delivers a perceivable nudge into a realm', async () => {
    const realm = new Realm({ id: 'realm:nudge', mode: 'sim' });
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'N', units: ['A'], patientCount: 1 });
    const pid = realm.graph.listKind('patient')[0]!.id;

    const ledger = new NudgeLedger();
    const rec = await ledger.deliver(
      { realmId: 'realm:nudge', patientId: pid, channel: 'in-app', nudgeKind: 'dietitian-nudge', expectedEffect: { diet_phosphate_violation: -0.2 } },
      new InAppNudgeChannel(realm),
    );
    expect(rec.status).toBe('delivered');

    const artifacts = realm.graph.listKind('work-artifact');
    expect(artifacts.length).toBe(1);
    expect((artifacts[0]!.state as { nudgeKind: string }).nudgeKind).toBe('dietitian-nudge');
    // With no agent presences subscribed, perception delivery is a no-op (artifact is the
    // observable in-process effect); a realm with presences would perceive nudge.delivered.
    realm.stop();
  });
});
