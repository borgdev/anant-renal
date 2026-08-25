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

// Audit & compliance (Phase 4). Projects session/ledger events to portable
// audit rows AND FHIR R4 AuditEvent resources; exposes the compliance surface
// (audit read, ePHI DSAR, anonymized export). The audit chain integrity
// (hash-linked) remains in the Postgres store; this portable mirror feeds the
// admin + API + retention.

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';
import type { AuditEventRow } from './sql/sql-store.js';
import { code, type AuditEvent, type FhirResource } from '../fhir/types.js';

const AUDIT_ACTIVITY: Record<string, string> = {
  'patient.registered': '110100', // Patient Record
  'hospitalization.admitted': '110100',
  'hospitalization.discharged': '110100',
  'lab.result-arrived': '110100',
  'treatment.scheduled': '110100',
  'medication.ordered': '110100',
  'vital.observed': '110100',
  'fhir.resource-ingested': '110100',
  // M24 clinical-record family — all "Patient Record" activity (110100).
  'condition.recorded': '110100',
  'procedure.performed': '110100',
  'medication.updated': '110100',
  'encounter.summary': '110100',
  'device.observation': '110100',
  'nutrition.assessment': '110100',
  'dry-weight.recorded': '110100',
  'protocol.deviation': '110100',
  // Financial (110200).
  'claim.submitted': '110200',
  'claim.denied': '110200',
  'claim.remittance': '110200',
  'prior-auth.submitted': '110200',
  'prior-auth.approved': '110200',
  'prior-auth.denied': '110200',
  'prior-auth.appealed': '110200',
  'coverage.inquiry': '110200',
  'coverage.active': '110200',
  'coverage.inactive': '110200',
};

export function canonicalAction(type: CanonicalEventType): 'C' | 'R' | 'U' | 'D' | 'E' {
  switch (type) {
    case 'hospitalization.discharged': case 'treatment.cancelled': case 'claim.denied': return 'D';
    case 'fhir.resource-ingested': return 'C';
    default: return 'C';
  }
}

/** Map a canonical event → portable audit row. */
export function canonicalToAuditRow(evt: CanonicalEvent, actorRef: string): AuditEventRow {
  return {
    id: `audit:${evt.id}`,
    scopeId: evt.scopeId,
    actorRef,
    action: canonicalAction(evt.type),
    resourceType: 'CanonicalEvent',
    resourceId: evt.id,
    classification: evt.classification,
    occurredAt: evt.occurredAt,
    payloadJson: JSON.stringify({ type: evt.type, subjectId: evt.subjectId, facilityId: evt.facilityId, provenance: evt.provenance }),
  };
}

/** Project a canonical event → FHIR R4 AuditEvent resource. */
export function canonicalToFhirAudit(evt: CanonicalEvent, actorRef: string): AuditEvent {
  return {
    resourceType: 'AuditEvent',
    id: `audit-${evt.id}`,
    type: code('http://terminology.hl7.org/CodeSystem/audit-event-type', AUDIT_ACTIVITY[evt.type] ?? '110100', evt.type),
    action: canonicalAction(evt.type),
    recorded: evt.occurredAt,
    agent: [{ who: { reference: `Practitioner/${actorRef}` }, requestor: true }],
    source: { observer: { reference: 'Device/anant-harness' } },
    entity: [{ what: { reference: `CanonicalEvent/${evt.id}` }, type: code('http://terminology.hl7.org/CodeSystem/audit-entity-type', evt.type) }],
  };
}

/** Render audit rows as FHIR AuditEvent resources (for the compliance export). */
export function auditRowsToFhir(rows: readonly AuditEventRow[]): FhirResource[] {
  return rows.map((r) => {
    const payload = r.payloadJson ? (JSON.parse(r.payloadJson) as Record<string, unknown>) : {};
    return {
      resourceType: 'AuditEvent',
      id: `audit-${r.id}`,
      type: code('http://terminology.hl7.org/CodeSystem/audit-event-type', '110100', r.action),
      action: r.action as AuditEvent['action'],
      recorded: r.occurredAt,
      agent: [{ who: { reference: `Practitioner/${r.actorRef}` }, requestor: true }],
      source: { observer: { reference: 'Device/anant-harness' } },
      entity: [{ what: { reference: `${r.resourceType}/${r.resourceId ?? ''}` }, type: code('http://terminology.hl7.org/CodeSystem/audit-entity-type', r.resourceType) }],
      ...(Object.keys(payload).length ? { detail: [{ type: code('http://hl7.org/fhir/StructureDefinition/audit-event-detail', 'payload'), valueString: r.payloadJson ?? '' }] } : {}),
    } as AuditEvent;
  });
}
