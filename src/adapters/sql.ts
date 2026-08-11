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
