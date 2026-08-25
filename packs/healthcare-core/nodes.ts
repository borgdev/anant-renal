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

// packs/healthcare-core/nodes.ts — hypergraph node schemas for the healthcare domain.
//
// Registers the 21 EntityKinds from src/realm/types.ts plus the effect-derived /
// substrate nodes the domain hyperedges reference (care-plan, claim, prior-auth,
// measure, experience, nudge, ...). Assembled + validated by buildHealthcareHypergraphSchema()
// in ./hypergraph.ts. Invariant: every domain node requires `realmId`.

import type { AttributeSpec, Json, NodeSchema } from '../../src/hypergraph/types.js';

const str = (): AttributeSpec => ({ validate: (v: Json) => typeof v === 'string' });
const num = (): AttributeSpec => ({ validate: (v: Json) => typeof v === 'number' });
const req = (s: AttributeSpec): AttributeSpec => ({ ...s, required: true });
const opt = (): AttributeSpec => ({});
const realmId = (): AttributeSpec => req(str());

/** Node helper: require `realmId` + the kind's id attribute; clinical fields optional (enforced at the effect layer). */
function node(type: string, idAttr: string, extra: Record<string, AttributeSpec> = {}): NodeSchema {
  return { type, attributes: { realmId: realmId(), [idAttr]: req(str()), ...extra } };
}

/** Every node type the healthcare schema registers. */
export const NODE_TYPES: readonly string[] = [
  // realm root
  'realm',
  // core EntityKinds (src/realm/types.ts)
  'facility', 'unit', 'patient', 'encounter', 'order', 'result', 'medication',
  'staff', 'equipment', 'insurance', 'agent-run', 'presence', 'effect',
  'org-node', 'physical-object', 'work-artifact', 'intent', 'plan', 'approval',
  'cost-record', 'operator-directive',
  // M24 — clinical record + care coordination + payer families
  'condition', 'allergy', 'procedure', 'immunization', 'diagnostic-report', 'medication-admin',
  'questionnaire-response', 'document-reference', 'communication', 'appointment', 'schedule', 'slot',
  'explanation-of-benefit', 'invoice', 'account',
  'claim-response', 'care-team', 'goal', 'subscription', 'questionnaire', 'consent',
  'adverse-event', 'medication-statement', 'medication-dispense', 'imaging-study', 'specimen', 'detected-issue', 'payment-reconciliation', 'composition',
  // D4 — vision, device use, nutrition, supply, services, endpoints, affiliations, substances
  'vision-prescription', 'device-use', 'nutrition-order', 'supply-delivery', 'healthcare-service', 'endpoint', 'org-affiliation', 'substance',
  // effect-derived healthcare nodes (spec.md §2.2)
  'care-plan', 'assessment', 'vitals-snapshot', 'safety-event', 'claim', 'prior-auth',
  'measure', 'measure-library', 'value-set', 'measure-evaluation',
  'experience', 'nudge', 'memory-entry', 'voice-channel', 'twin.persona',
  'knowledge-source', 'knowledge-artifact', 'sync-outcome', 'pack',
];

