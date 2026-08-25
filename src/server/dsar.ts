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

// ePHI DSAR + anonymized export (Phase 4 compliance). A subject access request
// collects a patient + every entity that references them; the anonymized
// variant strips identifiers and replaces ids with stable hashes so analytics
// can still join rows without exposing PHI.

import { createHash } from 'node:crypto';
import type { EntityRecord } from '../realm/types.js';
import type { Realm } from '../realm/realm.js';

function hash(v: string): string { return createHash('sha256').update(v).digest('hex').slice(0, 12); }

export interface DsarBundle {
  patient: EntityRecord;
  related: EntityRecord[];
  recordCount: number;
}

/** Collect a patient and every entity that references them (by state.patientId or relations). */
export function collectPatientRecord(realm: Realm, patientId: string): DsarBundle | undefined {
  const patientUrn = realm.graph.urnFor('patient', patientId);
  const patient = realm.graph.get(patientUrn);
  if (!patient) return undefined;
  const related: EntityRecord[] = [];
  for (const rec of realm.graph.snapshot().entities) {
    if (rec.urn === patientUrn) continue;
    const st = rec.state as Record<string, unknown>;
    if (st['patientId'] === patientId) { related.push(rec); continue; }
    const refs = Object.values(rec.relations).flat();
    if (refs.includes(patientUrn)) related.push(rec);
  }
  return { patient, related, recordCount: related.length + 1 };
}

const IDENTIFIER_KEYS = new Set(['name', 'birthDate', 'sex', 'gender', 'mrn', 'ssn', 'phone', 'telecom', 'address', 'email', 'postalCode', 'npi', 'dateOfBirth']);

/** Deep-anonymize a record: drop identifier fields, hash ids + urns. */
export function anonymizeRecord(rec: EntityRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec.state as Record<string, unknown>)) {
    if (IDENTIFIER_KEYS.has(k)) continue;
    out[k] = typeof v === 'string' && (k.toLowerCase().includes('id') || k.toLowerCase().includes('urn'))
      ? `an-${hash(v)}`
      : v;
  }
  return {
    kind: rec.kind,
    id: `an-${hash(rec.id)}`,
    state: out,
    createdAt: rec.createdAt,
    anonymized: true,
  };
}

/** DSAR export for a patient (raw + anonymized). */
export function buildDsar(realm: Realm, patientId: string): { raw: DsarBundle; anonymized: { patient: Record<string, unknown>; related: Record<string, unknown>[]; recordCount: number } } | undefined {
  const bundle = collectPatientRecord(realm, patientId);
  if (!bundle) return undefined;
  return {
    raw: bundle,
    anonymized: {
      patient: anonymizeRecord(bundle.patient),
      related: bundle.related.map(anonymizeRecord),
      recordCount: bundle.recordCount,
    },
  };
}
