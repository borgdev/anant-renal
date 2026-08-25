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

// QAPI (Quality Assessment and Performance Improvement) is CMS-mandated for
// dialysis facilities. In the harness it is not a form — it is a first-class
// case type with an explicit lifecycle and evidence ids that trace back to
// hypergraph nodes.

export type QapiStatus = 'identified' | 'investigating' | 'intervening' | 'monitoring' | 'closed';

export interface QapiCase {
  id: string;
  facilityId: string;
  status: QapiStatus;
  measureIds: readonly string[];
  evidenceIds: readonly string[];
  ownerId: string;
  openedAt: string;
  updatedAt: string;
  narrative?: string;
}

const QAPI_TRANSITIONS: Record<QapiStatus, readonly QapiStatus[]> = {
  identified: ['investigating', 'closed'],
  investigating: ['intervening', 'closed'],
  intervening: ['monitoring', 'closed'],
  monitoring: ['intervening', 'closed'],
  closed: [],
};

export function canAdvanceQapi(from: QapiStatus, to: QapiStatus): boolean {
  return QAPI_TRANSITIONS[from].includes(to);
}

export function advanceQapi(qapiCase: QapiCase, to: QapiStatus, now: string): QapiCase {
  if (!canAdvanceQapi(qapiCase.status, to)) {
    throw new Error(`Illegal QAPI transition ${qapiCase.status} -> ${to}`);
  }
  return Object.freeze({ ...qapiCase, status: to, updatedAt: now });
}
