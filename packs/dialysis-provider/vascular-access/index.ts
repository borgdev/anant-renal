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
