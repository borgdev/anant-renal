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

// M14.B — Counterfactual studio backing store
//
// A small in-memory registry of past counterfactual runs so the UI can list
// prior projections, view a specific one, and let an operator "apply with
// evidence" — the resulting directive carries the evidenceId that points back
// into this store.

import { randomUUID } from 'node:crypto';
import type { CounterfactualInput, CounterfactualReport, Intervention } from './counterfactual.js';

export interface CounterfactualRecord {
  id: string;
  createdAt: string;
  label: string;
  realmId?: string; // realm the studio was launched from (for provenance)
  input: {
    interventions: Intervention[];
    timelineLength: number;
    advanceTicks?: number;
  };
  report: CounterfactualReport;
}

class CounterfactualStoreImpl {
  private records = new Map<string, CounterfactualRecord>();
  private readonly maxRecords = 200;

  save(input: CounterfactualInput, report: CounterfactualReport, label: string, realmId?: string): CounterfactualRecord {
    const id = `cf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const rec: CounterfactualRecord = {
      id,
      createdAt: new Date().toISOString(),
      label,
      ...(realmId !== undefined ? { realmId } : {}),
      input: {
        interventions: input.interventions,
        timelineLength: input.timeline.length,
        ...(input.advanceTicks !== undefined ? { advanceTicks: input.advanceTicks } : {}),
      },
      report,
    };
    this.records.set(id, rec);
    // Bound the store — drop oldest.
    if (this.records.size > this.maxRecords) {
      const oldest = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) this.records.delete(oldest.id);
    }
    return rec;
  }

  get(id: string): CounterfactualRecord | undefined { return this.records.get(id); }
  list(): CounterfactualRecord[] { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  remove(id: string): boolean { return this.records.delete(id); }
  clear(): void { this.records.clear(); }
}

export const CounterfactualStore = new CounterfactualStoreImpl();
