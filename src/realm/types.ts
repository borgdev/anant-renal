// Realm — shared type vocabulary.
//
// Everything the Realm exposes is expressed through these types. Entities
// are addressed by URN. Effects are the only way to mutate the world.
// Presence is the agent's body in the world; perception is what the agent
// can see through that body.

export type RealmId = string; // e.g. 'realm:dvc-nash-live'
export type RealmMode = 'sim' | 'twin';

export type EntityKind =
  | 'facility'
  | 'unit'
  | 'patient'
  | 'encounter'
  | 'order'
  | 'result'
  | 'medication'
  | 'staff'
  | 'equipment'
  | 'insurance'
  | 'agent-run'
  | 'presence'
  | 'effect';

export type EntityUrn = `urn:realm:${string}:${EntityKind}:${string}`;

export interface EntityRef { kind: EntityKind; id: string; urn: EntityUrn; }

export interface EntityRecord<S = Record<string, unknown>> {
  urn: EntityUrn;
  kind: EntityKind;
  id: string;
  state: S;
  relations: Record<string, EntityUrn[]>;
  createdAt: string;
  updatedAt: string;
  history: Array<{ at: string; patch: Partial<S>; cause: string }>;
}

// Time model — a tick is the smallest advancement unit.
export interface ClockTick {
  seq: number;
  wallAt: string;
  realmAt: string;
  deltaMs: number;
}

export type ClockKind = 'wall' | 'accelerated';

// Presence — the agent's body in the world.
export interface AgentPresence {
  presenceId: string; // urn short id
  realmId: RealmId;
  agentSpecId: string;
  runId: string;
  role: 'nurse' | 'md' | 'pa' | 'pharmacist' | 'coder' | 'ops' | 'auditor' | 'tech' | 'admin';
  clearance: 'public' | 'internal' | 'confidential' | 'phi' | 'restricted-phi';
  purposeOfUse: Array<'treatment' | 'operations' | 'compliance' | 'research' | 'break-glass'>;
  location: { facilityId: string; unitId?: string; patientRef?: EntityUrn };
  perceptualRange: {
    units: string[]; // unit ids the presence sees; ['*'] = whole facility
    patients: string[]; // patient ids the presence follows; ['*'] = all in scope
    eventTypes: string[]; // event kinds the presence subscribes to
  };
  attention: 'active' | 'idle' | 'paused';
  spawnedAt: string;
  lastPerceivedAt?: string;
}

// World Effects — the vocabulary of intent.
export type WorldEffect =
  | { kind: 'admit-patient'; patientId: string; facilityId: string; unitId: string; reason?: string }
  | { kind: 'transfer-patient'; patientId: string; fromUnitId: string; toUnitId: string; reason?: string }
  | { kind: 'discharge-patient'; patientId: string; disposition: 'home' | 'home-health' | 'snf' | 'hospice' | 'transfer' | 'ama' | 'expired'; reason?: string }
  | { kind: 'order-lab'; patientId: string; code: string; priority: 'stat' | 'routine' | 'send-out'; encounterId?: string }
  | { kind: 'result-lab'; orderId: string; code: string; value: number | string; unit: string; abnormal?: 'H' | 'L' | 'HH' | 'LL' | 'A' }
  | { kind: 'order-med'; patientId: string; code: string; dose: string; route: string; frequency: string; indication?: string }
  | { kind: 'administer-med'; patientId: string; medOrderId: string; dose: string; givenAt: string }
  | { kind: 'hold-med'; patientId: string; medOrderId: string; reason: string }
  | { kind: 'titrate-med'; medOrderId: string; delta: string; reason: string }
  | { kind: 'record-vitals'; patientId: string; hr?: number; bp?: string; spo2?: number; temp?: number; rr?: number }
  | { kind: 'record-assessment'; patientId: string; assessmentId: string; score: number; band?: string }
  | { kind: 'update-care-plan'; patientId: string; patch: Record<string, unknown> }
  | { kind: 'schedule-followup'; patientId: string; when: string; resource: string; followupKind: string }
  | { kind: 'notify-staff'; targetRole: string; message: string; priority: 'low' | 'normal' | 'high' | 'critical'; patientRef?: string }
  | { kind: 'flag-safety-event'; patientId: string; safetyKind: string; severity: 'low' | 'moderate' | 'high' | 'critical' }
  | { kind: 'submit-claim'; encounterId: string; payerId: string; cptCodes: string[]; icd10Codes: string[] }
  | { kind: 'request-prior-auth'; patientId: string; payerId: string; serviceCode: string }
  | { kind: 'record-agent-thought'; note: string }; // observability

export interface EmittedEffect {
  effectId: string;
  presenceId: string;
  agentSpecId: string;
  emittedAt: string;
  realmAt: string;
  effect: WorldEffect;
  status: 'shadow' | 'bound' | 'rejected';
  rejection?: string;
  mutations?: Array<{ urn: EntityUrn; patch: Record<string, unknown> }>;
  triggeredEvents?: string[];
}

// Perceived event — filtered through presence.
export interface PerceivedEvent {
  eventId: string;
  presenceId: string;
  at: string;
  realmAt: string;
  kind: string; // e.g. 'entity.updated', 'effect.applied', 'ambient.result-ready'
  entityUrn?: EntityUrn;
  payload: Record<string, unknown>;
}
