// Canonical event vocabulary. Adapters (FHIR, HL7 v2, CSV, SQL, event streams)
// map their native payloads into this shape so the harness only speaks one
// language. Every event carries provenance and a source classification.

import type { Provenance } from '../kernel/hypergraph.js';

export type CanonicalEventType =
  | 'patient.registered'
  | 'treatment.scheduled'
  | 'treatment.completed'
  | 'treatment.missed'
  | 'treatment.shortened'
  | 'treatment.cancelled'
  | 'schedule.changed'
  | 'hospitalization.admitted'
  | 'hospitalization.discharged'
  | 'lab.result-arrived'
  | 'contact.attempted'
  | 'contact.failed'
  | 'transport.issue'
  | 'facility.staffing-change';

export interface CanonicalEvent {
  id: string;
  type: CanonicalEventType;
  occurredAt: string;
  scopeId: string;
  subjectId: string;
  facilityId: string;
  payload: Readonly<Record<string, unknown>>;
  provenance: Provenance;
  classification: 'internal' | 'confidential' | 'phi';
}

export interface EventBatch {
  id: string;
  events: readonly CanonicalEvent[];
  window: { from: string; to: string };
}

/** Sort events into a strict time order — required for deterministic replay. */
export function orderEvents(events: readonly CanonicalEvent[]): CanonicalEvent[] {
  return [...events].sort((a, b) => (a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt.localeCompare(b.occurredAt)));
}
