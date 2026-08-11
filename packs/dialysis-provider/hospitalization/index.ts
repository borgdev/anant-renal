// Hospitalization-transition sub-pack: turns admit/discharge events into a
// transition case that couples with missed-treatment recovery and scheduling.

import type { DialysisHospitalization, DialysisTreatmentSession } from '../ontology.js';

export type TransitionStatus = 'admitted' | 'in-hospital' | 'discharge-planning' | 'transitioned' | 'closed';

export interface HospitalizationTransition {
  id: string;
  hospitalizationId: string;
  patientId: string;
  facilityId: string;
  status: TransitionStatus;
  followUpDueBy?: string;
  affectedTreatmentIds: readonly string[];
  updatedAt: string;
}

export function openTransition(input: {
  hospitalization: DialysisHospitalization;
  facilityId: string;
  affectedTreatments: readonly DialysisTreatmentSession[];
  now: string;
}): HospitalizationTransition {
  return Object.freeze({
    id: `transition:${input.hospitalization.id}`,
    hospitalizationId: input.hospitalization.id,
    patientId: input.hospitalization.patientId,
    facilityId: input.facilityId,
    status: 'admitted',
    affectedTreatmentIds: input.affectedTreatments.map((t) => t.id),
    updatedAt: input.now,
  });
}

export function onDischarge(transition: HospitalizationTransition, dischargedAt: string, now: string): HospitalizationTransition {
  const followUp = new Date(dischargedAt);
  followUp.setUTCHours(followUp.getUTCHours() + 48);
  return Object.freeze({
    ...transition,
    status: 'discharge-planning',
    followUpDueBy: followUp.toISOString(),
    updatedAt: now,
  });
}

export function markTransitioned(transition: HospitalizationTransition, now: string): HospitalizationTransition {
  return Object.freeze({ ...transition, status: 'transitioned', updatedAt: now });
}
