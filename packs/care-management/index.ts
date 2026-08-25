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

// Cross-cutting care-management pack. Used by both provider and payer
// organizations for care coordination across a member/patient's journey —
// distinct from payer.care-management (which is plan-owned) and from provider
// pack workflows (which are facility-owned).

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export interface CarePlan {
  readonly planId: string;
  readonly subjectId: string;
  readonly problemStatements: readonly string[];
  readonly goals: readonly { readonly id: string; readonly description: string; readonly targetDate?: string; readonly status: 'planned' | 'in-progress' | 'achieved' | 'not-achieved' }[];
  readonly interventions: readonly { readonly at: string; readonly ownerRef: string; readonly description: string }[];
  readonly reviewCadenceDays: number;
  readonly nextReviewDue: string;
  readonly ownerRef: string;
  readonly participantRefs: readonly string[];
}

export interface CareCoordinationTask {
  readonly taskId: string;
  readonly subjectId: string;
  readonly createdAt: string;
  readonly kind: 'referral' | 'transition' | 'appointment' | 'medication-reconciliation' | 'follow-up-call' | 'benefits-check';
  readonly dueBy: string;
  readonly ownerRef: string;
  readonly status: 'open' | 'in-progress' | 'closed' | 'escalated';
}

export const careManagementPack: DomainPack = Object.freeze({
  id: 'care-management',
  version: '0.1.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system'] },
  capabilities: ['care-plan-management', 'transitions-of-care', 'referral-tracking', 'appointment-management', 'medication-reconciliation'],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'sla-monitor'],
});
