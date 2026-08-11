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
