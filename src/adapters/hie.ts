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
