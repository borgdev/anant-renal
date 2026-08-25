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
