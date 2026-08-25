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

// SQL adapter (driver-injectable). Declares source table → canonical event mapping.

import type { CanonicalEvent, CanonicalEventType, EventPayload } from '../healthcare-core/events.js';

export type SQLRow = Readonly<Record<string, unknown>>;

export interface SQLQueryExecutor {
  (query: string, params?: readonly unknown[]): Promise<readonly SQLRow[]>;
}

export interface SQLMapping {
  readonly source: string;
  readonly table: string;
  readonly primaryKey: string;
  readonly timestampColumn: string;
  readonly subjectColumn: string;
  readonly eventType: CanonicalEventType;
  readonly payloadColumns: readonly string[];
  readonly since?: string;
}

export interface SQLMappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
  classification?: 'internal' | 'confidential' | 'phi';
}

export async function pullSQL(
  executor: SQLQueryExecutor,
  mapping: SQLMapping,
  opts: SQLMappingOptions,
): Promise<CanonicalEvent[]> {
  const sinceClause = mapping.since ? ` WHERE ${mapping.timestampColumn} > $1` : '';
  const rows = await executor(
    `SELECT * FROM ${mapping.table}${sinceClause}`,
    mapping.since ? [mapping.since] : [],
  );
  return rows.map<CanonicalEvent>((row) => {
    const pk = row[mapping.primaryKey];
    const ts = row[mapping.timestampColumn];
    const subj = row[mapping.subjectColumn];
    const payload: EventPayload = {};
    for (const col of mapping.payloadColumns) payload[col] = row[col];
    return {
      id: `event:sql:${mapping.source}:${mapping.table}:${String(pk)}`,
      type: mapping.eventType,
      occurredAt: typeof ts === 'string' ? ts : opts.ingestedAt,
      scopeId: opts.scopeId,
      subjectId: String(subj),
      facilityId: opts.facilityId,
      payload,
      provenance: { sourceId: opts.sourceId, observedAt: typeof ts === 'string' ? ts : opts.ingestedAt, ingestedAt: opts.ingestedAt },
      classification: opts.classification ?? 'phi',
    };
  });
}
