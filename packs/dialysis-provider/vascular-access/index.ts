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

// Vascular-access sub-pack: monitor access flows for surveillance signals.
// The harness never issues a clinical directive here — it produces a
// surveillance case that a nurse reviews.

import type { VascularAccess } from '../ontology.js';

export type AccessAlertKind = 'low-flow' | 'trend-decline' | 'infection-suspected' | 'ok';

export interface AccessSurveillanceCase {
  id: string;
  accessId: string;
  patientId: string;
  kind: AccessAlertKind;
  reason: string;
  openedAt: string;
}

const LOW_FLOW_THRESHOLDS: Record<VascularAccess['kind'], number> = {
  avf: 600,
  avg: 600,
  cvc: 300,
};

const TREND_DELTA_MIN = 200; // ml/min drop that triggers a trend alert.

export function assessAccess(current: VascularAccess, previous?: VascularAccess, now = new Date().toISOString()): AccessSurveillanceCase | null {
  if (current.status === 'failed') {
    return { id: `access-case:${current.id}`, accessId: current.id, patientId: current.patientId, kind: 'infection-suspected', reason: 'Access reported failed — requires nurse review', openedAt: now };
  }
  const threshold = LOW_FLOW_THRESHOLDS[current.kind];
  if (current.lastFlowMlPerMin !== undefined && current.lastFlowMlPerMin < threshold) {
    return { id: `access-case:${current.id}`, accessId: current.id, patientId: current.patientId, kind: 'low-flow', reason: `Flow ${current.lastFlowMlPerMin} < threshold ${threshold}`, openedAt: now };
  }
  if (previous?.lastFlowMlPerMin !== undefined && current.lastFlowMlPerMin !== undefined) {
    const delta = previous.lastFlowMlPerMin - current.lastFlowMlPerMin;
    if (delta >= TREND_DELTA_MIN) {
      return { id: `access-case:${current.id}`, accessId: current.id, patientId: current.patientId, kind: 'trend-decline', reason: `Flow dropped ${delta} ml/min since last check`, openedAt: now };
    }
  }
  return null;
}
