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

// HL7 v2 lite adapter — supports ADT^A01 (admit) and ADT^A03 (discharge) plus
// SIU^S12 (schedule) at the field level the harness needs. Feeds map into the
// canonical event vocabulary.

import type { CanonicalEvent } from '../healthcare-core/events.js';

export interface Hl7MappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

/** Very small HL7 v2 pipe parser. Returns segments as arrays of fields. */
export function parseHl7v2(message: string): string[][] {
  return message.split(/\r?\n/).filter((s) => s.trim().length > 0).map((line) => line.split('|'));
}

function segment(segments: string[][], name: string): string[] | undefined {
  return segments.find((s) => s[0] === name);
}

function fieldOrEmpty(seg: string[] | undefined, idx: number): string {
  return seg && seg[idx] !== undefined ? seg[idx]! : '';
}

export function mapHl7v2Message(message: string, opts: Hl7MappingOptions): CanonicalEvent | null {
  const segments = parseHl7v2(message);
  const msh = segment(segments, 'MSH');
  if (!msh) return null;
  const msgType = fieldOrEmpty(msh, 8);
  const pid = segment(segments, 'PID');
  const patientId = fieldOrEmpty(pid, 3) || 'unknown';
  const eventTime = fieldOrEmpty(msh, 6) || opts.ingestedAt;
  const iso = normalizeHl7Timestamp(eventTime) ?? opts.ingestedAt;
  const provenance = { sourceId: opts.sourceId, observedAt: iso, ingestedAt: opts.ingestedAt };

  if (msgType.startsWith('ADT^A01')) {
    return {
      id: `event:hl7:${msg(msh)}`,
      type: 'hospitalization.admitted',
      occurredAt: iso,
      scopeId: opts.scopeId,
      subjectId: patientId,
      facilityId: opts.facilityId,
      payload: { raw: message },
      provenance,
      classification: 'phi',
    };
  }
  if (msgType.startsWith('ADT^A03')) {
    return {
      id: `event:hl7:${msg(msh)}`,
      type: 'hospitalization.discharged',
      occurredAt: iso,
      scopeId: opts.scopeId,
      subjectId: patientId,
      facilityId: opts.facilityId,
      payload: { raw: message },
      provenance,
      classification: 'phi',
    };
  }
  if (msgType.startsWith('SIU^S12')) {
    return {
      id: `event:hl7:${msg(msh)}`,
      type: 'treatment.scheduled',
      occurredAt: iso,
      scopeId: opts.scopeId,
      subjectId: patientId,
      facilityId: opts.facilityId,
      payload: { raw: message },
      provenance,
      classification: 'phi',
    };
  }
  return null;
}

function msg(msh: string[]): string {
  return fieldOrEmpty(msh, 10) || `${Date.now()}`;
}

function normalizeHl7Timestamp(ts: string): string | null {
  if (ts.length < 8) return null;
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.length >= 10 ? ts.slice(8, 10) : '00';
  const mi = ts.length >= 12 ? ts.slice(10, 12) : '00';
  const s = ts.length >= 14 ? ts.slice(12, 14) : '00';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}
