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

// Billing rollup + invoice generator + budget cap enforcer.
//
// Metering rows are written per skill invocation by the Runtime. This module
// aggregates them per (scope_id, facility_id, billing_period), emits invoices,
// and answers budget-cap questions used by the runtime to auto-pause agents.

import { randomUUID } from 'node:crypto';
import type { PostgresEventStore } from '../server/postgres-event-store.js';

export interface LineItem {
  readonly agentId: string;
  readonly unit: string;
  readonly quantity: number;
  readonly totalUsd: number;
}

export interface Invoice {
  readonly invoiceId: string;
  readonly scopeId: string;
  readonly facilityId: string | null;
  readonly billingPeriod: string;
  readonly totalUsd: number;
  readonly lineItems: readonly LineItem[];
  readonly issuedAt: string;
}

export interface BudgetStatus {
  readonly currentSpendUsd: number;
  readonly capUsd: number | null;
  readonly overCap: boolean;
  readonly remainingUsd: number | null;
}

export class BillingEngine {
  constructor(private readonly store: PostgresEventStore) {}

  async aggregate(scopeId: string, facilityId: string | null, billingPeriod: string): Promise<readonly LineItem[]> {
    const rows = await this.store.queryRaw<{ agent_id: string; unit: string; quantity: string; total_usd: string }>(
      `SELECT agent_id, unit,
              SUM(quantity)::TEXT AS quantity,
              SUM(total_usd)::TEXT AS total_usd
         FROM __schema__.metering_events
        WHERE scope_id = $1 AND billing_period = $2 AND ($3::text IS NULL OR facility_id = $3)
        GROUP BY agent_id, unit
        ORDER BY agent_id, unit`,
      [scopeId, billingPeriod, facilityId],
    );
    return rows.map((r) => ({ agentId: r.agent_id, unit: r.unit, quantity: Number(r.quantity), totalUsd: Number(r.total_usd) }));
  }

  async issueInvoice(scopeId: string, facilityId: string | null, billingPeriod: string): Promise<Invoice> {
    const lineItems = await this.aggregate(scopeId, facilityId, billingPeriod);
    const totalUsd = lineItems.reduce((s, li) => s + li.totalUsd, 0);
    const invoiceId = randomUUID();
    const issuedAt = new Date().toISOString();
    await this.store.execRaw(
      `INSERT INTO __schema__.invoices (invoice_id, scope_id, facility_id, billing_period, total_usd, line_items, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [invoiceId, scopeId, facilityId, billingPeriod, totalUsd, JSON.stringify(lineItems), issuedAt],
    );
    await this.store.execRaw(
      `UPDATE __schema__.metering_events SET invoiced = TRUE
        WHERE scope_id = $1 AND billing_period = $2 AND ($3::text IS NULL OR facility_id = $3) AND invoiced = FALSE`,
      [scopeId, billingPeriod, facilityId],
    );
    return { invoiceId, scopeId, facilityId, billingPeriod, totalUsd, lineItems, issuedAt };
  }

  async budgetStatus(scopeId: string, facilityId: string | null, capUsd: number | null): Promise<BudgetStatus> {
    const period = currentBillingPeriod();
    const rows = await this.store.queryRaw<{ total: string | null }>(
      `SELECT SUM(total_usd)::TEXT AS total FROM __schema__.metering_events
        WHERE scope_id = $1 AND billing_period = $2 AND ($3::text IS NULL OR facility_id = $3)`,
      [scopeId, period, facilityId],
    );
    const currentSpendUsd = Number(rows[0]?.total ?? 0);
    const overCap = capUsd !== null && currentSpendUsd > capUsd;
    const remainingUsd = capUsd !== null ? Math.max(0, capUsd - currentSpendUsd) : null;
    return { currentSpendUsd, capUsd, overCap, remainingUsd };
  }
}

export function currentBillingPeriod(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
