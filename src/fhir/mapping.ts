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

// ENTITY_FHIR — the entity ↔ FHIR contract (Phase 2).
//
// Every entity kind that has a clinical/administrative FHIR resource gets a
// pair of pure functions:
//   hydrate(resource, ctx)  → CanonicalEvent[]  (consume path — extends mapFhirBundle)
//   serialize(rec, ctx)     → FhirResource[]    (produce path — entity → R4)
// Kinds without a direct wire resource (presence, agent-run, effect, …) consume
// transitively and produce via a standard resource (Provenance / effect-map).

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';
import type { EntityKind, EntityRecord } from '../realm/types.js';
import { CODE_SYSTEMS, concept, code, type FhirCtx, type FhirResource } from './types.js';
import type {
  Patient, Organization, Location, Encounter, ServiceRequest, MedicationRequest, Observation, Practitioner, PractitionerRole, Device, Coverage, Claim, CarePlan, Task, Measure, ValueSet, MeasureReport, Provenance,
  Condition, AllergyIntolerance, Procedure, Immunization, DiagnosticReport, MedicationAdministration, QuestionnaireResponse, DocumentReference, Communication, Appointment, Schedule, Slot, ExplanationOfBenefit, Invoice, Account,
  ClaimResponse, CareTeam, Goal, Subscription, Questionnaire, Consent,
  AdverseEvent, MedicationStatement, MedicationDispense, ImagingStudy, Specimen, DetectedIssue, PaymentReconciliation, Composition,
  VisionPrescription, DeviceUseStatement, NutritionOrder, SupplyDelivery, HealthcareService, Endpoint, OrganizationAffiliation, Substance,
} from './types.js';

export interface EntityFhirMapping {
  /** FHIR resourceType(s) this kind consumes and produces. */
  resourceTypes: string[];
  /** FHIR resource(s) → canonical events (classification: 'phi'). */
  hydrate(resource: FhirResource, ctx: FhirCtx): CanonicalEvent[];
  /** Entity record → FHIR resource(s). */
  serialize(rec: EntityRecord, ctx: FhirCtx): FhirResource[];
}

/** FHIR resourceType → entity kind (single primary kind per resource). */
export const RESOURCE_TO_KIND: Record<string, EntityKind | undefined> = {
  Patient: 'patient',
  Organization: 'org-node',
  Location: 'unit',
  Encounter: 'encounter',
  ServiceRequest: 'order',
  MedicationRequest: 'order',
  Medication: 'medication',
  Observation: 'result',
  Practitioner: 'staff',
  PractitionerRole: 'staff',
  Device: 'equipment',
  Coverage: 'insurance',
  Claim: 'insurance', // realm stores claims as insurance entities (state.kind='claim')
  CarePlan: 'plan',
  Task: 'work-artifact',
  CommunicationRequest: 'operator-directive',
  MeasureReport: 'cost-record',
  Provenance: 'agent-run',
  Condition: 'condition',
  AllergyIntolerance: 'allergy',
  Procedure: 'procedure',
  Immunization: 'immunization',
  DiagnosticReport: 'diagnostic-report',
  MedicationAdministration: 'medication-admin',
  QuestionnaireResponse: 'questionnaire-response',
  DocumentReference: 'document-reference',
  Communication: 'communication',
  Appointment: 'appointment',
  Schedule: 'schedule',
  Slot: 'slot',
  ExplanationOfBenefit: 'explanation-of-benefit',
  Invoice: 'invoice',
  Account: 'account',
  ClaimResponse: 'claim-response',
  CareTeam: 'care-team',
  Goal: 'goal',
  Subscription: 'subscription',
  Questionnaire: 'questionnaire',
  Consent: 'consent',
  AdverseEvent: 'adverse-event',
  MedicationStatement: 'medication-statement',
  MedicationDispense: 'medication-dispense',
  ImagingStudy: 'imaging-study',
  Specimen: 'specimen',
  DetectedIssue: 'detected-issue',
  PaymentReconciliation: 'payment-reconciliation',
  Composition: 'composition',
  VisionPrescription: 'vision-prescription',
  DeviceUseStatement: 'device-use',
  NutritionOrder: 'nutrition-order',
  SupplyDelivery: 'supply-delivery',
  HealthcareService: 'healthcare-service',
  Endpoint: 'endpoint',
  OrganizationAffiliation: 'org-affiliation',
  Substance: 'substance',
};

/** entity kind → primary FHIR resourceType(s). */
export const KIND_TO_RESOURCES: Record<EntityKind, string[]> = {
  facility: ['Organization', 'Location'],
  unit: ['Location'],
  patient: ['Patient'],
  encounter: ['Encounter'],
  order: ['ServiceRequest', 'MedicationRequest'],
  result: ['Observation'],
  medication: ['MedicationRequest', 'Medication'],
  staff: ['Practitioner', 'PractitionerRole'],
  equipment: ['Device'],
  insurance: ['Coverage', 'Claim'],
  'org-node': ['Organization'],
  'physical-object': ['Device'],
  'work-artifact': ['Task', 'CommunicationRequest'],
  intent: ['Task'],
  plan: ['CarePlan'],
  approval: ['Task', 'Provenance'],
  'cost-record': ['MeasureReport'],
  'operator-directive': ['CommunicationRequest'],
  'agent-run': ['Provenance'],
  presence: [],
  effect: [],
  condition: ['Condition'],
  allergy: ['AllergyIntolerance'],
  procedure: ['Procedure'],
  immunization: ['Immunization'],
  'diagnostic-report': ['DiagnosticReport'],
  'medication-admin': ['MedicationAdministration'],
  'questionnaire-response': ['QuestionnaireResponse'],
  'document-reference': ['DocumentReference'],
  communication: ['Communication'],
  appointment: ['Appointment'],
  schedule: ['Schedule'],
  slot: ['Slot'],
  'explanation-of-benefit': ['ExplanationOfBenefit'],
  invoice: ['Invoice'],
  account: ['Account'],
  'claim-response': ['ClaimResponse'],
  'care-team': ['CareTeam'],
  goal: ['Goal'],
  subscription: ['Subscription'],
  questionnaire: ['Questionnaire'],
  consent: ['Consent'],
  'adverse-event': ['AdverseEvent'],
  'medication-statement': ['MedicationStatement'],
  'medication-dispense': ['MedicationDispense'],
  'imaging-study': ['ImagingStudy'],
  specimen: ['Specimen'],
  'detected-issue': ['DetectedIssue'],
  'payment-reconciliation': ['PaymentReconciliation'],
  composition: ['Composition'],
  'vision-prescription': ['VisionPrescription'],
  'device-use': ['DeviceUseStatement'],
  'nutrition-order': ['NutritionOrder'],
  'supply-delivery': ['SupplyDelivery'],
  'healthcare-service': ['HealthcareService'],
  endpoint: ['Endpoint'],
  'org-affiliation': ['OrganizationAffiliation'],
  substance: ['Substance'],
};

