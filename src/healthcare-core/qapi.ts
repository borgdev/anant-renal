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
