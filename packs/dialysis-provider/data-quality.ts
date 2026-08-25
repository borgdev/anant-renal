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

import type { DataQualityFinding, DataQualityRule } from '../../src/healthcare-core/data-quality.js';
import type { DialysisTreatmentSession, DialysisPrescription, DialysisLabResult } from './ontology.js';

// DQ rules gate replay and workflow execution. Every finding carries the
// entity id + a small evidence bundle so the QAPI reviewer can jump straight
// to the source hypergraph node.

export const treatmentRules: Array<DataQualityRule<DialysisTreatmentSession>> = [
  {
    id: 'dialysis.patient-id-required',
    description: 'Every treatment session must reference a patient.',
    evaluate(session) {
      if (session.patientId) return [];
      return [{ ruleId: 'dialysis.patient-id-required', severity: 'critical', entityId: session.id, message: 'Treatment has no patient identifier', evidence: { session } }];
    },
  },
  {
    id: 'dialysis.facility-id-required',
    description: 'Every treatment session must reference a facility.',
    evaluate(session) {
      if (session.facilityId) return [];
      return [{ ruleId: 'dialysis.facility-id-required', severity: 'critical', entityId: session.id, message: 'Treatment has no facility identifier', evidence: { session } }];
    },
  },
  {
    id: 'dialysis.completed-at-required',
    description: 'Completed treatments must record a completion timestamp.',
    evaluate(session) {
      if (session.status !== 'completed') return [];
      if (session.completedAt) return [];
      return [{ ruleId: 'dialysis.completed-at-required', severity: 'error', entityId: session.id, message: 'Completed treatment has no completion timestamp', evidence: { session } }];
    },
  },
  {
    id: 'dialysis.missed-treatment-conflict',
    description: 'Missed treatments must not carry a completion timestamp.',
    evaluate(session) {
      if (session.status !== 'missed' || !session.completedAt) return [];
      return [{ ruleId: 'dialysis.missed-treatment-conflict', severity: 'error', entityId: session.id, message: 'Missed treatment has a completion timestamp', evidence: { session } }];
    },
  },
  {
    id: 'dialysis.ktv-plausibility',
    description: 'Delivered Kt/V must be within a physiological range.',
    evaluate(session) {
      if (session.ktvDelivered === undefined) return [];
      if (session.ktvDelivered < 0 || session.ktvDelivered > 3.5) {
        return [{ ruleId: 'dialysis.ktv-plausibility', severity: 'warning', entityId: session.id, message: 'Delivered Kt/V outside physiological range', evidence: { ktvDelivered: session.ktvDelivered } }];
      }
      return [];
    },
  },
];

export const prescriptionRules: Array<DataQualityRule<DialysisPrescription>> = [
  {
    id: 'dialysis.frequency-plausibility',
    description: 'In-center HD prescriptions typically 2-4 times weekly.',
    evaluate(rx) {
      if (rx.frequencyPerWeek < 1 || rx.frequencyPerWeek > 7) {
        return [{ ruleId: 'dialysis.frequency-plausibility', severity: 'warning', entityId: rx.id, message: 'Prescription frequency outside expected range', evidence: { frequencyPerWeek: rx.frequencyPerWeek } }];
      }
      return [];
    },
  },
];

export const labRules: Array<DataQualityRule<DialysisLabResult>> = [
  {
    id: 'dialysis.lab-loinc-required',
    description: 'Every lab result must carry a LOINC code.',
    evaluate(lab) {
      if (lab.loinc) return [];
      return [{ ruleId: 'dialysis.lab-loinc-required', severity: 'error', entityId: lab.id, message: 'Lab result missing LOINC', evidence: { lab } }];
    },
  },
];

export function combineFindings(...groups: DataQualityFinding[][]): DataQualityFinding[] {
  return groups.flat();
}
