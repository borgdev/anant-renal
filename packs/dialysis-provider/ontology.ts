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
