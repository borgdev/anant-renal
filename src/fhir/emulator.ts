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

// In-process FHIR R4 emulator (Phase 5 EHR-bridge).
//
// Serves a deterministic `_lastUpdated` history over a seeded dataset so the
// FhirSubscriptionPump can do a REAL live pull without an external FHIR server:
//   GET /fhir-mock/:resourceType?_lastUpdated=gt<since>&_count=100&_sort=-_lastUpdated
// returns a searchset Bundle. The admin seeds/refreshes the emulator via
// POST /admin/fhir/emulator/seed, then points the subscription poll at the
// in-process endpoint. Supports the full set of resource types the harness
// hydrates (Patient, Observation, Encounter, Condition, Procedure, ...).

import type { Bundle, FhirResource } from './types.js';

export interface EmulatorSearchParams {
  _lastUpdated?: string; // e.g. 'gt2026-08-16T...'
  _count?: string;
  _sort?: string;
}

const ONE_HOUR = 60 * 60 * 1000;

function iso(ms: number): string { return new Date(ms).toISOString(); }

/** A small deterministic EHR dataset (patients 1-2, vitals, an encounter, a condition, a procedure). */
export function seedFhirDataset(): FhirResource[] {
  const t = Date.now() - 6 * ONE_HOUR;
  return [
    {
      resourceType: 'Patient', id: 'f1-pt-0001',
      meta: { lastUpdated: iso(t), source: 'emulator' },
      identifier: [{ system: 'urn:mrn', value: 'f1-pt-0001', use: 'official' }],
      name: [{ family: 'Patient', given: ['One'] }], gender: 'female', birthDate: '1978-03-12', active: true,
    },
    {
      resourceType: 'Patient', id: 'f1-pt-0002',
      meta: { lastUpdated: iso(t + ONE_HOUR), source: 'emulator' },
      identifier: [{ system: 'urn:mrn', value: 'f1-pt-0002', use: 'official' }],
      name: [{ family: 'Patient', given: ['Two'] }], gender: 'male', birthDate: '1955-09-30', active: true,
    },
    {
      resourceType: 'Encounter', id: 'f1-enc-0001', status: 'in-progress',
      meta: { lastUpdated: iso(t + 2 * ONE_HOUR), source: 'emulator' },
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      subject: { reference: 'Patient/f1-pt-0001' },
      period: { start: iso(t + 2 * ONE_HOUR) },
    },
    {
      resourceType: 'Observation', id: 'f1-obs-k-0001', status: 'final',
      meta: { lastUpdated: iso(t + 3 * ONE_HOUR), source: 'emulator' },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] },
      subject: { reference: 'Patient/f1-pt-0001' },
      effectiveDateTime: iso(t + 3 * ONE_HOUR), issued: iso(t + 3 * ONE_HOUR),
      valueQuantity: { value: 5.8, unit: 'mmol/L' },
      interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'H' }] }],
    },
    {
      resourceType: 'Observation', id: 'f1-obs-hr-0001', status: 'final',
      meta: { lastUpdated: iso(t + 4 * ONE_HOUR), source: 'emulator' },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
      subject: { reference: 'Patient/f1-pt-0001' },
      effectiveDateTime: iso(t + 4 * ONE_HOUR), issued: iso(t + 4 * ONE_HOUR),
      valueQuantity: { value: 92, unit: 'bpm' },
    },
    {
      resourceType: 'Condition', id: 'f1-cond-dm', clinicalStatus: { coding: [{ code: 'active' }] },
      meta: { lastUpdated: iso(t + 5 * ONE_HOUR), source: 'emulator' },
      code: { coding: [{ system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes mellitus' }] },
      subject: { reference: 'Patient/f1-pt-0001' },
      onsetDateTime: iso(t - 30 * 24 * ONE_HOUR), recordedDate: iso(t + 5 * ONE_HOUR),
    },
    {
      resourceType: 'Procedure', id: 'f1-proc-avf', status: 'completed',
      meta: { lastUpdated: iso(t + 5.5 * ONE_HOUR), source: 'emulator' },
      code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '36825', display: 'AV fistula creation' }] },
      subject: { reference: 'Patient/f1-pt-0001' },
      performedDateTime: iso(t + 5.5 * ONE_HOUR),
    },
  ];
}

/** In-memory emulator — an append-only resource collection keyed by (type, id). */
export class FhirEmulator {
  private readonly byKey = new Map<string, FhirResource>();

  clear(): void { this.byKey.clear(); }

  seed(resources: readonly FhirResource[]): number {
    this.clear();
    for (const r of resources) this.add(r);
    return this.byKey.size;
  }

  add(resource: FhirResource): void {
    if (!resource.id) return;
    this.byKey.set(`${resource.resourceType}/${resource.id}`, resource);
  }

  list(): FhirResource[] { return [...this.byKey.values()]; }

  count(): number { return this.byKey.size; }
}

/** Project a FHIR search result honoring `_lastUpdated` + `_count` + `_sort` (R4 searchset). */
export function emulatorSearchBundle(em: FhirEmulator, resourceType: string, params: EmulatorSearchParams = {}): Bundle {
  let rows = em.list().filter((r) => r.resourceType === resourceType);
  const since = params._lastUpdated?.replace(/^gt/, '');
  if (since) rows = rows.filter((r) => (r.meta?.lastUpdated ?? '') > since);
  if (params._sort === '-_lastUpdated') rows = [...rows].sort((a, b) => (b.meta?.lastUpdated ?? '').localeCompare(a.meta?.lastUpdated ?? ''));
  const count = Math.max(1, Math.min(1000, Number(params._count ?? 100)));
  const slice = rows.slice(0, count);
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: rows.length,
    entry: slice.map((resource) => ({ resource })),
  };
}
