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

// Dialysis pack ontology. The types deliberately mirror how CMS + operator
// SOPs speak about the domain so mapping from FHIR/HL7/CSV feeds is a rename,
// not a translation.

export type DialysisEntityType =
  | 'patient'
  | 'facility'
  | 'treatment'
  | 'chair'
  | 'shift'
  | 'vascular-access'
  | 'lab-result'
  | 'prescription'
  | 'hospitalization'
  | 'transport-barrier'
  | 'staff'
  | 'case';

export type DialysisHyperedgeType =
  | 'dialysis.treatment-session'
  | 'dialysis.missed-treatment'
  | 'dialysis.schedule-recovery'
  | 'dialysis.hospitalization-transition'
  | 'dialysis.lab-review'
  | 'dialysis.vascular-access-event'
  | 'dialysis.qapi-intervention';

export type TreatmentStatus = 'scheduled' | 'completed' | 'missed' | 'cancelled' | 'shortened';

export interface DialysisPatient {
  id: string;
  facilityId: string;
  modality: 'in-center-hd' | 'home-hd' | 'pd';
  esrdSinceIso?: string;
  transportationDependent: boolean;
}

export interface DialysisFacility {
  id: string;
  kind: 'outpatient-dialysis' | 'home-dialysis';
  chairCount: number;
  region: string;
}

export interface DialysisChair {
  id: string;
  facilityId: string;
  status: 'available' | 'in-use' | 'out-of-service';
}

export interface DialysisShift {
  id: string;
  facilityId: string;
  startsAtIso: string;
  endsAtIso: string;
  chairIds: readonly string[];
}

export interface DialysisTreatmentSession {
  id: string;
  patientId: string;
  facilityId: string;
  scheduledAt: string;
  completedAt?: string;
  chairId?: string;
  shiftId?: string;
  status: TreatmentStatus;
  ktvDelivered?: number;
  ufVolumeLiters?: number;
}

export interface DialysisPrescription {
  id: string;
  patientId: string;
  frequencyPerWeek: number;
  targetMinutes: number;
  targetKtV: number;
  updatedAt: string;
}

export interface DialysisLabResult {
  id: string;
  patientId: string;
  loinc: string;
  value: number;
  unit: string;
  observedAt: string;
}

export interface DialysisHospitalization {
  id: string;
  patientId: string;
  admittedAt: string;
  dischargedAt?: string;
  diagnosisCode?: string;
}

export interface VascularAccess {
  id: string;
  patientId: string;
  kind: 'avf' | 'avg' | 'cvc';
  placedAt: string;
  status: 'in-use' | 'monitoring' | 'failed';
  lastFlowMlPerMin?: number;
}
