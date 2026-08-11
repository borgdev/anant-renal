// HIE feed adapter: ADT-style event notifications.

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export interface HIENotification {
  readonly notificationId: string;
  readonly notificationType: 'admit' | 'discharge' | 'transfer' | 'result-available' | 'medication-updated';
  readonly patientRef: string;
  readonly facility: string;
  readonly occurredAt: string;
  readonly documentPointer?: {
    readonly url: string;
    readonly contentType: 'application/hl7-cda+xml' | 'application/fhir+json' | 'application/pdf';
  };
  readonly payload?: Record<string, unknown>;
}

export interface HIEMappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

const notificationTypeMap: Record<HIENotification['notificationType'], CanonicalEventType> = {
  admit: 'hospitalization.admitted',
  discharge: 'hospitalization.discharged',
  transfer: 'hospitalization.transfer',
  'result-available': 'lab.result-available',
  'medication-updated': 'medication.updated',
};

export function hieNotificationToEvent(n: HIENotification, opts: HIEMappingOptions): CanonicalEvent {
  return {
    id: `event:hie:${n.notificationId}`,
    type: notificationTypeMap[n.notificationType],
    occurredAt: n.occurredAt,
    scopeId: opts.scopeId,
    subjectId: n.patientRef,
    facilityId: opts.facilityId,
    payload: { hie: { facility: n.facility, ...(n.documentPointer ? { documentPointer: n.documentPointer } : {}), ...(n.payload ?? {}) } },
    provenance: { sourceId: opts.sourceId, observedAt: n.occurredAt, ingestedAt: opts.ingestedAt },
    classification: 'phi',
  };
}