export const HEALTHCARE_NODE_SCHEMAS: readonly NodeSchema[] = [
  { type: 'realm', attributes: { realmId: realmId(), mode: str(), clockKind: str(), orgId: str(), parentRealmId: opt() } },
  node('facility', 'facilityId', { orgId: str(), name: str(), facilityKind: str(), address: opt(), beds: num(), chairs: num() }),
  node('unit', 'unitId', { facilityId: str(), name: str(), unitKind: str(), bedCount: num(), chairCount: num() }),
  node('patient', 'patientId', { facilityId: str(), mrn: str(), demographicsHash: str(), phiClearanceLevel: str(), name: str(), age: num(), sex: str(), trajectory: str(), unitId: str(), activeEncounterId: str(), twinId: str() }),
  node('encounter', 'encounterId', { patientId: str(), facilityId: str(), startAt: str(), encounterKind: str(), endAt: str(), dispositionKind: str(), unitId: str() }),
  node('order', 'orderId', { patientId: str(), encounterId: str(), at: str(), orderKind: str(), priority: str(), code: str(), codeSystem: str() }),
  node('result', 'resultId', { orderId: str(), patientId: str(), at: str(), code: str(), codeSystem: str(), value: opt(), unit: str(), abnormalFlag: str() }),
  node('medication', 'medOrderId', { patientId: str(), at: str(), code: str(), codeSystem: str(), dose: str(), route: str(), frequency: str() }),
  node('staff', 'staffId', { facilityId: str(), role: str(), licenseNumber: str(), licenseState: str(), active: opt() }),
  node('equipment', 'equipmentId', { facilityId: str(), equipmentKind: str(), state: str(), assignedUnitId: str(), assignedPatientId: str() }),
  node('insurance', 'insuranceId', { patientId: str(), payerId: str(), planName: str(), policyNumber: str(), effectiveStart: str(), effectiveEnd: str() }),
  node('agent-run', 'runId', { agentSpecId: str(), startedAt: str(), status: str() }),
  node('presence', 'presenceId', { agentSpecId: str(), runId: str(), role: str(), clearance: str(), attention: str(), spawnedAt: str() }),
  node('effect', 'effectId', { presenceId: str(), agentSpecId: str(), emittedAt: str(), realmAt: str(), effectKind: str(), status: str() }),
  node('org-node', 'orgNodeId', { orgId: str(), nodeKind: str(), name: str(), parentOrgNodeId: str() }),
  node('physical-object', 'objectId', { facilityId: str(), objectKind: str(), state: str() }),
  node('work-artifact', 'artifactId', { artifactKind: str(), openedAt: str(), priority: str(), status: str() }),
  node('intent', 'intentId', { intentKind: str(), submittedAt: str(), priority: str(), descriptionHash: str() }),
  node('plan', 'planId', { intentId: str(), createdAt: str(), stepCount: num() }),
  node('approval', 'approvalId', { effectIdPending: str(), requestedAt: str(), hitlRole: str() }),
  node('cost-record', 'costRecordId', { episodeRef: str(), scoredAt: str(), qualityScore: num(), costUsd: num(), deltaVsBaseline: num() }),
  node('operator-directive', 'directiveId', { at: str(), verb: str(), originalText: str(), submitterRole: str() }),
  // M24 — clinical record + care coordination + payer families
  node('condition', 'conditionId', { patientId: str(), code: str(), codeSystem: str(), clinicalStatus: str(), category: str(), onset: str() }),
  node('allergy', 'allergyId', { patientId: str(), code: str(), criticality: str(), clinicalStatus: str() }),
  node('procedure', 'procedureId', { patientId: str(), code: str(), codeSystem: str(), status: str(), performedAt: str() }),
  node('immunization', 'immunizationId', { patientId: str(), vaccineCode: str(), status: str(), occurrence: str(), lotNumber: str() }),
  node('diagnostic-report', 'reportId', { patientId: str(), code: str(), status: str(), issuedAt: str() }),
  node('medication-admin', 'adminId', { patientId: str(), code: str(), status: str(), effectiveAt: str(), requestId: str() }),
  node('questionnaire-response', 'responseId', { subjectId: str(), questionnaire: str(), status: str(), authoredAt: str() }),
  node('document-reference', 'documentId', { subjectId: str(), type: str(), status: str(), date: str(), url: str() }),
  node('communication', 'communicationId', { subjectId: str(), status: str(), priority: str(), sentAt: str() }),
  node('appointment', 'appointmentId', { patientId: str(), status: str(), start: str(), end: str(), serviceType: str() }),
  node('schedule', 'scheduleId', { actorRef: str(), serviceType: str(), active: opt() }),
  node('slot', 'slotId', { scheduleId: str(), status: str(), start: str(), end: str() }),
  node('explanation-of-benefit', 'eobId', { patientId: str(), status: str(), use: str(), created: str(), totalAmount: num() }),
  node('invoice', 'invoiceId', { subjectId: str(), status: str(), date: str(), totalNet: num() }),
  node('account', 'accountId', { subjectRef: str(), status: str(), name: str(), ownerRef: str() }),
  // C batch — payer remittance, care-team, goals, subscription, forms, consent
  node('claim-response', 'claimResponseId', { patientId: str(), status: str(), use: str(), outcome: str(), totalAmount: num() }),
  node('care-team', 'careTeamId', { patientId: str(), status: str(), name: str(), memberRef: str() }),
  node('goal', 'goalId', { patientId: str(), lifecycleStatus: str(), code: str(), startDate: str(), targetValue: num() }),
  node('subscription', 'subscriptionId', { status: str(), criteria: str(), reason: str(), endpoint: str() }),
  node('questionnaire', 'questionnaireId', { title: str(), status: str(), url: str(), version: str() }),
  node('consent', 'consentId', { patientId: str(), status: str(), scope: str(), category: str() }),
  // D batch — adverse events, medication statement/dispense, imaging, specimen, detected issue, reconciliation, composition
  node('adverse-event', 'adverseEventId', { patientId: str(), status: str(), code: str(), date: str() }),
  node('medication-statement', 'medStatementId', { patientId: str(), status: str(), code: str(), effectiveAt: str() }),
  node('medication-dispense', 'medDispenseId', { patientId: str(), status: str(), code: str(), quantity: num() }),
  node('imaging-study', 'studyId', { patientId: str(), status: str(), modality: str(), started: str() }),
  node('specimen', 'specimenId', { patientId: str(), status: str(), type: str(), collectedAt: str() }),
  node('detected-issue', 'detectedIssueId', { patientId: str(), status: str(), code: str(), severity: str() }),
  node('payment-reconciliation', 'reconciliationId', { status: str(), created: str(), paymentAmount: num() }),
  node('composition', 'compositionId', { patientId: str(), status: str(), title: str(), date: str() }),
  // D4 — vision, device use, nutrition, supply, services, endpoints, affiliations, substances
  node('vision-prescription', 'visionRxId', { patientId: str(), status: str(), product: str(), dateWritten: str() }),
  node('device-use', 'deviceUseId', { patientId: str(), status: str(), deviceId: str(), recordedOn: str() }),
  node('nutrition-order', 'nutritionOrderId', { patientId: str(), status: str(), dietType: str(), dateTime: str() }),
  node('supply-delivery', 'supplyDeliveryId', { patientId: str(), status: str(), type: str(), quantity: num() }),
  node('healthcare-service', 'serviceId', { orgId: str(), category: str(), name: str(), facilityId: str() }),
  node('endpoint', 'endpointId', { status: str(), connectionType: str(), name: str(), address: str() }),
  node('org-affiliation', 'affiliationId', { orgId: str(), participantOrgId: str(), code: str(), specialty: str() }),
  node('substance', 'substanceId', { status: str(), code: str(), description: str() }),
  // effect-derived
  node('care-plan', 'carePlanId', { patientId: str(), createdAt: str(), activeStatus: str() }),
  node('assessment', 'assessmentId', { patientId: str(), at: str(), code: str(), codeSystem: str(), score: num(), band: str() }),
  node('vitals-snapshot', 'snapshotId', { patientId: str(), at: str(), hr: num(), bp: str(), spo2: num(), temp: num(), rr: num() }),
  node('safety-event', 'safetyEventId', { patientId: str(), at: str(), safetyKind: str(), severity: str() }),
  node('claim', 'claimId', { encounterId: str(), payerId: str(), submittedAt: str(), status: str() }),
  node('prior-auth', 'priorAuthId', { patientId: str(), payerId: str(), serviceCode: str(), requestedAt: str(), status: str() }),
  node('measure', 'measureId', { cmsId: str(), name: str(), version: str(), status: str() }),
  node('measure-library', 'libraryId', { name: str(), version: str() }),
  node('value-set', 'valueSetUrl', { expansionDate: str(), codesCount: num(), source: str() }),
  node('measure-evaluation', 'evaluationId', { measureId: str(), evaluatedAt: str(), patientsEvaluated: num(), patientsMet: num() }),
  node('experience', 'id', { twinId: str(), at: str(), firedBehaviorsCount: num(), candidatesCount: num() }),
  node('nudge', 'id', { behaviorId: str(), subjectTwinId: str(), at: str(), priority: str(), channel: str(), status: str() }),
  { type: 'memory-entry', attributes: { id: req(str()), at: str(), kind: str(), sourceUri: req(str()), contentHash: req(str()) } },
  { type: 'voice-channel', attributes: { channel: req(str()), available: opt(), schemaRef: str() } },
  node('twin.persona', 'id', { owner: str(), displayName: str(), walletBalanceUsd: num() }),
  { type: 'knowledge-source', attributes: { id: req(str()), name: str(), category: str(), tier: str() } },
  { type: 'knowledge-artifact', attributes: { id: req(str()), sourceId: str(), category: str(), title: str(), contentHash: req(str()) } },
  { type: 'sync-outcome', attributes: { sourceId: req(str()), startedAt: str(), finishedAt: str(), status: str() } },
  { type: 'pack', attributes: { id: req(str()), version: req(str()) } },
];
