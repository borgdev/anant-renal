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

// Canonical event vocabulary. Adapters (FHIR, HL7 v2, CSV, X12, CDA, HIE,
// SQL, event streams, SFTP, claims file) map their native payloads into this
// shape so the harness only speaks one language. Every event carries
// provenance and a source classification.

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
  | 'hospitalization.transfer'
  | 'lab.result-arrived'
  | 'lab.result-available'
  | 'contact.attempted'
  | 'contact.failed'
  | 'transport.issue'
  | 'facility.staffing-change'
  // interoperability additions:
  | 'coverage.inquiry'
  | 'coverage.active'
  | 'coverage.inactive'
  | 'prior-auth.submitted'
  | 'prior-auth.approved'
  | 'prior-auth.denied'
  | 'prior-auth.appealed'
  | 'claim.submitted'
  | 'claim.denied'
  | 'claim.remittance'
  | 'condition.recorded'
  | 'immunization.recorded'
  | 'infection.screened'
  | 'medication.ordered'
  | 'medication.updated'
  | 'procedure.performed'
  | 'vital.observed'
  | 'encounter.summary'
  | 'device.observation'
  | 'nutrition.assessment'
  | 'dry-weight.recorded'
  | 'protocol.deviation'
  // FHIR hydration (Phase 2) — generic carrier for structural resources (Patient,
  // Organization, Location, Practitioner, Device, Coverage, …). Effect-able
  // resources use the domain types above (hospitalization.*, lab.result-arrived, …).
  | 'fhir.resource-ingested';

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

export type EventPayload = Record<string, unknown>;

export interface EventBatch {
  id: string;
  events: readonly CanonicalEvent[];
  window: { from: string; to: string };
}

/** Sort events into a strict time order — required for deterministic replay. */
export function orderEvents(events: readonly CanonicalEvent[]): CanonicalEvent[] {
  return [...events].sort((a, b) => (a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt.localeCompare(b.occurredAt)));
}
