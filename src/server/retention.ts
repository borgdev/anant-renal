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

// Retention policies + purge (Phase 4 compliance). Each policy targets an
// entity (event_outbox, audit_events, webhook_deliveries, fhir_resources,
// billing_usage, alert_events) with a max age; the purge job deletes older rows.
// Runs on any SqlDb via the portable SqlStore.

import type { RetentionPolicyRow, SqlStore } from './sql/sql-store.js';

/** Default age-based retention policies — upserted only when no policy exists for an
 *  entity, so the high-volume delivered-event backlog stays bounded out of the box
 *  (admin-created policies always win). */
export const DEFAULT_RETENTION_POLICIES: ReadonlyArray<{ entity: string; maxAgeMs: number }> = [
  { entity: 'event_outbox', maxAgeMs: 7 * 24 * 3600 * 1000 },
  { entity: 'webhook_deliveries', maxAgeMs: 7 * 24 * 3600 * 1000 },
  { entity: 'alert_events', maxAgeMs: 30 * 24 * 3600 * 1000 },
  { entity: 'audit_events', maxAgeMs: 365 * 24 * 3600 * 1000 },
  { entity: 'billing_usage', maxAgeMs: 365 * 24 * 3600 * 1000 },
  { entity: 'fhir_resources', maxAgeMs: 365 * 24 * 3600 * 1000 },
];

export interface RetentionPolicyInput {
  id?: string;
  entity: string;
  scopeId?: string;
  maxAgeMs: number;
  enabled?: boolean;
}

export class RetentionService {
  constructor(private readonly store: SqlStore) {}

  async upsert(input: RetentionPolicyInput): Promise<void> {
    await this.store.saveRetentionPolicy({
      id: input.id ?? `ret-${input.entity.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      entity: input.entity,
      scopeId: input.scopeId ?? null,
      maxAgeMs: input.maxAgeMs,
      enabled: input.enabled === false ? 0 : 1,
    });
  }

  async policies(): Promise<RetentionPolicyRow[]> { return this.store.listRetentionPolicies(); }
  async remove(id: string): Promise<boolean> { return this.store.deleteRetentionPolicy(id); }

  /** Seed built-in defaults for entities with no policy yet (admin overrides win). */
  async seedDefaults(): Promise<void> {
    const existing = await this.store.listRetentionPolicies();
    for (const d of DEFAULT_RETENTION_POLICIES) {
      if (!existing.some((p) => p.entity === d.entity)) {
        await this.upsert({ entity: d.entity, maxAgeMs: d.maxAgeMs });
      }
    }
  }

  /** Apply every enabled policy; returns deleted counts per entity. */
  async purge(now = new Date()): Promise<Record<string, number>> {
    const policies = await this.store.listRetentionPolicies();
    const deleted: Record<string, number> = {};
    for (const p of policies) {
      if (p.enabled !== 1) continue;
      const before = new Date(now.getTime() - p.maxAgeMs).toISOString();
      deleted[p.entity] = (deleted[p.entity] ?? 0) + await this.store.purgeBefore(p.entity, before);
    }
    return deleted;
  }
}
