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
  | 'effect'
  // M12 additions — org, physical, work-artifact
  | 'org-node'          // department, team, role node in the org-graph
  | 'physical-object'   // chair, station, machine, cart, room-resource
  | 'work-artifact'     // ticket, task, document, call, approval
  | 'intent'            // top-level goal an operator or agent pursues
  | 'plan'              // decomposed plan-graph for an intent
  | 'approval'          // HITL suspension record
  | 'cost-record'       // per-episode scored outcome vector
  | 'operator-directive' // NL directive from the operator seat
  // M24 additions — clinical record + care coordination + payer (FHIR families)
  | 'condition'            // Condition
  | 'allergy'              // AllergyIntolerance
  | 'procedure'            // Procedure
  | 'immunization'         // Immunization
  | 'diagnostic-report'    // DiagnosticReport
  | 'medication-admin'     // MedicationAdministration
  | 'questionnaire-response' // QuestionnaireResponse
  | 'document-reference'   // DocumentReference
  | 'communication'        // Communication
  | 'appointment'          // Appointment
  | 'schedule'             // Schedule
  | 'slot'                 // Slot
  | 'explanation-of-benefit' // ExplanationOfBenefit
  | 'invoice'              // Invoice
  | 'account'              // Account
  // C batch additions — payer/clinical-record + subscription infra
  | 'claim-response'       // ClaimResponse
  | 'care-team'            // CareTeam
  | 'goal'                 // Goal
  | 'subscription'         // Subscription
  | 'questionnaire'        // Questionnaire
  | 'consent'              // Consent
  // D batch additions — clinical-record, diagnostics, financial, documents
  | 'adverse-event'        // AdverseEvent
  | 'medication-statement' // MedicationStatement
  | 'medication-dispense'  // MedicationDispense
  | 'imaging-study'        // ImagingStudy
  | 'specimen'             // Specimen
  | 'detected-issue'       // DetectedIssue
  | 'payment-reconciliation' // PaymentReconciliation
  | 'composition'          // Composition
  // D4 batch additions — vision, devices, nutrition, supply, services, endpoints, affiliations, substances
  | 'vision-prescription'  // VisionPrescription
  | 'device-use'           // DeviceUseStatement
  | 'nutrition-order'      // NutritionOrder
  | 'supply-delivery'      // SupplyDelivery
  | 'healthcare-service'   // HealthcareService
  | 'endpoint'             // Endpoint
  | 'org-affiliation'      // OrganizationAffiliation
  | 'substance';           // Substance

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
  // ---- F1 renal protocol foundations: dialysis sessions + access observations ----
  | { kind: 'start-session'; patientId: string; sessionId?: string; modality: 'hemodialysis' | 'hemodiafiltration'; prescribedMinutes: number; targetUfL: number; dialyser?: string; qbPrescribed?: number; qdPrescribed?: number; tempC?: number }
  | { kind: 'record-session-telemetry'; patientId: string; minute: number; bp?: string; hr?: number; qb?: number; qd?: number; venousPressure?: number; arterialPressure?: number; ufRateMlH?: number; ufVolumeL?: number; tempC?: number; symptoms?: string[] }
  | { kind: 'end-session'; patientId: string; deliveredMinutes: number; ufVolumeL: number; qbAvg?: number; recirculationPct?: number; preWeightKg?: number; postWeightKg?: number; stoppedEarly?: boolean; complication?: string }
  | { kind: 'record-access'; patientId: string; event: 'surveillance' | 'cannulation-difficulty' | 'angioplasty' | 'thrombosis' | 'infection' | 'declot' | 'catheter-placed' | 'avf-created'; note?: string; venousPressureMmHg?: number; arterialPressureMmHg?: number; measuredAtQb?: number; bloodFlowMlMin?: number; accessFlowMlMin?: number; recirculationPct?: number; deliveredClearancePct?: number; cannulationDifficulty?: 'easy' | 'moderate' | 'difficult'; accessAgeDays?: number }
  // P3 — vascular access acoustic capture. SYNTHETIC ONLY: the payload is a small
  // feature vector (mel-band energies), never raw audio, and every capture carries
  // its provenance. Ingestion is gated by ACCESS_ACOUSTIC_ENABLED in the engine.
  | { kind: 'record-access-acoustic'; patientId: string; captureId: string; features: number[]; baseline: boolean; provenance: string; synthetic: true; featureKind?: 'mel-band-energies'; note?: string }
  | { kind: 'record-assessment'; patientId: string; assessmentId: string; score: number; band?: string }
  | { kind: 'update-care-plan'; patientId: string; patch: Record<string, unknown> }
  | { kind: 'schedule-followup'; patientId: string; when: string; resource: string; followupKind: string }
  | { kind: 'notify-staff'; targetRole: string; message: string; priority: 'low' | 'normal' | 'high' | 'critical'; patientRef?: string }
  | { kind: 'flag-safety-event'; patientId: string; safetyKind: string; severity: 'low' | 'moderate' | 'high' | 'critical' }
  | { kind: 'submit-claim'; encounterId: string; payerId: string; cptCodes: string[]; icd10Codes: string[] }
  | { kind: 'request-prior-auth'; patientId: string; payerId: string; serviceCode: string }
  | { kind: 'record-agent-thought'; note: string } // observability
  // ---- M12 additions ----
  // Physical-object interaction
  | { kind: 'assign-object'; objectId: string; toPatientId?: string; toPresenceId?: string; reason?: string }
  | { kind: 'release-object'; objectId: string; reason?: string }
  | { kind: 'mark-object-state'; objectId: string; newState: 'idle' | 'in-use' | 'cleaning' | 'maintenance' | 'down'; reason?: string }
  // Work-artifact lifecycle (tickets, tasks, documents, calls, approvals)
  | { kind: 'open-ticket'; ticketKind: string; subjectRef?: string; assigneeRole?: string; priority: 'low' | 'normal' | 'high' | 'critical'; summary: string }
  | { kind: 'update-ticket'; ticketId: string; patch: Record<string, unknown> }
  | { kind: 'close-ticket'; ticketId: string; resolution: 'resolved' | 'wont-fix' | 'duplicate' | 'escalated'; note?: string }
  // Org-graph escalation
  | { kind: 'escalate'; fromRole: string; toRole: string; artifactRef?: string; reason: string }
  // Intent + plan
  | { kind: 'submit-intent'; intentKind: string; subjectRef?: string; description: string; priority: 'low' | 'normal' | 'high' | 'critical' }
  | { kind: 'advance-plan'; planId: string; stepId: string; outcome: 'started' | 'completed' | 'blocked' | 'aborted'; note?: string }
  // Approval / HITL
  | { kind: 'approve-effect'; approvalId: string; decision: 'approve' | 'reject'; note?: string }
  // Operator seat directives (recorded as effects so they're auditable)
  | { kind: 'operator-directive'; verb: 'spawn' | 'nudge-preference' | 'add-rule' | 'submit-intent' | 'explain'; targetRef?: string; payload: Record<string, unknown>; originalText: string; evidenceId?: string };

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
