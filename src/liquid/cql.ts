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

// Score learned trajectories with the real CQL measure evaluator (M21).
//
// The trajectory process writes clinical labs (K/HGB/URR/PHOS) projected from the learned
// dialysis state; this bridge turns a patient into a FHIR bundle and runs the actual CMS
// measure logic (cql-execution) over it — so the clinical effect of a learned trajectory is
// *scored*, not asserted. Gracefully degrades when the measure store isn't loaded (no synced
// eCQM repo → `{ scored: false, reason: 'measure-store-not-loaded' }`).

import type { MeasureEvaluator } from '../measures/evaluator.js';
import type { DialysisLabs } from './types.js';

export interface LabPatient {
  id: string;
  labs: DialysisLabs;
  hypertension?: boolean;
  vitals?: { hr?: number; spo2?: number };
}

export interface MeasurementPeriod { start: string; end: string }

const YEAR = () => `${new Date().getFullYear()}`;

/** Build a minimal FHIR R4 Bundle (Patient + labs + optional HTN condition) for scoring. */
export function buildLabsBundle(patient: LabPatient, measurementPeriod?: MeasurementPeriod): unknown {
  const period = measurementPeriod ?? { start: `${YEAR()}-01-01`, end: `${YEAR()}-12-31` };
  const now = new Date().toISOString();
  const obs = (code: string, system: string, display: string, value: number, unit: string) => ({
    resourceType: 'Observation',
    id: `${patient.id}-${code}`,
    status: 'final',
    subject: { reference: `Patient/${patient.id}` },
    effectiveDateTime: now,
    code: { coding: [{ system, code, display }] },
    valueQuantity: { value, unit },
  });
  const resources: unknown[] = [
    { resourceType: 'Patient', id: patient.id },
    obs('2823-3', 'http://loinc.org', 'Potassium', patient.labs.K, 'mmol/L'),
    obs('718-7', 'http://loinc.org', 'Hemoglobin', patient.labs.HGB, 'g/dL'),
    obs('48151-2', 'http://loinc.org', 'Urea reduction ratio', patient.labs.URR, '%'),
    obs('14879-1', 'http://loinc.org', 'Phosphate [Mass/volume] in Serum or Plasma', patient.labs.PHOS, 'mg/dL'),
  ];
  if (patient.hypertension) {
    resources.push({
      resourceType: 'Condition',
      id: `${patient.id}-htn`,
      subject: { reference: `Patient/${patient.id}` },
      code: { coding: [{ system: 'http://snomed.info/sct', code: '59621000', display: 'Essential hypertension (disorder)' }] },
      onsetDateTime: now,
    });
  }
  if (patient.vitals?.hr) {
    resources.push(obs('8867-4', 'http://loinc.org', 'Heart rate', patient.vitals.hr, '/min'));
  }
  void period;
  return { resourceType: 'Bundle', type: 'collection', entry: resources.map((resource) => ({ resource })) };
}

export interface PatientScore {
  patientId: string;
  met: boolean;
  populations: Record<string, boolean>;
}

export interface ScoreResult {
  scored: boolean;
  measureId: string;
  reason?: string;
  patients: PatientScore[];
}

/** Evaluate a measure over liquid-lab patients with the real CQL evaluator. */
export async function scoreLabs(
  evaluator: MeasureEvaluator | undefined,
  measureId: string,
  patients: LabPatient[],
  measurementPeriod?: MeasurementPeriod,
): Promise<ScoreResult> {
  if (!evaluator) {
    return { scored: false, measureId, reason: 'measure-store-not-loaded', patients: [] };
  }
  const scored: PatientScore[] = [];
  for (const p of patients) {
    const bundle = buildLabsBundle(p, measurementPeriod);
    const result = await evaluator.evaluate({ measureId, bundle, ...(measurementPeriod ? { measurementPeriod } : {}) });
    const patientRes = result.patients[0];
    const populations: Record<string, boolean> = {};
    for (const pop of patientRes?.populations ?? []) {
      populations[pop.code] = Boolean(pop.member);
    }
    scored.push({ patientId: p.id, met: patientRes?.met ?? false, populations });
  }
  return { scored: true, measureId, patients: scored };
}
