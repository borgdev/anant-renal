// Infusion provider pack (stub-shape). Standalone infusion centers,
// hospital-based infusion suites, and home-infusion companies. Chair
// scheduling, drug preparation, infusion administration, reaction monitoring.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export interface ChairSchedule {
  readonly chairId: string;
  readonly facilityId: string;
  readonly date: string;
  readonly slots: readonly { readonly startAt: string; readonly durationMin: number; readonly patientId?: string; readonly infusionOrderId?: string }[];
}

export interface InfusionOrder {
  readonly orderId: string;
  readonly patientId: string;
  readonly rxnormCode: string;
  readonly dose: number;
  readonly doseUnit: string;
  readonly infusionRateMinutes: number;
  readonly premedications: readonly string[];
  readonly cycleId?: string;
}

export type InfusionReactionGrade = 'none' | 'mild' | 'moderate' | 'severe' | 'anaphylaxis';

export interface InfusionAdministration {
  readonly administrationId: string;
  readonly orderId: string;
  readonly chairId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly reaction: InfusionReactionGrade;
  readonly reactionInterventions: readonly string[];
  readonly administeredByRef: string;
}

export const infusionProviderPack: DomainPack = Object.freeze({
  id: 'infusion-provider',
  version: '0.1.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider'], facilityKinds: ['infusion-center', 'home-infusion'] },
  capabilities: ['chair-scheduling', 'drug-preparation', 'infusion-administration', 'reaction-monitoring', 'prior-auth-coordination'],
  cmsUniverse: [{ id: 'cms:mips', title: 'MIPS', authority: 'CMS' }],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'reaction-alerting'],
});
