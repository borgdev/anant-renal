// CSV adapter — the last-resort ingestion path for facilities without FHIR or
// HL7. Callers describe the column mapping and the adapter turns rows into
// canonical events.

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export interface CsvRow {
  [column: string]: string;
}

export interface CsvMapping {
  eventType: CanonicalEventType;
  subjectIdColumn: string;
  occurredAtColumn: string;
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
  payloadColumns: readonly string[];
  classification: 'internal' | 'confidential' | 'phi';
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]!);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    const row: CsvRow = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

export function mapCsvRow(row: CsvRow, mapping: CsvMapping, index: number): CanonicalEvent | null {
  const subjectId = row[mapping.subjectIdColumn];
  const occurredAt = row[mapping.occurredAtColumn];
  if (!subjectId || !occurredAt) return null;
  const payload: Record<string, unknown> = {};
  for (const col of mapping.payloadColumns) payload[col] = row[col] ?? '';
  return {
    id: `event:csv:${mapping.sourceId}:${index}`,
    type: mapping.eventType,
    occurredAt,
    scopeId: mapping.scopeId,
    subjectId,
    facilityId: mapping.facilityId,
    payload,
    provenance: { sourceId: mapping.sourceId, observedAt: occurredAt, ingestedAt: mapping.ingestedAt, lineage: ['csv', mapping.sourceId] },
    classification: mapping.classification,
  };
}
