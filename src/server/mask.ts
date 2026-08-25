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

// PHI field masking (Phase 4 security). Reads below `restricted-phi` get
// sensitive fields redacted before they leave the API. Rides ActorContext.

export type Clearance = 'public' | 'internal' | 'confidential' | 'phi' | 'restricted-phi';

const RANK: Record<Clearance, number> = { public: 0, internal: 1, confidential: 2, phi: 3, 'restricted-phi': 4 };

/** Sensitive field names (case-insensitive) that are redacted below restricted-phi. */
const PHI_KEYS = new Set([
  'name', 'birthdate', 'dob', 'ssn', 'mrn', 'patientid', 'patientref', 'address', 'phone',
  'telecom', 'email', 'zip', 'postalcode', 'deceaseddatetime', 'mrn1', 'npi',
]);

/** Fields that are always redacted below `phi` (in addition to the restricted set). */
const PHI_KEYS_STRICT = new Set(['name', 'birthdate', 'dob', 'ssn', 'mrn', 'patientid', 'address', 'phone', 'telecom', 'email', 'npi']);

function shouldRedact(key: string, clearance: Clearance): boolean {
  const k = key.toLowerCase();
  if (RANK[clearance] >= 4) return false; // restricted-phi sees everything
  if (RANK[clearance] >= 3) return PHI_KEYS.has(k); // phi: redact the restricted set
  return PHI_KEYS_STRICT.has(k); // below phi: redact all identifiers
}

/** Deep-copy `value`, redacting sensitive fields for the given clearance. */
export function maskPhi(value: unknown, clearance: Clearance): unknown {
  if (Array.isArray(value)) return value.map((v) => maskPhi(v, clearance));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedact(k, clearance)) { out[k] = '[redacted]'; continue; }
      out[k] = maskPhi(v, clearance);
    }
    return out;
  }
  return value;
}

export function canReadPhi(clearance: Clearance): boolean { return RANK[clearance] >= 3; }
