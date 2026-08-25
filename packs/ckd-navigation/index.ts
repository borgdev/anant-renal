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

// CKD navigation pack: track CKD stage progression, education completion, and
// modality selection before dialysis. Bridges into the dialysis-provider pack
// when a patient transitions to ESRD.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export type CkdStage = 1 | 2 | 3 | 4 | 5;

export interface CkdPatient {
  id: string;
  facilityId: string;
  stage: CkdStage;
  egfr?: number;
  albuminCreatinineRatio?: number;
  modalityEducationCompleted: boolean;
  transitionStartedAt?: string;
}

export function stageFromEgfr(egfr: number): CkdStage {
  if (egfr >= 90) return 1;
  if (egfr >= 60) return 2;
  if (egfr >= 30) return 3;
  if (egfr >= 15) return 4;
  return 5;
}

export function shouldStartTransition(patient: CkdPatient): boolean {
  if (patient.transitionStartedAt) return false;
  if (patient.stage >= 4) return true;
  if (patient.egfr !== undefined && patient.egfr < 20) return true;
  return false;
}

export function nextEducationTask(patient: CkdPatient): 'schedule-modality-education' | 'no-action' | 'refer-to-vascular-access' {
  if (patient.stage >= 4 && !patient.modalityEducationCompleted) return 'schedule-modality-education';
  if (patient.stage === 5 && patient.modalityEducationCompleted) return 'refer-to-vascular-access';
  return 'no-action';
}

export const ckdNavigationPack: DomainPack = Object.freeze({
  id: 'ckd-navigation',
  version: '0.1.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'health-system', 'practice'] },
  capabilities: ['ckd-stage-tracking', 'modality-education', 'transition-to-esrd'],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality'],
});
