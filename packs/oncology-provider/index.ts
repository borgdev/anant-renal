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

// Oncology provider pack (stub-shape). Provides ontology + workflows for
// cancer-treatment operations: treatment plans, chemo/immuno cycles, toxicity
// monitoring, tumor-board review, survivorship. Bindings to Oncology Care
// Model (OCM) + Enhancing Oncology Model (EOM) hooks live under cmsUniverse.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export type OncologyTreatmentIntent = 'curative' | 'palliative' | 'adjuvant' | 'neoadjuvant' | 'maintenance';

export interface OncologyTreatmentPlan {
  readonly planId: string;
  readonly patientId: string;
  readonly diagnosisIcd10: string;
  readonly stage: string;
  readonly intent: OncologyTreatmentIntent;
  readonly regimenName: string;
  readonly cycles: readonly { readonly cycleNumber: number; readonly plannedStart: string; readonly durationDays: number }[];
  readonly priorAuthorizationRequired: boolean;
  readonly documentIdSupportingPlan: string;
}

export interface ToxicityAssessment {
  readonly patientId: string;
  readonly assessedAt: string;
  readonly ctcaeGrade: 1 | 2 | 3 | 4 | 5;
  readonly system: 'hematologic' | 'gastrointestinal' | 'cardiac' | 'pulmonary' | 'neurologic' | 'renal' | 'dermatologic';
  readonly requiresDoseModification: boolean;
  readonly requiresHospitalization: boolean;
}

export const oncologyProviderPack: DomainPack = Object.freeze({
  id: 'oncology-provider',
  version: '0.1.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'health-system'], facilityKinds: ['infusion-center', 'outpatient-oncology', 'inpatient-oncology'] },
  capabilities: ['treatment-plan-management', 'chemo-cycle-tracking', 'toxicity-monitoring', 'tumor-board', 'survivorship', 'prior-auth-coordination'],
  cmsUniverse: [
    { id: 'cms:mips', title: 'MIPS', authority: 'CMS' },
    { id: 'cms:enhancing-oncology-model', title: 'Enhancing Oncology Model (EOM)', authority: 'CMS' },
  ],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'toxicity-alerting', 'prior-auth-coordination'],
});