function ev(type: CanonicalEventType, resource: FhirResource, ctx: FhirCtx, extra: { subjectId?: string; facilityId?: string } = {}): CanonicalEvent {
  const id = resource.id ? `event:fhir:${resource.resourceType}:${resource.id}` : `event:fhir:${ctx.sourceId}:${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    type,
    occurredAt: ctx.ingestedAt,
    scopeId: ctx.scopeId,
    subjectId: extra.subjectId ?? (resource as { subject?: { reference?: string } }).subject?.reference ?? 'unknown',
    facilityId: extra.facilityId ?? ctx.facilityId,
    payload: { fhir: resource },
    provenance: { sourceId: ctx.sourceId, observedAt: ctx.ingestedAt, ingestedAt: ctx.ingestedAt },
    classification: 'phi',
  };
}

function first<T>(arr: readonly T[] | undefined): T | undefined { return arr?.[0]; }
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function num(v: unknown): number | undefined { return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined; }

// ---------------------------------------------------------------- serializers

function serializePatient(rec: EntityRecord, ctx: FhirCtx): Patient {
  const st = rec.state as Record<string, unknown>;
  const name = st['name'] as string | undefined;
  const age = st['age'] as number | undefined;
  const birthDate = str(st['birthDate']);
  const gender = str(st['sex']) as Patient['gender'] | undefined;
  const patient: Patient = {
    resourceType: 'Patient',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    identifier: [{ system: CODE_SYSTEMS.mrn, value: rec.id, use: 'official' }],
    active: true,
    ...(gender ? { gender } : {}),
    ...(name ? { name: [{ family: name.split(' ').slice(1).join(' ') || name, given: [name.split(' ')[0] ?? ''] }] } : {}),
    ...(birthDate ? { birthDate } : age !== undefined ? { birthDate: `${new Date().getFullYear() - age}-01-01` } : {}),
    ...(st['address'] ? { address: [st['address'] as { line?: string[]; city?: string; state?: string; postalCode?: string }] } : {}),
  };
  return patient;
}

function serializeFacility(rec: EntityRecord, ctx: FhirCtx): Organization {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Organization',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    active: true,
    type: [concept('http://terminology.hl7.org/CodeSystem/organization-type', str(st['kind']) ?? 'prov', str(st['kind']))],
    name: str(st['name']) ?? rec.id,
    identifier: [{ system: CODE_SYSTEMS.npi, value: str(st['npi']) ?? rec.id, use: 'official' }],
  };
}

function serializeUnit(rec: EntityRecord, ctx: FhirCtx): Location {
  const st = rec.state as Record<string, unknown>;
  const facilityId = st['facilityId'] as string | undefined;
  return {
    resourceType: 'Location',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: 'active',
    mode: 'instance',
    physicalType: concept('http://terminology.hl7.org/CodeSystem/location-physical-type', 'wa', 'Ward'),
    name: str(st['code']) ?? rec.id,
    ...(facilityId ? { partOf: { reference: `Organization/${facilityId}` } } : {}),
  };
}

function serializeEncounter(rec: EntityRecord, ctx: FhirCtx): Encounter {
  const st = rec.state as Record<string, unknown>;
  const status = (str(st['status']) ?? 'in-progress') as Encounter['status'];
  const patientId = str(st['patientId']);
  return {
    resourceType: 'Encounter',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status,
    class: code('http://terminology.hl7.org/CodeSystem/v3-ActCode', str(st['classCode']) ?? 'AMB', 'ambulatory'),
    ...(patientId ? { subject: { reference: `Patient/${patientId}` } } : {}),
    period: {
      ...(str(st['startedAt']) ? { start: str(st['startedAt'])! } : {}),
      ...(str(st['endedAt']) ? { end: str(st['endedAt'])! } : {}),
    },
    ...(str(st['dispositionKind']) ? { hospitalization: { dischargeDisposition: concept('http://terminology.hl7.org/CodeSystem/discharge-disposition', str(st['dispositionKind'])!) } } : {}),
  };
}

function serializeOrder(rec: EntityRecord, ctx: FhirCtx): FhirResource[] {
  const st = rec.state as Record<string, unknown>;
  const patientId = str(st['patientId']);
  const encounterId = str(st['encounterId']);
  const subject = patientId ? { reference: `Patient/${patientId}` } : undefined;
  const enc = encounterId ? { reference: `Encounter/${encounterId}` } : undefined;
  const isMedication = rec.kind === 'medication' || str(st['kind']) === 'med';
  if (isMedication) {
    const mr: MedicationRequest = {
      resourceType: 'MedicationRequest',
      id: rec.id,
      meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
      status: (str(st['status']) ?? 'active') as MedicationRequest['status'],
      intent: 'order',
      medicationCodeableConcept: concept(CODE_SYSTEMS.rxnorm, str(st['code']) ?? 'unknown'),
      ...(subject ? { subject } : {}),
      ...(enc ? { encounter: enc } : {}),
      authoredOn: str(st['orderedAt']) ?? rec.createdAt,
      ...(str(st['dose']) ? { dosageInstruction: [{ text: `${str(st['dose'])} ${str(st['route']) ?? ''} ${str(st['frequency']) ?? ''}`.trim() }] } : {}),
    };
    return [mr];
  }
  const sr: ServiceRequest = {
    resourceType: 'ServiceRequest',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as ServiceRequest['status'],
    intent: 'order',
    code: concept(CODE_SYSTEMS.loinc, str(st['code']) ?? 'unknown'),
    ...(subject ? { subject } : {}),
    ...(enc ? { encounter: enc } : {}),
    authoredOn: str(st['orderedAt']) ?? rec.createdAt,
    priority: str(st['priority']) === 'stat' ? 'stat' : 'routine',
  };
  return [sr];
}

function serializeResult(rec: EntityRecord, ctx: FhirCtx): Observation {
  const st = rec.state as Record<string, unknown>;
  const patientId = str(st['patientId']);
  const interpretation = str(st['abnormal']) ? [concept('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', str(st['abnormal'])!)] : undefined;
  return {
    resourceType: 'Observation',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: 'final',
    category: [concept('http://terminology.hl7.org/CodeSystem/observation-category', 'laboratory', 'Laboratory')],
    code: concept(CODE_SYSTEMS.loinc, str(st['code']) ?? 'unknown'),
    ...(patientId ? { subject: { reference: `Patient/${patientId}` } } : {}),
    effectiveDateTime: str(st['at']) ?? rec.createdAt,
    issued: rec.updatedAt,
    valueQuantity: {
      ...(num(st['value']) !== undefined ? { value: num(st['value'])! } : {}),
      ...(str(st['unit']) ? { unit: str(st['unit'])! } : {}),
    },
    ...(interpretation ? { interpretation } : {}),
    ...(str(st['orderId']) ? { basedOn: [{ reference: `ServiceRequest/${str(st['orderId'])}` }] } : {}),
  };
}

function serializeStaff(rec: EntityRecord, ctx: FhirCtx): FhirResource[] {
  const st = rec.state as Record<string, unknown>;
  const practitioner: Practitioner = {
    resourceType: 'Practitioner',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    active: true,
    identifier: [{ system: CODE_SYSTEMS.npi, value: str(st['npi']) ?? rec.id, use: 'official' }],
    name: [{ family: str(st['name']) ?? rec.id }],
    ...(str(st['licenseNumber']) ? { qualification: [{ code: concept('http://terminology.hl7.org/CodeSystem/v2-0360', str(st['licenseNumber'])!, str(st['licenseState'])) }] } : {}),
  };
  const role: PractitionerRole = {
    resourceType: 'PractitionerRole',
    id: `${rec.id}-role`,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    practitioner: { reference: `Practitioner/${rec.id}` },
    active: true,
    code: [concept('http://terminology.hl7.org/CodeSystem/practitioner-role', str(st['role']) ?? 'unknown')],
  };
  return [practitioner, role];
}

function serializeEquipment(rec: EntityRecord, ctx: FhirCtx): Device {
  const st = rec.state as Record<string, unknown>;
  const assignedPatient = str(st['assignedPatientId']);
  return {
    resourceType: 'Device',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: str(st['state']) === 'down' ? 'inactive' : 'active',
    type: concept('http://terminology.hl7.org/CodeSystem/device-kind', str(st['kind']) ?? 'device'),
    serialNumber: str(st['serial']) ?? rec.id,
    ...(assignedPatient ? { patient: { reference: `Patient/${assignedPatient}` } } : {}),
  };
}

function serializeInsurance(rec: EntityRecord, ctx: FhirCtx): Coverage {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Coverage',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Coverage['status'],
    kind: 'group',
    identifier: [{ system: CODE_SYSTEMS.oid, value: str(st['policyNumber']) ?? rec.id, use: 'official' }],
    ...(str(st['patientId']) ? { beneficiary: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    payor: [{ reference: `Organization/${str(st['payerId']) ?? 'payer'}` }],
    period: {
      ...(str(st['effectiveStart']) ? { start: str(st['effectiveStart'])! } : {}),
      ...(str(st['effectiveEnd']) ? { end: str(st['effectiveEnd'])! } : {}),
    },
  };
}

function serializeOrgNode(rec: EntityRecord, ctx: FhirCtx): Organization {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Organization',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    active: true,
    type: [concept('http://terminology.hl7.org/CodeSystem/organization-type', str(st['nodeKind']) ?? 'dept', str(st['nodeKind']))],
    name: str(st['name']) ?? rec.id,
    ...(str(st['parentId']) ? { partOf: { reference: `Organization/${str(st['parentId'])}` } } : {}),
  };
}

function serializeWorkArtifact(rec: EntityRecord, ctx: FhirCtx): Task {
  const st = rec.state as Record<string, unknown>;
  const summary = str(st['summary']);
  return {
    resourceType: 'Task',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'requested') as Task['status'],
    intent: 'order',
    priority: str(st['priority']) === 'critical' ? 'stat' : str(st['priority']) === 'high' ? 'urgent' : 'routine',
    code: concept('http://terminology.hl7.org/CodeSystem/task-code', str(st['ticketKind']) ?? 'task'),
    ...(str(st['subjectRef']) ? { subject: { reference: str(st['subjectRef'])! } } : {}),
    ...(summary ? { description: summary } : {}),
    authoredOn: str(st['createdAt']) ?? rec.createdAt,
  };
}

function serializePlan(rec: EntityRecord, ctx: FhirCtx): CarePlan {
  const st = rec.state as Record<string, unknown>;
  const title = str(st['title']);
  return {
    resourceType: 'CarePlan',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as CarePlan['status'],
    intent: 'plan',
    ...(title ? { title } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    period: { start: rec.createdAt },
  };
}

function serializeMeasure(rec: EntityRecord, ctx: FhirCtx): Measure {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Measure',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Measure['status'],
    name: str(st['id'] ?? st['measureId']) ?? rec.id,
    title: str(st['title']) ?? str(st['name']) ?? rec.id,
    ...(str(st['version']) ? { version: str(st['version'])! } : {}),
    identifier: [{ system: CODE_SYSTEMS.oid, value: str(st['cmsId']) ?? rec.id, use: 'official' }],
    ...(str(st['description']) ? { description: str(st['description'])! } : {}),
    scoring: concept('http://terminology.hl7.org/CodeSystem/measure-scoring', str(st['scoring']) ?? 'proportion'),
  };
}

function serializeValueSet(rec: EntityRecord, ctx: FhirCtx): ValueSet {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'ValueSet',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as ValueSet['status'],
    name: str(st['name']) ?? rec.id,
    title: str(st['title']) ?? rec.id,
    identifier: [{ system: CODE_SYSTEMS.oid, value: str(st['oid']) ?? rec.id, use: 'official' }],
  };
}

function serializeCostRecord(rec: EntityRecord, ctx: FhirCtx): MeasureReport {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'MeasureReport',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: 'complete',
    type: 'summary',
    measure: str(st['measureId']) ?? 'measure:episode-cost',
    date: rec.createdAt,
    period: { start: str(st['periodStart']) ?? rec.createdAt, end: str(st['periodEnd']) ?? rec.updatedAt },
    group: [{
      code: concept('http://terminology.hl7.org/CodeSystem/measure-population', 'measure-population'),
      ...(num(st['qualityScore']) !== undefined ? { measureScore: { value: num(st['qualityScore'])! } } : {}),
    }],
  };
}

function serializeProvenance(rec: EntityRecord, ctx: FhirCtx): Provenance {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Provenance',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    target: [{ reference: `Provenance/${rec.id}` }],
    recorded: rec.createdAt,
    agent: [{ who: { reference: `Practitioner/${str(st['agentSpecId']) ?? 'system'}` }, ...(str(st['role']) ? { role: [concept('http://terminology.hl7.org/CodeSystem/contractsignertypecodes', str(st['role'])!)] } : {}) }],
  };
}

// ---------------------------------------------------------- M24 serializers
// Clinical-record, care-coordination and payer families. State shapes mirror the
// structuralState() extractors in canonical.ts so FHIR ingest round-trips.

function serializeCondition(rec: EntityRecord, ctx: FhirCtx): Condition {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'Condition',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    ...(code ? { code: concept(str(st['codeSystem']) ?? CODE_SYSTEMS.snomed, code, str(st['display']) ?? `SNOMED ${code}`) } : {}),
    ...(str(st['clinicalStatus']) ? { clinicalStatus: concept('http://terminology.hl7.org/CodeSystem/condition-clinical', str(st['clinicalStatus'])!) } : {}),
    ...(str(st['verificationStatus']) ? { verificationStatus: concept('http://terminology.hl7.org/CodeSystem/condition-ver-status', str(st['verificationStatus'])!) } : {}),
    ...(str(st['category']) ? { category: [concept('http://terminology.hl7.org/CodeSystem/condition-category', str(st['category'])!)] } : {}),
    ...(str(st['severity']) ? { severity: concept('http://terminology.hl7.org/CodeSystem/condition-severity', str(st['severity'])!) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['encounterId']) ? { encounter: { reference: `Encounter/${str(st['encounterId'])}` } } : {}),
    ...(str(st['onset']) ? { onsetDateTime: str(st['onset'])! } : {}),
    ...(str(st['abatement']) ? { abatementDateTime: str(st['abatement'])! } : {}),
    ...(str(st['recordedAt']) ? { recordedDate: str(st['recordedAt'])! } : { recordedDate: rec.createdAt }),
  };
}

function serializeAllergy(rec: EntityRecord, ctx: FhirCtx): AllergyIntolerance {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'AllergyIntolerance',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    ...(str(st['clinicalStatus']) ? { clinicalStatus: concept('http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', str(st['clinicalStatus'])!) } : {}),
    ...(str(st['verificationStatus']) ? { verificationStatus: concept('http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', str(st['verificationStatus'])!) } : {}),
    ...(str(st['type']) ? { type: str(st['type']) as 'allergy' } : {}),
    ...(Array.isArray(st['category']) && (st['category'] as unknown[]).length ? { category: st['category'] as Array<'food' | 'medication' | 'environment' | 'biologic'> } : {}),
    ...(str(st['criticality']) ? { criticality: str(st['criticality']) as 'low' } : {}),
    ...(code ? { code: concept(CODE_SYSTEMS.snomed, code, str(st['display']) ?? `SNOMED ${code}`) } : {}),
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['onset']) ? { onsetDateTime: str(st['onset'])! } : {}),
    ...(str(st['recordedAt']) ? { recordedDate: str(st['recordedAt'])! } : { recordedDate: rec.createdAt }),
  };
}

function serializeProcedure(rec: EntityRecord, ctx: FhirCtx): Procedure {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'Procedure',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as Procedure['status'],
    ...(code ? { code: concept(str(st['codeSystem']) ?? CODE_SYSTEMS.cpt, code, str(st['display']) ?? `CPT ${code}`) } : {}),
    ...(str(st['category']) ? { category: concept('http://terminology.hl7.org/CodeSystem/procedure-category', str(st['category'])!) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['encounterId']) ? { encounter: { reference: `Encounter/${str(st['encounterId'])}` } } : {}),
    ...(str(st['performedAt']) ? { performedDateTime: str(st['performedAt'])! } : { performedDateTime: rec.createdAt }),
    ...(str(st['outcome']) ? { outcome: concept('http://terminology.hl7.org/CodeSystem/procedure-outcome', str(st['outcome'])!) } : {}),
    ...(str(st['reasonCode']) ? { reasonCode: [concept(CODE_SYSTEMS.icd10, str(st['reasonCode'])!)] } : {}),
  };
}

function serializeImmunization(rec: EntityRecord, ctx: FhirCtx): Immunization {
  const st = rec.state as Record<string, unknown>;
  const vaccineCode = str(st['vaccineCode']);
  return {
    resourceType: 'Immunization',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as Immunization['status'],
    ...(vaccineCode ? { vaccineCode: concept(CODE_SYSTEMS.cvx, vaccineCode, str(st['display']) ?? `CVX ${vaccineCode}`) } : {}),
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['occurrence']) ? { occurrenceDateTime: str(st['occurrence'])! } : { occurrenceDateTime: rec.createdAt }),
    ...(str(st['lotNumber']) ? { lotNumber: str(st['lotNumber'])! } : {}),
    ...(str(st['site']) ? { site: concept('http://terminology.hl7.org/CodeSystem/v3-ActSite', str(st['site'])!) } : {}),
    ...(str(st['route']) ? { route: concept('http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration', str(st['route'])!) } : {}),
    ...(num(st['dose']) !== undefined ? { doseQuantity: { value: num(st['dose'])!, ...(str(st['unit']) ? { unit: str(st['unit'])! } : {}) } } : {}),
    ...(str(st['recorded']) ? { recorded: str(st['recorded'])! } : {}),
  };
}

function serializeDiagnosticReport(rec: EntityRecord, ctx: FhirCtx): DiagnosticReport {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  const resultIds = Array.isArray(st['resultIds']) ? st['resultIds'] as unknown[] : [];
  return {
    resourceType: 'DiagnosticReport',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'final') as DiagnosticReport['status'],
    ...(code ? { code: concept(str(st['codeSystem']) ?? CODE_SYSTEMS.loinc, code, str(st['display']) ?? `LOINC ${code}`) } : {}),
    ...(str(st['category']) ? { category: [concept('http://terminology.hl7.org/CodeSystem/diagnostic-service-sections', str(st['category'])!)] } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['encounterId']) ? { encounter: { reference: `Encounter/${str(st['encounterId'])}` } } : {}),
    ...(str(st['effectiveAt']) ? { effectiveDateTime: str(st['effectiveAt'])! } : { effectiveDateTime: rec.createdAt }),
    ...(str(st['issuedAt']) ? { issued: str(st['issuedAt'])! } : { issued: rec.updatedAt }),
    ...(resultIds.length ? { result: resultIds.map((r) => ({ reference: `Observation/${String(r)}` })) } : {}),
    ...(str(st['conclusion']) ? { conclusion: str(st['conclusion'])! } : {}),
  };
}

function serializeMedicationAdministration(rec: EntityRecord, ctx: FhirCtx): MedicationAdministration {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'MedicationAdministration',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as MedicationAdministration['status'],
    ...(code ? { medicationCodeableConcept: concept(CODE_SYSTEMS.rxnorm, code, str(st['display']) ?? `RxNorm ${code}`) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['contextId']) ? { context: { reference: `Encounter/${str(st['contextId'])}` } } : {}),
    ...(str(st['effectiveAt']) ? { effectiveDateTime: str(st['effectiveAt'])! } : { effectiveDateTime: rec.createdAt }),
    ...(str(st['requestId']) ? { request: { reference: `MedicationRequest/${str(st['requestId'])}` } } : {}),
    ...(str(st['route']) || num(st['dose']) !== undefined ? {
      dosage: {
        ...(str(st['route']) ? { route: concept('http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration', str(st['route'])!) } : {}),
        ...(num(st['dose']) !== undefined ? { dose: { value: num(st['dose'])!, ...(str(st['unit']) ? { unit: str(st['unit'])! } : {}) } } : {}),
      },
    } : {}),
  };
}

function serializeQuestionnaireResponse(rec: EntityRecord, ctx: FhirCtx): QuestionnaireResponse {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'QuestionnaireResponse',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as QuestionnaireResponse['status'],
    ...(str(st['questionnaire']) ? { questionnaire: str(st['questionnaire'])! } : {}),
    ...(str(st['subjectId']) ? { subject: { reference: `Patient/${str(st['subjectId'])}` } } : {}),
    ...(str(st['encounterId']) ? { encounter: { reference: `Encounter/${str(st['encounterId'])}` } } : {}),
    ...(str(st['authoredAt']) ? { authored: str(st['authoredAt'])! } : { authored: rec.createdAt }),
    ...(str(st['authorRef']) ? { author: { reference: str(st['authorRef'])! } } : {}),
    ...(Array.isArray(st['items']) && (st['items'] as unknown[]).length ? { item: st['items'] as Array<{ linkId?: string; text?: string; answer?: Array<{ valueString?: string; valueBoolean?: boolean; valueInteger?: number }> }> } : {}),
  };
}

function serializeDocumentReference(rec: EntityRecord, ctx: FhirCtx): DocumentReference {
  const st = rec.state as Record<string, unknown>;
  const url = str(st['url']);
  return {
    resourceType: 'DocumentReference',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'current') as DocumentReference['status'],
    ...(str(st['type']) ? { type: concept('http://loinc.org', str(st['type'])!, str(st['display'])) } : {}),
    ...(str(st['category']) ? { category: [concept('http://terminology.hl7.org/CodeSystem/document-classcodes', str(st['category'])!)] } : {}),
    ...(str(st['subjectId']) ? { subject: { reference: `Patient/${str(st['subjectId'])}` } } : {}),
    ...(str(st['date']) ? { date: str(st['date'])! } : { date: rec.createdAt }),
    ...(str(st['authorRef']) ? { author: [{ reference: str(st['authorRef'])! }] } : {}),
    ...(str(st['description']) ? { description: str(st['description'])! } : {}),
    content: [{
      attachment: {
        ...(str(st['contentType']) ? { contentType: str(st['contentType'])! } : {}),
        ...(url ? { url } : {}),
        ...(str(st['title']) ? { title: str(st['title'])! } : {}),
      },
    }],
  };
}

function serializeCommunication(rec: EntityRecord, ctx: FhirCtx): Communication {
  const st = rec.state as Record<string, unknown>;
  const payloadText = str(st['payloadText']);
  return {
    resourceType: 'Communication',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as Communication['status'],
    ...(str(st['category']) ? { category: [concept('http://terminology.hl7.org/CodeSystem/communication-category', str(st['category'])!)] } : {}),
    ...(str(st['priority']) ? { priority: str(st['priority']) as 'routine' } : {}),
    ...(str(st['subjectId']) ? { subject: { reference: `Patient/${str(st['subjectId'])}` } } : {}),
    ...(str(st['sentAt']) ? { sent: str(st['sentAt'])! } : {}),
    ...(str(st['receivedAt']) ? { received: str(st['receivedAt'])! } : {}),
    ...(str(st['recipientRef']) ? { recipient: [{ reference: str(st['recipientRef'])! }] } : {}),
    ...(str(st['senderRef']) ? { sender: { reference: str(st['senderRef'])! } } : {}),
    ...(payloadText ? { payload: [{ contentString: payloadText }] } : {}),
  };
}

function serializeAppointment(rec: EntityRecord, ctx: FhirCtx): Appointment {
  const st = rec.state as Record<string, unknown>;
  const start = str(st['start']);
  const end = str(st['end']);
  return {
    resourceType: 'Appointment',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'booked') as Appointment['status'],
    ...(str(st['serviceType']) ? { serviceType: [concept('http://terminology.hl7.org/CodeSystem/service-type', str(st['serviceType'])!)] } : {}),
    ...(str(st['reasonCode']) ? { reasonCode: [concept(CODE_SYSTEMS.icd10, str(st['reasonCode'])!)] } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(num(st['minutesDuration']) !== undefined ? { minutesDuration: num(st['minutesDuration'])! } : {}),
    ...(str(st['description']) ? { description: str(st['description'])! } : {}),
    ...(str(st['created']) ? { created: str(st['created'])! } : { created: rec.createdAt }),
    participant: [{
      ...(str(st['patientId']) ? { actor: { reference: `Patient/${str(st['patientId'])}` } } : {}),
      status: 'accepted',
    }],
  };
}

function serializeSchedule(rec: EntityRecord, ctx: FhirCtx): Schedule {
  const st = rec.state as Record<string, unknown>;
  const actorRef = str(st['actorRef']);
  return {
    resourceType: 'Schedule',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    active: st['active'] !== false,
    ...(str(st['serviceType']) ? { serviceType: [concept('http://terminology.hl7.org/CodeSystem/service-type', str(st['serviceType'])!)] } : {}),
    ...(str(st['specialty']) ? { specialty: [concept('http://terminology.hl7.org/CodeSystem/practitioner-specialty', str(st['specialty'])!)] } : {}),
    actor: actorRef ? [{ reference: actorRef }] : [],
    ...(str(st['horizonStart']) || str(st['horizonEnd']) ? { planningHorizon: { ...(str(st['horizonStart']) ? { start: str(st['horizonStart'])! } : {}), ...(str(st['horizonEnd']) ? { end: str(st['horizonEnd'])! } : {}) } } : {}),
  };
}

function serializeSlot(rec: EntityRecord, ctx: FhirCtx): Slot {
  const st = rec.state as Record<string, unknown>;
  const scheduleId = str(st['scheduleId']);
  const start = str(st['start']);
  const end = str(st['end']);
  return {
    resourceType: 'Slot',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'free') as Slot['status'],
    ...(str(st['serviceType']) ? { serviceType: [concept('http://terminology.hl7.org/CodeSystem/service-type', str(st['serviceType'])!)] } : {}),
    schedule: { reference: scheduleId ? `Schedule/${scheduleId}` : `Schedule/${rec.id}` },
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(st['overbooked'] === true ? { overbooked: true } : {}),
  };
}

function serializeExplanationOfBenefit(rec: EntityRecord, ctx: FhirCtx): ExplanationOfBenefit {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'ExplanationOfBenefit',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as ExplanationOfBenefit['status'],
    use: (str(st['use']) ?? 'claim') as ExplanationOfBenefit['use'],
    ...(str(st['type']) ? { type: concept('http://terminology.hl7.org/CodeSystem/claim-type', str(st['type'])!) } : {}),
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['insurerId']) ? { insurer: { reference: `Organization/${str(st['insurerId'])}` } } : {}),
    ...(str(st['providerId']) ? { provider: { reference: `Organization/${str(st['providerId'])}` } } : {}),
    ...(str(st['created']) ? { created: str(st['created'])! } : { created: rec.createdAt }),
    ...(str(st['outcome']) ? { outcome: str(st['outcome']) as 'complete' } : {}),
    ...(str(st['disposition']) ? { disposition: str(st['disposition'])! } : {}),
    ...(num(st['totalAmount']) !== undefined ? { total: [{ category: concept('http://terminology.hl7.org/CodeSystem/adjudication', 'total'), amount: { value: num(st['totalAmount'])!, currency: str(st['currency']) ?? 'USD' } }] } : {}),
    ...(num(st['paymentAmount']) !== undefined ? { payment: { amount: { value: num(st['paymentAmount'])!, currency: str(st['currency']) ?? 'USD' }, date: str(st['created']) ?? rec.createdAt } } : {}),
  };
}

function serializeInvoice(rec: EntityRecord, ctx: FhirCtx): Invoice {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Invoice',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'issued') as Invoice['status'],
    ...(str(st['type']) ? { type: concept('http://terminology.hl7.org/CodeSystem/invoice-type', str(st['type'])!) } : {}),
    ...(str(st['subjectId']) ? { subject: { reference: `Patient/${str(st['subjectId'])}` } } : {}),
    ...(str(st['recipientRef']) ? { recipient: { reference: str(st['recipientRef'])! } } : {}),
    ...(str(st['date']) ? { date: str(st['date'])! } : { date: rec.createdAt }),
    ...(str(st['issuerRef']) ? { issuer: { reference: str(st['issuerRef'])! } } : {}),
    ...(num(st['totalNet']) !== undefined ? { totalNet: { value: num(st['totalNet'])!, currency: str(st['currency']) ?? 'USD' } } : {}),
    ...(num(st['totalGross']) !== undefined ? { totalGross: { value: num(st['totalGross'])!, currency: str(st['currency']) ?? 'USD' } } : {}),
  };
}

function serializeAccount(rec: EntityRecord, ctx: FhirCtx): Account {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Account',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Account['status'],
    ...(str(st['type']) ? { type: concept('http://terminology.hl7.org/CodeSystem/account-type', str(st['type'])!) } : {}),
    ...(str(st['name']) ? { name: str(st['name'])! } : {}),
    ...(str(st['subjectRef']) ? { subject: [{ reference: str(st['subjectRef'])! }] } : {}),
    ...(str(st['ownerRef']) ? { owner: { reference: str(st['ownerRef'])! } } : {}),
    ...(str(st['description']) ? { description: str(st['description'])! } : {}),
    ...(str(st['periodStart']) || str(st['periodEnd']) ? { period: { ...(str(st['periodStart']) ? { start: str(st['periodStart'])! } : {}), ...(str(st['periodEnd']) ? { end: str(st['periodEnd'])! } : {}) } } : {}),
  };
}

// ---------------------------------------------------------- C-batch serializers
// Payer remittance, care-team, goals, subscription infra, forms, consent.

function serializeClaimResponse(rec: EntityRecord, ctx: FhirCtx): ClaimResponse {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'ClaimResponse',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as ClaimResponse['status'],
    use: (str(st['use']) ?? 'claim') as ClaimResponse['use'],
    ...(str(st['type']) ? { type: concept('http://terminology.hl7.org/CodeSystem/claim-type', str(st['type'])!) } : {}),
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['created']) ? { created: str(st['created'])! } : { created: rec.createdAt }),
    ...(str(st['insurerId']) ? { insurer: { reference: `Organization/${str(st['insurerId'])}` } } : {}),
    ...(str(st['outcome']) ? { outcome: str(st['outcome']) as 'complete' } : {}),
    ...(str(st['disposition']) ? { disposition: str(st['disposition'])! } : {}),
    ...(num(st['totalAmount']) !== undefined ? { total: [{ category: concept('http://terminology.hl7.org/CodeSystem/adjudication', 'total'), amount: { value: num(st['totalAmount'])!, currency: str(st['currency']) ?? 'USD' } }] } : {}),
    ...(num(st['paymentAmount']) !== undefined ? { payment: { amount: { value: num(st['paymentAmount'])!, currency: str(st['currency']) ?? 'USD' }, date: str(st['created']) ?? rec.createdAt } } : {}),
  };
}

function serializeCareTeam(rec: EntityRecord, ctx: FhirCtx): CareTeam {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'CareTeam',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as CareTeam['status'],
    ...(str(st['name']) ? { name: str(st['name'])! } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['encounterId']) ? { encounter: { reference: `Encounter/${str(st['encounterId'])}` } } : {}),
    ...(str(st['memberRef']) ? { participant: [{ member: { reference: str(st['memberRef'])! } }] } : {}),
  };
}

function serializeGoal(rec: EntityRecord, ctx: FhirCtx): Goal {
  const st = rec.state as Record<string, unknown>;
  const desc = str(st['description']);
  return {
    resourceType: 'Goal',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    lifecycleStatus: (str(st['lifecycleStatus']) ?? 'active') as Goal['lifecycleStatus'],
    description: concept('http://terminology.hl7.org/CodeSystem/goal-description', str(st['code']) ?? 'goal', desc),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['startDate']) ? { startDate: str(st['startDate'])! } : { startDate: rec.createdAt.slice(0, 10) }),
    ...(num(st['targetValue']) !== undefined ? { target: [{ ...(str(st['measureCode']) ? { measure: concept(CODE_SYSTEMS.loinc, str(st['measureCode'])!) } : {}), detailQuantity: { value: num(st['targetValue'])!, ...(str(st['targetUnit']) ? { unit: str(st['targetUnit'])! } : {}) } }] } : {}),
  };
}

function serializeSubscription(rec: EntityRecord, ctx: FhirCtx): Subscription {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Subscription',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Subscription['status'],
    reason: str(st['reason']) ?? `Subscription ${rec.id}`,
    criteria: str(st['criteria']) ?? 'Observation?category=laboratory',
    ...(str(st['end']) ? { end: str(st['end'])! } : {}),
    channel: {
      type: (str(st['channelType']) ?? 'rest-hook') as 'rest-hook',
      ...(str(st['endpoint']) ? { endpoint: str(st['endpoint'])! } : {}),
      ...(str(st['payload']) ? { payload: str(st['payload'])! } : {}),
    },
  };
}

function serializeQuestionnaire(rec: EntityRecord, ctx: FhirCtx): Questionnaire {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Questionnaire',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Questionnaire['status'],
    ...(str(st['title']) ? { title: str(st['title'])! } : {}),
    ...(str(st['name']) ? { name: str(st['name'])! } : {}),
    ...(str(st['url']) ? { url: str(st['url'])! } : {}),
    ...(str(st['version']) ? { version: str(st['version'])! } : {}),
    ...(Array.isArray(st['items']) && (st['items'] as unknown[]).length ? { item: st['items'] as NonNullable<Questionnaire['item']> } : {}),
  };
}

function serializeConsent(rec: EntityRecord, ctx: FhirCtx): Consent {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Consent',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Consent['status'],
    scope: concept('http://terminology.hl7.org/CodeSystem/consentscope', str(st['scope']) ?? 'patient-privacy'),
    category: [concept('http://terminology.hl7.org/CodeSystem/consentcategorycodes', str(st['category']) ?? 'research')],
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['dateTime']) ? { dateTime: str(st['dateTime'])! } : { dateTime: rec.createdAt }),
    ...(str(st['provisionType']) ? { provision: { type: str(st['provisionType']) as 'permit' } } : {}),
  };
}

// ---------------------------------------------------------- D-batch serializers
// Adverse events, medication statement/dispense, imaging, specimens, detected
// issues, payment reconciliation, documents.

function serializeAdverseEvent(rec: EntityRecord, ctx: FhirCtx): AdverseEvent {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'AdverseEvent',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'available') as AdverseEvent['status'],
    actuality: (str(st['actuality']) ?? 'actual') as 'actual',
    ...(code ? { event: concept('http://terminology.hl7.org/CodeSystem/adverse-event-causality', code, str(st['display'])) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['date']) ? { date: str(st['date'])! } : { date: rec.createdAt }),
    ...(str(st['seriousness']) ? { seriousness: concept('http://terminology.hl7.org/CodeSystem/adverse-event-seriousness', str(st['seriousness'])!) } : {}),
  };
}

function serializeMedicationStatement(rec: EntityRecord, ctx: FhirCtx): MedicationStatement {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'MedicationStatement',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as MedicationStatement['status'],
    ...(code ? { medicationCodeableConcept: concept(CODE_SYSTEMS.rxnorm, code, str(st['display'])) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['effectiveAt']) ? { effectiveDateTime: str(st['effectiveAt'])! } : { effectiveDateTime: rec.createdAt }),
  };
}

function serializeMedicationDispense(rec: EntityRecord, ctx: FhirCtx): MedicationDispense {
  const st = rec.state as Record<string, unknown>;
  const code = str(st['code']);
  return {
    resourceType: 'MedicationDispense',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as MedicationDispense['status'],
    ...(code ? { medicationCodeableConcept: concept(CODE_SYSTEMS.rxnorm, code, str(st['display'])) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(num(st['quantity']) !== undefined ? { quantity: { value: num(st['quantity'])!, ...(str(st['unit']) ? { unit: str(st['unit'])! } : {}) } } : {}),
    ...(str(st['whenPrepared']) ? { whenPrepared: str(st['whenPrepared'])! } : {}),
    ...(str(st['whenHandedOver']) ? { whenHandedOver: str(st['whenHandedOver'])! } : {}),
    ...(str(st['requestId']) ? { authorizingPrescription: [{ reference: `MedicationRequest/${str(st['requestId'])}` }] } : {}),
  };
}

function serializeImagingStudy(rec: EntityRecord, ctx: FhirCtx): ImagingStudy {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'ImagingStudy',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'completed') as ImagingStudy['status'],
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['started']) ? { started: str(st['started'])! } : { started: rec.createdAt }),
    ...(str(st['modality']) ? { series: [{ uid: `urn:study:${rec.id}`, modality: code('http://dicom.nema.org/resources/ontology/DCM', str(st['modality'])!) }] } : {}),
  };
}

function serializeSpecimen(rec: EntityRecord, ctx: FhirCtx): Specimen {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Specimen',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'available') as Specimen['status'],
    ...(str(st['type']) ? { type: concept('http://terminology.hl7.org/CodeSystem/v2-0487', str(st['type'])!) } : {}),
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['collectedAt']) ? { collectedDateTime: str(st['collectedAt'])! } : {}),
    ...(str(st['receivedAt']) ? { receivedTime: str(st['receivedAt'])! } : {}),
  };
}

function serializeDetectedIssue(rec: EntityRecord, ctx: FhirCtx): DetectedIssue {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'DetectedIssue',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'final') as DetectedIssue['status'],
    ...(str(st['code']) ? { code: concept('http://terminology.hl7.org/CodeSystem/detectedissue-code', str(st['code'])!) } : {}),
    ...(str(st['severity']) ? { severity: str(st['severity']) as 'high' } : {}),
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['identifiedAt']) ? { identifiedDateTime: str(st['identifiedAt'])! } : { identifiedDateTime: rec.createdAt }),
    ...(str(st['detail']) ? { detail: str(st['detail'])! } : {}),
  };
}

function serializePaymentReconciliation(rec: EntityRecord, ctx: FhirCtx): PaymentReconciliation {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'PaymentReconciliation',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as PaymentReconciliation['status'],
    ...(str(st['created']) ? { created: str(st['created'])! } : { created: rec.createdAt }),
    ...(str(st['disposition']) ? { disposition: str(st['disposition'])! } : {}),
    ...(num(st['paymentAmount']) !== undefined ? { paymentAmount: { value: num(st['paymentAmount'])!, currency: str(st['currency']) ?? 'USD' } } : {}),
    ...(str(st['paymentDate']) ? { paymentDate: str(st['paymentDate'])! } : {}),
  };
}

function serializeComposition(rec: EntityRecord, ctx: FhirCtx): Composition {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Composition',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'final') as Composition['status'],
    type: concept('http://loinc.org', str(st['type']) ?? '34133-9', 'Summary'),
    date: str(st['date']) ?? rec.createdAt,
    title: str(st['title']) ?? rec.id,
    author: [{ reference: str(st['authorRef']) ?? 'Practitioner/system' }],
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['sectionTitle']) ? { section: [{ title: str(st['sectionTitle'])!, ...(str(st['sectionText']) ? { text: { status: 'generated', div: str(st['sectionText'])! } } : {}) }] } : {}),
  };
}

// ------------------------------------------------------ D4-batch serializers
// Vision prescriptions, device use, nutrition orders, supply delivery, service
// catalog entries, endpoints, org affiliations, substances.

function serializeVisionPrescription(rec: EntityRecord, ctx: FhirCtx): VisionPrescription {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'VisionPrescription',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as VisionPrescription['status'],
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['created']) ? { created: str(st['created'])! } : { created: rec.createdAt }),
    ...(str(st['dateWritten']) ? { dateWritten: str(st['dateWritten'])! } : { dateWritten: rec.createdAt }),
    ...(str(st['prescriberRef']) ? { prescriber: { reference: str(st['prescriberRef'])! } } : {}),
    ...(str(st['product']) ? { lensSpecification: [{ product: concept('http://terminology.hl7.org/CodeSystem/v3-EntityCode', str(st['product'])!) }] } : {}),
  };
}

function serializeDeviceUseStatement(rec: EntityRecord, ctx: FhirCtx): DeviceUseStatement {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'DeviceUseStatement',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as DeviceUseStatement['status'],
    ...(str(st['patientId']) ? { subject: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['deviceId']) ? { device: { reference: `Device/${str(st['deviceId'])}` } } : {}),
    ...(str(st['recordedOn']) ? { recordedOn: str(st['recordedOn'])! } : { recordedOn: rec.createdAt }),
    ...(str(st['code']) ? { reasonCode: [concept(CODE_SYSTEMS.snomed, str(st['code'])!)] } : {}),
  };
}

function serializeNutritionOrder(rec: EntityRecord, ctx: FhirCtx): NutritionOrder {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'NutritionOrder',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as NutritionOrder['status'],
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['dateTime']) ? { dateTime: str(st['dateTime'])! } : { dateTime: rec.createdAt }),
    ...(str(st['ordererRef']) ? { orderer: { reference: str(st['ordererRef'])! } } : {}),
    ...(str(st['dietType']) ? { oralDiet: { type: [concept('http://terminology.hl7.org/CodeSystem/diet-type', str(st['dietType'])!)] } } : {}),
  };
}

function serializeSupplyDelivery(rec: EntityRecord, ctx: FhirCtx): SupplyDelivery {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'SupplyDelivery',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    ...(str(st['status']) ? { status: str(st['status']) as NonNullable<SupplyDelivery['status']> } : {}),
    ...(str(st['patientId']) ? { patient: { reference: `Patient/${str(st['patientId'])}` } } : {}),
    ...(str(st['type']) ? { type: concept('http://terminology.hl7.org/CodeSystem/supplydelivery-type', str(st['type'])!) } : {}),
    ...(num(st['quantity']) !== undefined ? { quantity: { value: num(st['quantity'])!, ...(str(st['unit']) ? { unit: str(st['unit'])! } : {}) } } : {}),
    ...(str(st['code']) ? { suppliedItem: { itemCodeableConcept: concept(CODE_SYSTEMS.snomed, str(st['code'])!) } } : {}),
    ...(str(st['occurrence']) ? { occurrenceDateTime: str(st['occurrence'])! } : { occurrenceDateTime: rec.createdAt }),
  };
}

function serializeHealthcareService(rec: EntityRecord, ctx: FhirCtx): HealthcareService {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'HealthcareService',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    ...(st['active'] === false || st['active'] === true ? { active: st['active'] as boolean } : { active: true }),
    ...(str(st['orgId']) ? { providedBy: { reference: `Organization/${str(st['orgId'])}` } } : {}),
    ...(str(st['category']) ? { category: [concept('http://terminology.hl7.org/CodeSystem/service-category', str(st['category'])!)] } : {}),
    ...(str(st['name']) ? { name: str(st['name'])! } : {}),
    ...(str(st['facilityId']) ? { location: [{ reference: `Location/${str(st['facilityId'])}` }] } : {}),
    ...(str(st['endpointId']) ? { endpoint: [{ reference: `Endpoint/${str(st['endpointId'])}` }] } : {}),
  };
}

function serializeEndpoint(rec: EntityRecord, ctx: FhirCtx): Endpoint {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Endpoint',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    status: (str(st['status']) ?? 'active') as Endpoint['status'],
    ...(str(st['connectionType']) ? { connectionType: code('http://terminology.hl7.org/CodeSystem/endpoint-connection-type', str(st['connectionType'])!) } : {}),
    ...(str(st['name']) ? { name: str(st['name'])! } : {}),
    ...(str(st['address']) ? { address: str(st['address'])! } : {}),
    ...(str(st['payloadType']) ? { payloadType: [concept('http://terminology.hl7.org/CodeSystem/endpoint-payload-type', str(st['payloadType'])!)] } : {}),
  };
}

function serializeOrganizationAffiliation(rec: EntityRecord, ctx: FhirCtx): OrganizationAffiliation {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'OrganizationAffiliation',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    ...(st['active'] === false || st['active'] === true ? { active: st['active'] as boolean } : {}),
    ...(str(st['orgId']) ? { organization: { reference: `Organization/${str(st['orgId'])}` } } : {}),
    ...(str(st['participantOrgId']) ? { participatingOrganization: { reference: `Organization/${str(st['participantOrgId'])}` } } : {}),
    ...(str(st['code']) ? { code: [concept('http://hl7.org/fhir/organization-role', str(st['code'])!)] } : {}),
    ...(str(st['specialty']) ? { specialty: [concept(CODE_SYSTEMS.snomed, str(st['specialty'])!)] } : {}),
    ...(str(st['serviceId']) ? { healthcareService: [{ reference: `HealthcareService/${str(st['serviceId'])}` }] } : {}),
  };
}

function serializeSubstance(rec: EntityRecord, ctx: FhirCtx): Substance {
  const st = rec.state as Record<string, unknown>;
  return {
    resourceType: 'Substance',
    id: rec.id,
    meta: { source: ctx.sourceId, lastUpdated: rec.updatedAt },
    ...(str(st['status']) ? { status: str(st['status']) as NonNullable<Substance['status']> } : {}),
    code: concept(CODE_SYSTEMS.snomed, str(st['code']) ?? 'UNKNOWN'),
    ...(str(st['description']) ? { description: str(st['description'])! } : {}),
  };
}

// ---------------------------------------------------------------- hydrators
// The consume path maps a resource to canonical events the realm understands.
// Structured resources (Patient/Org/Location/Practitioner/…) produce a
// `fhir.resource-ingested` carrier whose payload carries the resource + kind;
// the ingest bridge (canonical.ts) applies structural upserts + effect-able
// resources through WorldEffects.

function hydrateCarrier(resource: FhirResource, ctx: FhirCtx): CanonicalEvent[] {
  const kind = RESOURCE_TO_KIND[resource.resourceType];
  return [{
    id: `event:fhir:${resource.resourceType}:${resource.id ?? 'anon'}`,
    type: 'fhir.resource-ingested',
    occurredAt: ctx.ingestedAt,
    scopeId: ctx.scopeId,
    subjectId: (resource as { subject?: { reference?: string } }).subject?.reference ?? resource.id ?? 'unknown',
    facilityId: ctx.facilityId,
    payload: { fhir: resource, kind },
    provenance: { sourceId: ctx.sourceId, observedAt: ctx.ingestedAt, ingestedAt: ctx.ingestedAt },
    classification: 'phi',
  }];
}

// ---------------------------------------------------------------- registry

export const ENTITY_FHIR: Partial<Record<EntityKind, EntityFhirMapping>> = {
  patient: { resourceTypes: ['Patient'], hydrate: (r, c) => hydrateCarrier(r, c), serialize: (rec, c) => [serializePatient(rec, c)] },
  facility: { resourceTypes: ['Organization'], hydrate: (r, c) => hydrateCarrier(r, c), serialize: (rec, c) => [serializeFacility(rec, c)] },
  unit: { resourceTypes: ['Location'], hydrate: (r, c) => hydrateCarrier(r, c), serialize: (rec, c) => [serializeUnit(rec, c)] },
  encounter: { resourceTypes: ['Encounter'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeEncounter(rec, c)] },
  order: { resourceTypes: ['ServiceRequest', 'MedicationRequest'], hydrate: hydrateCarrier, serialize: serializeOrder },
  result: { resourceTypes: ['Observation'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeResult(rec, c)] },
  medication: { resourceTypes: ['MedicationRequest', 'Medication'], hydrate: hydrateCarrier, serialize: (rec, c) => serializeOrder(rec, c) },
  staff: { resourceTypes: ['Practitioner', 'PractitionerRole'], hydrate: hydrateCarrier, serialize: serializeStaff },
  equipment: { resourceTypes: ['Device'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeEquipment(rec, c)] },
  insurance: { resourceTypes: ['Coverage', 'Claim'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeInsurance(rec, c)] },
  'org-node': { resourceTypes: ['Organization'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeOrgNode(rec, c)] },
  'work-artifact': { resourceTypes: ['Task', 'CommunicationRequest'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeWorkArtifact(rec, c)] },
  plan: { resourceTypes: ['CarePlan'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializePlan(rec, c)] },
  'cost-record': { resourceTypes: ['MeasureReport'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeCostRecord(rec, c)] },
  'agent-run': { resourceTypes: ['Provenance'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeProvenance(rec, c)] },
  condition: { resourceTypes: ['Condition'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeCondition(rec, c)] },
  allergy: { resourceTypes: ['AllergyIntolerance'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeAllergy(rec, c)] },
  procedure: { resourceTypes: ['Procedure'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeProcedure(rec, c)] },
  immunization: { resourceTypes: ['Immunization'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeImmunization(rec, c)] },
  'diagnostic-report': { resourceTypes: ['DiagnosticReport'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeDiagnosticReport(rec, c)] },
  'medication-admin': { resourceTypes: ['MedicationAdministration'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeMedicationAdministration(rec, c)] },
  'questionnaire-response': { resourceTypes: ['QuestionnaireResponse'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeQuestionnaireResponse(rec, c)] },
  'document-reference': { resourceTypes: ['DocumentReference'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeDocumentReference(rec, c)] },
  communication: { resourceTypes: ['Communication'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeCommunication(rec, c)] },
  appointment: { resourceTypes: ['Appointment'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeAppointment(rec, c)] },
  schedule: { resourceTypes: ['Schedule'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeSchedule(rec, c)] },
  slot: { resourceTypes: ['Slot'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeSlot(rec, c)] },
  'explanation-of-benefit': { resourceTypes: ['ExplanationOfBenefit'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeExplanationOfBenefit(rec, c)] },
  invoice: { resourceTypes: ['Invoice'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeInvoice(rec, c)] },
  account: { resourceTypes: ['Account'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeAccount(rec, c)] },
  'claim-response': { resourceTypes: ['ClaimResponse'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeClaimResponse(rec, c)] },
  'care-team': { resourceTypes: ['CareTeam'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeCareTeam(rec, c)] },
  goal: { resourceTypes: ['Goal'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeGoal(rec, c)] },
  subscription: { resourceTypes: ['Subscription'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeSubscription(rec, c)] },
  questionnaire: { resourceTypes: ['Questionnaire'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeQuestionnaire(rec, c)] },
  consent: { resourceTypes: ['Consent'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeConsent(rec, c)] },
  'adverse-event': { resourceTypes: ['AdverseEvent'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeAdverseEvent(rec, c)] },
  'medication-statement': { resourceTypes: ['MedicationStatement'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeMedicationStatement(rec, c)] },
  'medication-dispense': { resourceTypes: ['MedicationDispense'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeMedicationDispense(rec, c)] },
  'imaging-study': { resourceTypes: ['ImagingStudy'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeImagingStudy(rec, c)] },
  specimen: { resourceTypes: ['Specimen'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeSpecimen(rec, c)] },
  'detected-issue': { resourceTypes: ['DetectedIssue'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeDetectedIssue(rec, c)] },
  'payment-reconciliation': { resourceTypes: ['PaymentReconciliation'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializePaymentReconciliation(rec, c)] },
  composition: { resourceTypes: ['Composition'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeComposition(rec, c)] },
  'vision-prescription': { resourceTypes: ['VisionPrescription'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeVisionPrescription(rec, c)] },
  'device-use': { resourceTypes: ['DeviceUseStatement'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeDeviceUseStatement(rec, c)] },
  'nutrition-order': { resourceTypes: ['NutritionOrder'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeNutritionOrder(rec, c)] },
  'supply-delivery': { resourceTypes: ['SupplyDelivery'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeSupplyDelivery(rec, c)] },
  'healthcare-service': { resourceTypes: ['HealthcareService'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeHealthcareService(rec, c)] },
  endpoint: { resourceTypes: ['Endpoint'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeEndpoint(rec, c)] },
  'org-affiliation': { resourceTypes: ['OrganizationAffiliation'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeOrganizationAffiliation(rec, c)] },
  substance: { resourceTypes: ['Substance'], hydrate: hydrateCarrier, serialize: (rec, c) => [serializeSubstance(rec, c)] },
};

/** Dispatch a whole FHIR Bundle → canonical events (extends mapFhirBundle from 2 → all types). */
export function hydrateBundle(bundle: { entry?: ReadonlyArray<{ resource?: FhirResource }> }, ctx: FhirCtx): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource;
    if (!r) continue;
    const mapping = ENTITY_FHIR[RESOURCE_TO_KIND[r.resourceType] as EntityKind] ?? ENTITY_FHIR[RESOURCE_TO_KIND[r.resourceType] as EntityKind];
    if (mapping) events.push(...mapping.hydrate(r, ctx));
  }
  return events;
}

/** Serialize an EntityRecord → FHIR resource(s) (empty for kinds with no wire equivalent). */
export function serializeEntity(rec: EntityRecord, ctx: FhirCtx): FhirResource[] {
  const mapping = ENTITY_FHIR[rec.kind];
  if (!mapping) return [];
  return mapping.serialize(rec, ctx);
}

/** Resolve a FHIR resourceType to the entity kind it maps to. */
export function entityKindFromResource(resourceType: string): EntityKind | undefined {
  return RESOURCE_TO_KIND[resourceType];
}

/** The resourceTypes a kind produces (for admin + export metadata). */
export function resourceTypesForKind(kind: EntityKind): string[] {
  return KIND_TO_RESOURCES[kind] ?? [];
}
