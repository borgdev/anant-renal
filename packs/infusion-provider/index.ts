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
