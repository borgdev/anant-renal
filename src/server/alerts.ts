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

// Alert rules (Phase 4 observability). Evaluates a metric snapshot against
// configured rules (metric, operator, threshold, severity) and records fired
// alert events. The heartbeat job feeds broker/outbox/sync metrics in.

import { randomUUID } from 'node:crypto';
import type { AlertEventRow, SqlStore } from './sql/sql-store.js';

export type AlertOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface MetricSnapshot { readonly [metric: string]: number; }

export interface AlertRuleInput {
  id?: string;
  metric: string;
  op: AlertOp;
  threshold: number;
  severity?: 'info' | 'warning' | 'critical';
  enabled?: boolean;
  label?: string;
}

function compare(value: number, op: AlertOp, threshold: number): boolean {
  switch (op) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
  }
}

export class AlertService {
  constructor(private readonly store: SqlStore) {}

  async upsert(input: AlertRuleInput): Promise<void> {
    await this.store.saveAlertRule({
      id: input.id ?? `rule-${randomUUID()}`,
      metric: input.metric,
      op: input.op,
      threshold: input.threshold,
      severity: input.severity ?? 'warning',
      enabled: input.enabled === false ? 0 : 1,
      label: input.label ?? null,
    });
  }

  async rules(): Promise<import('./sql/sql-store.js').AlertRuleRow[]> { return this.store.listAlertRules(); }
  async remove(id: string): Promise<boolean> { return this.store.deleteAlertRule(id); }

  /** Evaluate a metric snapshot; returns the alert events fired. */
  async evaluate(metrics: MetricSnapshot): Promise<AlertEventRow[]> {
    const rules = await this.store.listAlertRules(true);
    const fired: AlertEventRow[] = [];
    for (const rule of rules) {
      const value = metrics[rule.metric];
      if (value === undefined) continue;
      if (!compare(value, rule.op as AlertOp, rule.threshold)) continue;
      const row: AlertEventRow = {
        id: `alert-${randomUUID()}`,
        ruleId: rule.id,
        metric: rule.metric,
        value,
        severity: rule.severity,
        message: rule.label ?? `${rule.metric} ${rule.op} ${rule.threshold} (now ${value})`,
        status: 'firing',
        firedAt: new Date().toISOString(),
        resolvedAt: null,
      };
      await this.store.saveAlertEvent(row);
      fired.push(row);
    }
    return fired;
  }

  async events(limit = 100): Promise<AlertEventRow[]> { return this.store.listAlertEvents(limit); }
}
