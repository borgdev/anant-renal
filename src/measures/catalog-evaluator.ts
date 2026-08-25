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

// Embedded (CQL-free) catalog measure evaluator (C batch).
//
// Catalog measures annotated with `thresholds` are scored directly against a
// FHIR bundle's LOINC observations — no synced eCQM/CQL store required. This
// makes the harness's own CMS catalog measures evaluable out of the box and
// offline, complementing the CQL evaluator for synced eCQM measures.

import type { CMSMeasureSpec } from '../healthcare-core/cms-source-registry.js';

interface Observation {
  resourceType: string;
  id?: string;
  subject?: { reference?: string };
  code?: { coding?: Array<{ code?: string }> };
  valueQuantity?: { value?: number; unit?: string };
}

export interface CatalogPatientScore {
  patientId: string;
  met: boolean;
  criteria: Array<{ loinc: string; kind: string; met: boolean; value?: number; target?: number; unit?: string }>;
}

export interface CatalogEvaluation {
  measureId: string;
  measureVersion: string;
  cmsId: string;
  evaluatedAt: string;
  engine: 'embedded';
  patients: CatalogPatientScore[];
}

function codeOf(o: Observation): string {
  return o.code?.coding?.[0]?.code ?? '';
}

function subjectId(o: Observation): string {
  const ref = o.subject?.reference;
  if (ref) return ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  return 'p1';
}

/** Score one patient's observations against the measure's threshold criteria. */
function scorePatient(spec: CMSMeasureSpec, patientId: string, obs: Observation[]): CatalogPatientScore {
  const thresholds = spec.thresholds!;
  const criteria = thresholds.criteria.map((c) => {
    const matching = obs.filter((o) => codeOf(o) === c.loinc);
    if (c.kind === 'reported') {
      return { loinc: c.loinc, kind: 'reported', met: matching.length > 0 };
    }
    const numeric = matching.find((o) => typeof o.valueQuantity?.value === 'number');
    const value = numeric?.valueQuantity?.value;
    const target = c.target ?? 0;
    let met = false;
    if (value !== undefined) {
      switch (c.comparator ?? 'ge') {
        case 'ge': met = value >= target; break;
        case 'gt': met = value > target; break;
        case 'le': met = value <= target; break;
        case 'lt': met = value < target; break;
        case 'eq': met = value === target; break;
      }
    }
    return { loinc: c.loinc, kind: 'threshold', met, ...(value !== undefined ? { value } : {}), target, ...(c.unit ? { unit: c.unit } : {}) };
  });
  const met = (thresholds.mode ?? 'any') === 'all' ? criteria.every((c) => c.met) : criteria.some((c) => c.met);
  return { patientId, met, criteria };
}

/** Evaluate a catalog measure (with `thresholds`) against a FHIR Bundle. */
export function evaluateCatalogMeasure(spec: CMSMeasureSpec, bundle: unknown): CatalogEvaluation {
  const entries = (bundle as { entry?: Array<{ resource?: unknown }> }).entry ?? [];
  const observations = entries
    .map((e) => e.resource)
    .filter((r): r is Observation => Boolean(r) && (r as { resourceType?: string }).resourceType === 'Observation');

  const byPatient = new Map<string, Observation[]>();
  for (const o of observations) {
    const id = subjectId(o);
    if (!byPatient.has(id)) byPatient.set(id, []);
    byPatient.get(id)!.push(o);
  }
  if (byPatient.size === 0) byPatient.set('p1', observations);

  const patients: CatalogPatientScore[] = [];
  for (const [id, obs] of byPatient) patients.push(scorePatient(spec, id, obs));

  return {
    measureId: spec.id,
    measureVersion: spec.version,
    cmsId: spec.id,
    evaluatedAt: new Date().toISOString(),
    engine: 'embedded',
    patients,
  };
}
