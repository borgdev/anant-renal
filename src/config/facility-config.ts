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

// Facility-scoped configuration store with org→region→facility inheritance.
//
// Resolution: lookup at facility level; if absent, walk up to region, then org,
// then built-in default. Every write appends a new row (valid_from...valid_to);
// history is queryable via `history(category, key, scopeId)`. Every mutation is
// audit-chained through PostgresEventStore.appendAudit.

import { randomUUID, createHash } from 'node:crypto';
import type { PostgresEventStore } from '../server/postgres-event-store.js';

export type ScopeLevel = 'org' | 'region' | 'facility';
export interface ConfigWrite {
  readonly scopeLevel: ScopeLevel;
  readonly scopeId: string;
  readonly category: string;
  readonly key: string;
  readonly value: unknown;
  readonly actorRef: string;
  readonly validFrom?: string; // defaults to now
}
export interface ConfigLookup {
  readonly category: string;
  readonly key: string;
  readonly facilityId: string;
  readonly regionId?: string;
  readonly orgId?: string;
  readonly at?: string; // ISO timestamp, defaults to now
}
export interface ConfigValue {
  readonly value: unknown;
  readonly scopeLevel: ScopeLevel;
  readonly scopeId: string;
  readonly source: 'facility' | 'region' | 'org' | 'default' | 'not-found';
}

export class FacilityConfigStore {
  constructor(private readonly store: PostgresEventStore) {}

  async write(w: ConfigWrite): Promise<void> {
    const validFrom = w.validFrom ?? new Date().toISOString();
    // Close current row (if any) at this scope+key by setting valid_to.
    await this.store.execRaw(
      `UPDATE __schema__.facility_config
          SET valid_to = $5
        WHERE scope_level = $1 AND scope_id = $2 AND category = $3 AND key = $4 AND valid_to IS NULL`,
      [w.scopeLevel, w.scopeId, w.category, w.key, validFrom],
    );
    const configId = randomUUID();
    await this.store.execRaw(
      `INSERT INTO __schema__.facility_config (config_id, scope_level, scope_id, category, key, value, valid_from, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [configId, w.scopeLevel, w.scopeId, w.category, w.key, JSON.stringify(w.value), validFrom, w.actorRef],
    );
    const seq = Date.now();
    const payload = { category: w.category, key: w.key, value: w.value, scopeLevel: w.scopeLevel, scopeId: w.scopeId };
    const hash = createHash('sha256').update(JSON.stringify({ seq, payload })).digest('hex');
    await this.store.appendAudit({
      sequence: seq, hash, previousHash: '', scopeId: w.scopeId, actorRef: w.actorRef,
      action: `config.write:${w.category}.${w.key}`, traceId: configId, occurredAt: validFrom, payload,
    });
  }

  async lookup(q: ConfigLookup, defaultValue?: unknown): Promise<ConfigValue> {
    const at = q.at ?? new Date().toISOString();
    const tryLevel = async (level: ScopeLevel, id: string | undefined): Promise<ConfigValue | null> => {
      if (!id) return null;
      const rows = await this.store.queryRaw<{ value: unknown }>(
        `SELECT value FROM __schema__.facility_config
          WHERE scope_level = $1 AND scope_id = $2 AND category = $3 AND key = $4
            AND valid_from <= $5 AND (valid_to IS NULL OR valid_to > $5)
          ORDER BY valid_from DESC LIMIT 1`,
        [level, id, q.category, q.key, at],
      );
      const first = rows[0];
      if (!first) return null;
      return { value: first.value, scopeLevel: level, scopeId: id, source: level as ConfigValue['source'] };
    };
    const facility = await tryLevel('facility', q.facilityId);
    if (facility) return facility;
    const region = await tryLevel('region', q.regionId);
    if (region) return region;
    const org = await tryLevel('org', q.orgId);
    if (org) return org;
    if (defaultValue !== undefined) return { value: defaultValue, scopeLevel: 'facility', scopeId: q.facilityId, source: 'default' };
    return { value: undefined, scopeLevel: 'facility', scopeId: q.facilityId, source: 'not-found' };
  }

  async history(category: string, key: string, scopeLevel: ScopeLevel, scopeId: string): Promise<readonly { value: unknown; validFrom: string; validTo: string | null; updatedBy: string }[]> {
    const rows = await this.store.queryRaw<{ value: unknown; valid_from: string; valid_to: string | null; updated_by: string }>(
      `SELECT value, valid_from, valid_to, updated_by FROM __schema__.facility_config
        WHERE scope_level = $1 AND scope_id = $2 AND category = $3 AND key = $4
        ORDER BY valid_from DESC`,
      [scopeLevel, scopeId, category, key],
    );
    return rows.map((r) => ({ value: r.value, validFrom: r.valid_from, validTo: r.valid_to, updatedBy: r.updated_by }));
  }
}
