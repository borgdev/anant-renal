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

// Missed-treatment case state machine. The transitions are the operational
// contract — CMS Conditions for Coverage require documented recovery, and
// this is where the harness makes that contract executable and inspectable.

import type { DialysisTreatmentSession } from '../ontology.js';

export type MissedTreatmentStatus =
  | 'identified'
  | 'verifying'
  | 'outreach'
  | 'recovery-planned'
  | 'escalated'
  | 'resolved'
  | 'quarantined';

export type MissedTreatmentReason = 'transport' | 'hospitalization' | 'contact-failure' | 'schedule-change' | 'unknown';
export type MissedTreatmentOwner = 'coordinator' | 'social-worker' | 'nurse' | 'agent';

export interface MissedTreatmentCase {
  id: string;
  treatmentId: string;
  patientId: string;
  facilityId: string;
  status: MissedTreatmentStatus;
  reason?: MissedTreatmentReason;
  evidenceIds: readonly string[];
  ownerRole: MissedTreatmentOwner;
  openedAt: string;
  updatedAt: string;
  attempts: number;
}

export interface MissedTreatmentSignal {
  treatment: DialysisTreatmentSession;
  hospitalizationConfirmed: boolean;
  transportIssue: boolean;
  unresolvedContact: boolean;
  now: string;
}

const TRANSITIONS: Record<MissedTreatmentStatus, readonly MissedTreatmentStatus[]> = {
  identified: ['verifying', 'quarantined'],
  verifying: ['outreach', 'escalated', 'quarantined'],
  outreach: ['recovery-planned', 'escalated', 'quarantined'],
  'recovery-planned': ['resolved', 'escalated'],
  escalated: ['recovery-planned', 'resolved', 'quarantined'],
  resolved: [],
  quarantined: ['verifying'],
};

export function canAdvance(from: MissedTreatmentStatus, to: MissedTreatmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function advance(caseState: MissedTreatmentCase, to: MissedTreatmentStatus, now: string): MissedTreatmentCase {
  if (!canAdvance(caseState.status, to)) {
    throw new Error(`Illegal missed-treatment transition ${caseState.status} -> ${to}`);
  }
  return Object.freeze({ ...caseState, status: to, updatedAt: now, attempts: to === 'outreach' ? caseState.attempts + 1 : caseState.attempts });
}

export function createMissedTreatmentCase(signal: MissedTreatmentSignal): MissedTreatmentCase | undefined {
  if (signal.treatment.status !== 'missed') return undefined;
  const reason: MissedTreatmentReason = signal.hospitalizationConfirmed
    ? 'hospitalization'
    : signal.transportIssue
      ? 'transport'
      : signal.unresolvedContact
        ? 'contact-failure'
        : 'unknown';
  const status: MissedTreatmentStatus = signal.hospitalizationConfirmed ? 'escalated' : 'verifying';
  return Object.freeze({
    id: `case:${signal.treatment.id}`,
    treatmentId: signal.treatment.id,
    patientId: signal.treatment.patientId,
    facilityId: signal.treatment.facilityId,
    status,
    reason,
    evidenceIds: [signal.treatment.id],
    ownerRole: 'agent',
    openedAt: signal.now,
    updatedAt: signal.now,
    attempts: 0,
  });
}

export type NextAction =
  | 'verify-source-data'
  | 'open-outreach'
  | 'escalate-nurse'
  | 'plan-recovery'
  | 'close-case'
  | 'none';

export function nextOperationalAction(caseState: MissedTreatmentCase): NextAction {
  switch (caseState.status) {
    case 'identified':
    case 'verifying':
      return 'verify-source-data';
    case 'outreach':
      return caseState.attempts >= 3 ? 'escalate-nurse' : 'open-outreach';
    case 'escalated':
      return 'escalate-nurse';
    case 'recovery-planned':
      return 'plan-recovery';
    case 'resolved':
      return 'close-case';
    case 'quarantined':
      return 'verify-source-data';
    default:
      return 'none';
  }
}
