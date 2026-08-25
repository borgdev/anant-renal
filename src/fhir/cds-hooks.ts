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

// CDS Hooks (Phase 5) — Clinical Decision Support as FHIR-standard cards.
// A CDS Hooks request (hook + patient/encounter context) is answered with
// deterministic cards derived from the realm's live graph: abnormal-result
// warnings, active-medication reconciliation, latest vitals, and care-gap hints.

import type { Realm } from '../realm/realm.js';
import type { EntityRecord } from '../realm/types.js';

export interface CdsHooksRequest {
  hook: string;
  hookInstance: string;
  fhirServer?: string;
  context: {
    userId?: string;
    patientId?: string;
    encounterId?: string;
    [key: string]: unknown;
  };
  prefetch?: Record<string, unknown>;
}

export interface CdsCardSuggestion { label: string; actions?: Array<{ type: string; description: string; resource?: Record<string, unknown> }>; }
export interface CdsCard {
  uuid: string;
  summary: string;
  detail?: string;
  indicator: 'info' | 'warning' | 'critical';
  source: { label: string; url?: string };
  suggestions?: CdsCardSuggestion[];
  links?: Array<{ label: string; url: string; type: string }>;
}

export interface CdsHooksResponse { cards: CdsCard[]; }

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stateOf(rec: EntityRecord | undefined): Record<string, unknown> {
  return (rec?.state ?? {}) as Record<string, unknown>;
}

/** Build CDS cards from a realm for a patient. Deterministic, rule-based. */
export function cdsHooksToCards(req: CdsHooksRequest, realm: Realm): CdsHooksResponse {
  const cards: CdsCard[] = [];
  const patientId = req.context.patientId;
  if (!patientId) {
    cards.push({ uuid: uuid(), summary: 'No patient context', detail: 'The CDS request carried no patientId, so no patient-specific decision support is available.', indicator: 'info', source: { label: 'Anant Harness CDS' } });
    return { cards };
  }

  const patient = realm.graph.get(realm.graph.urnFor('patient', patientId));
  const st = stateOf(patient);

  // Abnormal lab results → warning card with a re-order suggestion.
  // Results link to their order via `of-order`; orders carry the patientId.
  const orderUrns = new Set(
    realm.graph.listKind('order').filter((o) => stateOf(o)['patientId'] === patientId).map((o) => o.urn),
  );
  const abnormalResults = realm.graph.listKind('result').filter((r) => {
    const s = stateOf(r);
    if (!(s['abnormal'] === 'H' || s['abnormal'] === 'L' || s['abnormal'] === 'HH' || s['abnormal'] === 'LL')) return false;
    const refs = Object.values(r.relations).flat();
    return refs.some((urn) => orderUrns.has(urn));
  });
  if (abnormalResults.length > 0) {
    const latest = abnormalResults.slice(-3).map((r) => { const s = stateOf(r); return `${s['code']} ${s['value']}${s['unit'] ?? ''} (${s['abnormal']})`; });
    cards.push({
      uuid: uuid(),
      summary: `${abnormalResults.length} abnormal result(s)`,
      detail: `Patient ${patientId} has abnormal lab results: ${latest.join(', ')}. Consider a re-check or clinical review.`,
      indicator: 'warning',
      source: { label: 'Anant Harness CDS' },
      suggestions: [{ label: 'Order follow-up lab', actions: [{ type: 'create', description: 'ServiceRequest for the abnormal code' }] }],
    });
  }

  // Active medications → reconciliation hint.
  const meds = realm.graph.listKind('medication').filter((r) => stateOf(r)['patientId'] === patientId && stateOf(r)['status'] === 'active');
  if (meds.length > 0) {
    cards.push({
      uuid: uuid(),
      summary: `${meds.length} active medication(s)`,
      detail: `Reconcile ${meds.length} active medication order(s) against the patient's home list.`,
      indicator: 'info',
      source: { label: 'Anant Harness CDS' },
    });
  }

  // Latest vitals.
  const vitals = st['lastVitals'] as Record<string, unknown> | undefined;
  if (vitals) {
    const hr = vitals['hr'] !== undefined ? `HR ${vitals['hr']}` : '';
    const bp = vitals['bp'] !== undefined ? `BP ${vitals['bp']}` : '';
    const spo2 = vitals['spo2'] !== undefined ? `SpO2 ${vitals['spo2']}` : '';
    cards.push({ uuid: uuid(), summary: `Latest vitals: ${[hr, bp, spo2].filter(Boolean).join(' · ')}`, detail: `Recorded at ${vitals['at'] ?? '—'}.`, indicator: 'info', source: { label: 'Anant Harness CDS' } });
  }

  // Care-gap: no scheduled follow-up / care plan.
  const plans = realm.graph.listKind('plan').filter((r) => stateOf(r)['patientId'] === patientId);
  if (plans.length === 0 && patient) {
    cards.push({
      uuid: uuid(),
      summary: 'Care-gap: no care plan on file',
      detail: `No active care plan references ${patientId}. Consider drafting one.`,
      indicator: 'warning',
      source: { label: 'Anant Harness CDS' },
    });
  }

  if (cards.length === 0) {
    cards.push({ uuid: uuid(), summary: 'No decision support flags', detail: 'No abnormal results, active medications, or care gaps detected for this patient.', indicator: 'info', source: { label: 'Anant Harness CDS' } });
  }
  return { cards };
}
