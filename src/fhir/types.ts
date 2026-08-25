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

// FHIR R4 typed subset — the resources the harness consumes and produces (Phase 2).
//
// Dependency-light hand-rolled model (no @types/fhir): covers every resource the
// entity registry maps to plus the R4 clinical/care-coordination/payer families —
// 40 typed resourceTypes total (see TYPED_FHIR_RESOURCES). Extend per entity as
// needed.

export type FhirPrimitive = string | number | boolean | null | undefined;

// ---- common datatypes ----
export interface Coding {
  system?: string;
  version?: string;
  code?: string;
  display?: string;
  userSelected?: boolean;
}
export interface CodeableConcept { coding?: Coding[]; text?: string; }
export interface Identifier {
  use?: 'usual' | 'official' | 'temp' | 'secondary' | 'old';
  type?: CodeableConcept;
  system?: string;
  value?: string;
  period?: Period;
  assigner?: Reference;
}
export interface Reference {
  reference?: string;      // 'Patient/123', 'urn:uuid:...', '#frag'
  type?: string;
  identifier?: Identifier;
  display?: string;
}
export interface Period { start?: string; end?: string; }
export interface Quantity {
  value?: number;
  comparator?: '<' | '<=' | '>=' | '>' | 'ad';
  unit?: string;
  system?: string;
  code?: string;
}
export interface Range { low?: Quantity; high?: Quantity; }
export interface HumanName {
  use?: 'usual' | 'official' | 'temp' | 'nickname' | 'maiden' | 'old' | 'anonymous';
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
  text?: string;
}
export interface ContactPoint { system?: 'phone' | 'fax' | 'email' | 'pager' | 'url' | 'sms' | 'other'; value?: string; use?: 'home' | 'work' | 'temp' | 'old' | 'mobile'; }
export interface Address { use?: 'home' | 'work' | 'temp' | 'old' | 'billing'; line?: string[]; city?: string; state?: string; postalCode?: string; country?: string; text?: string; }
export interface Meta {
  versionId?: string;
  lastUpdated?: string;
  source?: string;
  profile?: string[];
  security?: Coding[];
  tag?: Coding[];
}
export interface Annotation { authorReference?: Reference; authorString?: string; time?: string; text: string; }
export interface Dosage {
  sequence?: number;
  text?: string;
  timing?: { repeat?: { frequency?: number; period?: number; periodUnit?: string; when?: string[]; boundsPeriod?: Period }; code?: CodeableConcept };
  route?: CodeableConcept;
  doseAndRate?: Array<{ doseQuantity?: Quantity }>;
}
export interface Attachment { contentType?: string; url?: string; title?: string; creation?: string; data?: string; }
export interface Money { value?: number; currency?: string; }
export interface Narrative { status: string; div: string; }

// ---- resources ----
export interface DomainResource {
  resourceType: string;
  id?: string;
  meta?: Meta;
  implicitRules?: string;
  language?: string;
  text?: Narrative;
  contained?: FhirResource[];
  extension?: Array<{ url: string; valueString?: string; valueCode?: string; valueReference?: Reference; valueBoolean?: boolean; valueDateTime?: string; valueInteger?: number; valueCodeableConcept?: CodeableConcept }>;
  modifierExtension?: unknown[];
}

export interface Patient extends DomainResource {
  resourceType: 'Patient';
  identifier?: Identifier[];
  active?: boolean;
  name?: HumanName[];
  telecom?: ContactPoint[];
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  deceasedBoolean?: boolean;
  deceasedDateTime?: string;
  address?: Address[];
  maritalStatus?: CodeableConcept;
  managingOrganization?: Reference;
  generalPractitioner?: Reference[];
}

export interface Encounter extends DomainResource {
  resourceType: 'Encounter';
  identifier?: Identifier[];
  status: 'planned' | 'arrived' | 'triaged' | 'in-progress' | 'onleave' | 'finished' | 'cancelled' | 'entered-in-error' | 'unknown';
  class?: Coding;
  type?: CodeableConcept[];
  subject?: Reference;
  episodeOfCare?: Reference[];
  period?: Period;
  serviceProvider?: Reference;
  location?: Array<{ location: Reference; status?: string; period?: Period }>;
  hospitalization?: { admitSource?: CodeableConcept; dischargeDisposition?: CodeableConcept; reAdmission?: CodeableConcept };
  reasonCode?: CodeableConcept[];
  basedOn?: Reference[];
  partOf?: Reference;
}

export interface Observation extends DomainResource {
  resourceType: 'Observation';
  identifier?: Identifier[];
  status: 'registered' | 'preliminary' | 'final' | 'amended' | 'corrected' | 'cancelled' | 'entered-in-error' | 'unknown';
  category?: CodeableConcept[];
  code: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  issued?: string;
  performer?: Reference[];
  valueQuantity?: Quantity;
  valueCodeableConcept?: CodeableConcept;
  valueString?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  interpretation?: CodeableConcept[];
  referenceRange?: Array<{ low?: Quantity; high?: Quantity; text?: string }>;
  component?: Array<{ code?: CodeableConcept; valueQuantity?: Quantity; valueCodeableConcept?: CodeableConcept; interpretation?: CodeableConcept[] }>;
  basedOn?: Reference[];
  hasMember?: Reference[];
}

export interface ServiceRequest extends DomainResource {
  resourceType: 'ServiceRequest';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'on-hold' | 'revoked' | 'completed' | 'entered-in-error' | 'unknown';
  intent: 'proposal' | 'plan' | 'directive' | 'order' | 'original-order' | 'reflex-order' | 'filler-order' | 'instance-order';
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  occurrenceDateTime?: string;
  authoredOn?: string;
  requester?: Reference;
  performerType?: CodeableConcept;
  priority?: 'routine' | 'urgent' | 'asap' | 'stat';
  reasonCode?: CodeableConcept[];
  supportingInfo?: Reference[];
}

export interface MedicationRequest extends DomainResource {
  resourceType: 'MedicationRequest';
  identifier?: Identifier[];
  status: 'active' | 'on-hold' | 'ended' | 'stopped' | 'completed' | 'cancelled' | 'draft' | 'entered-in-error' | 'unknown';
  intent: 'proposal' | 'plan' | 'order' | 'original-order' | 'reflex-order' | 'filler-order' | 'instance-order';
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  subject?: Reference;
  encounter?: Reference;
  authoredOn?: string;
  requester?: Reference;
  dosageInstruction?: Dosage[];
  dispenseRequest?: { validityPeriod?: Period; quantity?: Quantity };
  reasonCode?: CodeableConcept[];
}

export interface Medication extends DomainResource {
  resourceType: 'Medication';
  code?: CodeableConcept;
  status?: 'active' | 'inactive' | 'entered-in-error';
  manufacturer?: Reference;
  form?: CodeableConcept;
}

export interface Practitioner extends DomainResource {
  resourceType: 'Practitioner';
  identifier?: Identifier[];
  active?: boolean;
  name?: HumanName[];
  telecom?: ContactPoint[];
  gender?: 'male' | 'female' | 'other' | 'unknown';
  qualification?: Array<{ identifier?: Identifier[]; code: CodeableConcept; period?: Period; issuer?: Reference }>;
}

export interface PractitionerRole extends DomainResource {
  resourceType: 'PractitionerRole';
  practitioner?: Reference;
  organization?: Reference;
  code?: CodeableConcept[];
  specialty?: CodeableConcept[];
  location?: Reference[];
  active?: boolean;
  period?: Period;
}

export interface Organization extends DomainResource {
  resourceType: 'Organization';
  identifier?: Identifier[];
  active?: boolean;
  type?: CodeableConcept[];
  name?: string;
  telecom?: ContactPoint[];
  address?: Address[];
  partOf?: Reference;
}

export interface Location extends DomainResource {
  resourceType: 'Location';
  identifier?: Identifier[];
  status?: 'active' | 'suspended' | 'inactive';
  name?: string;
  description?: string;
  mode?: 'instance' | 'kind';
  type?: CodeableConcept[];
  physicalType?: CodeableConcept;
  address?: Address;
  partOf?: Reference;
  managingOrganization?: Reference;
}

export interface Device extends DomainResource {
  resourceType: 'Device';
  identifier?: Identifier[];
  status?: 'active' | 'inactive' | 'entered-in-error' | 'unknown';
  statusReason?: CodeableConcept[];
  type?: CodeableConcept;
  patient?: Reference;
  owner?: Reference;
  location?: Reference;
  serialNumber?: string;
  modelNumber?: string;
  note?: Annotation[];
}

export interface Coverage extends DomainResource {
  resourceType: 'Coverage';
  identifier?: Identifier[];
  status: 'active' | 'cancelled' | 'draft' | 'entered-in-error';
  kind?: 'group' | 'self-pay' | 'other';
  beneficiary?: Reference;
  payor?: Reference[];
  subscriberId?: string;
  period?: Period;
  class?: Array<{ type: CodeableConcept; value: string; name?: string }>;
}

export interface Claim extends DomainResource {
  resourceType: 'Claim';
  identifier?: Identifier[];
  status: 'active' | 'cancelled' | 'draft' | 'entered-in-error';
  type: CodeableConcept;
  use: 'claim' | 'preauthorization' | 'predetermination';
  patient?: Reference;
  provider?: Reference;
  priority?: CodeableConcept;
  created?: string;
  insurer?: Reference;
  facility?: Reference;
  diagnosis?: Array<{ sequence?: number; diagnosis?: CodeableConcept; type?: CodeableConcept[] }>;
  item?: Array<{ sequence?: number; productOrService?: CodeableConcept; net?: Money; diagnosisSequence?: number[] }>;
  total?: Money;
}

export interface CarePlan extends DomainResource {
  resourceType: 'CarePlan';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'on-hold' | 'revoked' | 'completed' | 'entered-in-error' | 'unknown';
  intent: 'proposal' | 'plan' | 'order' | 'option';
  title?: string;
  subject?: Reference;
  period?: Period;
  activity?: Array<{ outcomeCodeableConcept?: CodeableConcept[]; progress?: Annotation[]; detail?: { status: string; code?: CodeableConcept; scheduledString?: string } }>;
  basedOn?: Reference[];
  goal?: Reference[];
}

export interface Task extends DomainResource {
  resourceType: 'Task';
  identifier?: Identifier[];
  status: 'draft' | 'requested' | 'received' | 'accepted' | 'in-progress' | 'on-hold' | 'failed' | 'cancelled' | 'completed' | 'entered-in-error' | 'ready' | 'rejected';
  intent: 'proposal' | 'plan' | 'order' | 'original-order' | 'reflex-order' | 'filler-order' | 'instance-order' | 'option';
  priority?: 'routine' | 'urgent' | 'asap' | 'stat';
  code?: CodeableConcept;
  subject?: Reference;
  requester?: Reference;
  owner?: Reference;
  for?: Reference;
  authoredOn?: string;
  description?: string;
  note?: Annotation[];
  focus?: Reference;
}

export interface CommunicationRequest extends DomainResource {
  resourceType: 'CommunicationRequest';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'on-hold' | 'revoked' | 'completed' | 'entered-in-error' | 'unknown';
  priority?: 'routine' | 'urgent' | 'asap' | 'stat';
  subject?: Reference;
  requester?: Reference;
  recipient?: Reference[];
  sender?: Reference;
  reasonCode?: CodeableConcept[];
  payload?: Array<{ contentString?: string; contentReference?: Reference }>;
}

export interface Measure extends DomainResource {
  resourceType: 'Measure';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'retired' | 'unknown';
  name?: string;
  title?: string;
  version?: string;
  url?: string;
  publisher?: string;
  description?: string;
  library?: string[];
  scoring?: CodeableConcept;
  group?: Array<{ id?: string; population?: Array<{ code?: CodeableConcept; criteria?: { language?: string; expression?: string } }> }>;
}

export interface Library extends DomainResource {
  resourceType: 'Library';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'retired' | 'unknown';
  type: CodeableConcept;
  name?: string;
  title?: string;
  version?: string;
  content?: Attachment[];
}

export interface ValueSet extends DomainResource {
  resourceType: 'ValueSet';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'retired' | 'unknown';
  version?: string;
  name?: string;
  title?: string;
  compose?: { include?: Array<{ system?: string; concept?: Array<{ code: string; display?: string }> }> };
  expansion?: { identifier?: string; timestamp: string; total?: number; contains?: Array<{ system?: string; code?: string; display?: string }> };
}

export interface AuditEvent extends DomainResource {
  resourceType: 'AuditEvent';
  type: Coding;
  subtype?: Coding[];
  action?: 'C' | 'R' | 'U' | 'D' | 'E';
  recorded: string;
  outcome?: '0' | '4' | '8' | '12';
  agent: Array<{ type?: CodeableConcept; who?: Reference; requestor?: boolean }>;
  source: { site?: string; observer: Reference };
  entity?: Array<{ what?: Reference; type?: Coding; role?: Coding }>;
}

export interface Provenance extends DomainResource {
  resourceType: 'Provenance';
  target: Reference[];
  recorded: string;
  activity?: CodeableConcept;
  agent: Array<{ type?: CodeableConcept; role?: CodeableConcept[]; who: Reference; onBehalfOf?: Reference }>;
  entity?: Array<{ role: 'derivation' | 'revision' | 'quotation' | 'source' | 'removal'; what: Reference }>;
}

export interface Flag extends DomainResource {
  resourceType: 'Flag';
  identifier?: Identifier[];
  status: 'active' | 'inactive' | 'entered-in-error';
  category?: CodeableConcept[];
  code: CodeableConcept;
  subject: Reference;
  period?: Period;
  author?: Reference;
}

export interface Condition extends DomainResource {
  resourceType: 'Condition';
  identifier?: Identifier[];
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  category?: CodeableConcept[];
  severity?: CodeableConcept;
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  onsetDateTime?: string;
  abatementDateTime?: string;
  recordedDate?: string;
  recorder?: Reference;
  asserter?: Reference;
  stage?: Array<{ summary?: CodeableConcept }>;
  evidence?: Array<{ code?: CodeableConcept[]; detail?: Reference[] }>;
  note?: Annotation[];
}

export interface AllergyIntolerance extends DomainResource {
  resourceType: 'AllergyIntolerance';
  identifier?: Identifier[];
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  type?: 'allergy' | 'intolerance';
  category?: Array<'food' | 'medication' | 'environment' | 'biologic'>;
  criticality?: 'low' | 'high' | 'unable-to-assess';
  code?: CodeableConcept;
  patient?: Reference;
  encounter?: Reference;
  onsetDateTime?: string;
  recordedDate?: string;
  recorder?: Reference;
  reaction?: Array<{ substance?: CodeableConcept; manifestation?: CodeableConcept[]; severity?: 'mild' | 'moderate' | 'severe'; onset?: string }>;
}

export interface Procedure extends DomainResource {
  resourceType: 'Procedure';
  identifier?: Identifier[];
  status: 'preparation' | 'in-progress' | 'not-done' | 'on-hold' | 'stopped' | 'completed' | 'entered-in-error' | 'unknown';
  category?: CodeableConcept;
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  performedDateTime?: string;
  performedPeriod?: Period;
  recorder?: Reference;
  asserter?: Reference;
  reasonCode?: CodeableConcept[];
  outcome?: CodeableConcept;
  report?: Reference[];
}

export interface Immunization extends DomainResource {
  resourceType: 'Immunization';
  identifier?: Identifier[];
  status: 'completed' | 'entered-in-error' | 'not-done';
  statusReason?: CodeableConcept;
  vaccineCode?: CodeableConcept;
  patient?: Reference;
  encounter?: Reference;
  occurrenceDateTime?: string;
  recorded?: string;
  primarySource?: boolean;
  lotNumber?: string;
  expirationDate?: string;
  site?: CodeableConcept;
  route?: CodeableConcept;
  doseQuantity?: Quantity;
  performer?: Array<{ function?: CodeableConcept; actor?: Reference }>;
}

export interface DiagnosticReport extends DomainResource {
  resourceType: 'DiagnosticReport';
  identifier?: Identifier[];
  status: 'registered' | 'partial' | 'preliminary' | 'final' | 'amended' | 'corrected' | 'appended' | 'cancelled' | 'entered-in-error' | 'unknown';
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  effectiveDateTime?: string;
  issued?: string;
  performer?: Reference[];
  resultsInterpreter?: Reference[];
  result?: Reference[];
  conclusion?: string;
  presentedForm?: Attachment[];
}

export interface MedicationAdministration extends DomainResource {
  resourceType: 'MedicationAdministration';
  identifier?: Identifier[];
  status: 'in-progress' | 'not-done' | 'on-hold' | 'completed' | 'entered-in-error' | 'stopped' | 'unknown';
  statusReason?: CodeableConcept[];
  medicationCodeableConcept?: CodeableConcept;
  subject?: Reference;
  context?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  performer?: Array<{ function?: CodeableConcept; actor?: Reference }>;
  reasonCode?: CodeableConcept[];
  request?: Reference;
  dosage?: { text?: string; route?: CodeableConcept; dose?: Quantity };
}

export interface QuestionnaireResponse extends DomainResource {
  resourceType: 'QuestionnaireResponse';
  identifier?: Identifier;
  basedOn?: Reference[];
  partOf?: Reference[];
  questionnaire?: string;
  status: 'in-progress' | 'completed' | 'amended' | 'entered-in-error' | 'stopped';
  subject?: Reference;
  encounter?: Reference;
  authored?: string;
  author?: Reference;
  source?: Reference;
  item?: Array<{ linkId?: string; definition?: string; text?: string; answer?: Array<{ valueString?: string; valueBoolean?: boolean; valueInteger?: number; valueDecimal?: number; valueDate?: string; valueDateTime?: string; valueCoding?: Coding; valueQuantity?: Quantity }> }>;
}

export interface DocumentReference extends DomainResource {
  resourceType: 'DocumentReference';
  identifier?: Identifier[];
  status: 'current' | 'superseded' | 'entered-in-error';
  docStatus?: 'preliminary' | 'final' | 'amended' | 'entered-in-error';
  type?: CodeableConcept;
  category?: CodeableConcept[];
  subject?: Reference;
  date?: string;
  author?: Reference[];
  authenticator?: Reference;
  custodian?: Reference;
  relatesTo?: Array<{ code: 'replaces' | 'transforms' | 'signs' | 'appends'; target: Reference }>;
  description?: string;
  securityLabel?: CodeableConcept[];
  content?: Array<{ attachment?: Attachment; format?: CodeableConcept }>;
  context?: { encounter?: Reference[]; event?: CodeableConcept[]; period?: Period; sourcePatientInfo?: Reference };
}

export interface Communication extends DomainResource {
  resourceType: 'Communication';
  identifier?: Identifier[];
  status: 'preparation' | 'in-progress' | 'not-done' | 'on-hold' | 'stopped' | 'completed' | 'entered-in-error' | 'unknown';
  statusReason?: CodeableConcept;
  category?: CodeableConcept[];
  priority?: 'routine' | 'urgent' | 'asap' | 'stat';
  medium?: CodeableConcept[];
  subject?: Reference;
  topic?: CodeableConcept;
  about?: Reference[];
  encounter?: Reference;
  sent?: string;
  received?: string;
  recipient?: Reference[];
  sender?: Reference;
  reasonCode?: CodeableConcept[];
  payload?: Array<{ contentString?: string; contentAttachment?: Attachment; contentReference?: Reference }>;
}

export interface Appointment extends DomainResource {
  resourceType: 'Appointment';
  identifier?: Identifier[];
  status: 'proposed' | 'pending' | 'booked' | 'arrived' | 'fulfilled' | 'cancelled' | 'noshow' | 'entered-in-error' | 'checked-in' | 'waitlist';
  cancelationReason?: CodeableConcept;
  serviceCategory?: CodeableConcept[];
  serviceType?: CodeableConcept[];
  specialty?: CodeableConcept[];
  appointmentType?: CodeableConcept;
  reasonCode?: CodeableConcept[];
  priority?: number;
  description?: string;
  start?: string;
  end?: string;
  minutesDuration?: number;
  slot?: Reference[];
  created?: string;
  comment?: string;
  patientInstruction?: string;
  basedOn?: Reference[];
  participant?: Array<{ type?: CodeableConcept[]; actor?: Reference; required?: 'required' | 'optional' | 'information-only'; status: 'accepted' | 'declined' | 'tentative' | 'needs-action' }>;
}

export interface Schedule extends DomainResource {
  resourceType: 'Schedule';
  identifier?: Identifier[];
  active?: boolean;
  serviceCategory?: CodeableConcept[];
  serviceType?: CodeableConcept[];
  specialty?: CodeableConcept[];
  actor?: Reference[];
  planningHorizon?: Period;
  comment?: string;
}

export interface Slot extends DomainResource {
  resourceType: 'Slot';
  identifier?: Identifier[];
  status: 'busy' | 'free' | 'busy-unavailable' | 'busy-tentative' | 'entered-in-error';
  serviceCategory?: CodeableConcept[];
  serviceType?: CodeableConcept[];
  specialty?: CodeableConcept[];
  appointmentType?: CodeableConcept;
  schedule?: Reference;
  start?: string;
  end?: string;
  overbooked?: boolean;
  comment?: string;
}

export interface ExplanationOfBenefit extends DomainResource {
  resourceType: 'ExplanationOfBenefit';
  identifier?: Identifier[];
  status: 'active' | 'cancelled' | 'draft' | 'entered-in-error';
  type?: CodeableConcept;
  use: 'claim' | 'preauthorization' | 'predetermination';
  patient?: Reference;
  billablePeriod?: Period;
  created?: string;
  insurer?: Reference;
  provider?: Reference;
  outcome?: 'queued' | 'complete' | 'error' | 'partial';
  disposition?: string;
  diagnosis?: Array<{ sequence?: number; diagnosis?: CodeableConcept; type?: CodeableConcept[] }>;
  procedure?: Array<{ sequence?: number; procedure?: CodeableConcept; type?: CodeableConcept[] }>;
  item?: Array<{ sequence?: number; category?: CodeableConcept; productOrService?: CodeableConcept; adjudication?: Array<{ category?: CodeableConcept; amount?: Money }> }>;
  total?: Array<{ category?: CodeableConcept; amount?: Money }>;
  payment?: { type?: CodeableConcept; amount?: Money; date?: string };
}

export interface Invoice extends DomainResource {
  resourceType: 'Invoice';
  identifier?: Identifier[];
  status: 'draft' | 'issued' | 'balanced' | 'cancelled' | 'entered-in-error';
  type?: CodeableConcept;
  subject?: Reference;
  recipient?: Reference;
  date?: string;
  issuer?: Reference;
  participant?: Array<{ role?: CodeableConcept; actor?: Reference }>;
  lineItem?: Array<{ sequence?: number; service?: CodeableConcept; quantity?: Quantity; unitPrice?: Money; priceComponent?: Array<{ type?: string; code?: CodeableConcept; factor?: number; amount?: Money }> }>;
  totalGross?: Money;
  totalNet?: Money;
  paymentTerms?: string;
  note?: Annotation[];
}

export interface Account extends DomainResource {
  resourceType: 'Account';
  identifier?: Identifier[];
  status: 'active' | 'inactive' | 'entered-in-error' | 'on-hold' | 'unknown';
  type?: CodeableConcept;
  name?: string;
  subject?: Reference[];
  period?: Period;
  owner?: Reference;
  description?: string;
  guarantor?: Array<{ party?: Reference; onHold?: boolean; period?: Period }>;
  coverage?: Array<{ coverage?: Reference; priority?: number }>;
}

export interface ClaimResponse extends DomainResource {
  resourceType: 'ClaimResponse';
  identifier?: Identifier[];
  status: 'active' | 'cancelled' | 'draft' | 'entered-in-error';
  type?: CodeableConcept;
  use: 'claim' | 'preauthorization' | 'predetermination';
  patient?: Reference;
  created?: string;
  insurer?: Reference;
  provider?: Reference;
  outcome?: 'queued' | 'complete' | 'error' | 'partial';
  disposition?: string;
  item?: Array<{ sequence?: number; adjudication?: Array<{ category?: CodeableConcept; amount?: Money }> }>;
  total?: Array<{ category?: CodeableConcept; amount?: Money }>;
  payment?: { type?: CodeableConcept; amount?: Money; date?: string };
}

export interface CareTeam extends DomainResource {
  resourceType: 'CareTeam';
  identifier?: Identifier[];
  status: 'proposed' | 'active' | 'suspended' | 'inactive' | 'entered-in-error';
  name?: string;
  subject?: Reference;
  encounter?: Reference;
  period?: Period;
  participant?: Array<{ role?: CodeableConcept; member?: Reference; period?: Period }>;
  reasonCode?: CodeableConcept[];
}

export interface Goal extends DomainResource {
  resourceType: 'Goal';
  identifier?: Identifier[];
  lifecycleStatus: 'proposed' | 'planned' | 'accepted' | 'active' | 'on-hold' | 'completed' | 'cancelled' | 'entered-in-error' | 'rejected';
  description: CodeableConcept;
  subject?: Reference;
  startDate?: string;
  statusDate?: string;
  target?: Array<{ measure?: CodeableConcept; detailQuantity?: Quantity; dueDate?: string }>;
}

export interface Subscription extends DomainResource {
  resourceType: 'Subscription';
  identifier?: Identifier[];
  status: 'requested' | 'active' | 'error' | 'off';
  reason: string;
  criteria: string;
  end?: string;
  channel: {
    type: 'rest-hook' | 'websocket' | 'email' | 'sms' | 'message';
    endpoint?: string;
    payload?: string;
    header?: string[];
  };
}

export interface Questionnaire extends DomainResource {
  resourceType: 'Questionnaire';
  identifier?: Identifier[];
  url?: string;
  version?: string;
  name?: string;
  title?: string;
  status: 'draft' | 'active' | 'retired' | 'unknown';
  subjectType?: string[];
  item?: Array<{ linkId: string; text?: string; type: 'group' | 'display' | 'question' | 'boolean' | 'decimal' | 'integer' | 'date' | 'dateTime' | 'time' | 'string' | 'text' | 'url' | 'choice' | 'open-choice' | 'attachment' | 'reference' | 'quantity'; item?: Array<unknown> }>;
}

export interface Consent extends DomainResource {
  resourceType: 'Consent';
  identifier?: Identifier[];
  status: 'draft' | 'proposed' | 'active' | 'rejected' | 'inactive' | 'entered-in-error';
  scope: CodeableConcept;
  category: CodeableConcept[];
  patient?: Reference;
  dateTime?: string;
  policy?: Array<{ authority?: string; uri?: string }>;
  provision?: { type?: 'deny' | 'permit'; period?: Period; code?: CodeableConcept[] };
}

export interface AdverseEvent extends DomainResource {
  resourceType: 'AdverseEvent';
  identifier?: Identifier[];
  status: 'available' | 'unknown' | 'unavailable';
  event?: CodeableConcept;
  subject?: Reference;
  actuality: 'actual' | 'potential';
  category?: CodeableConcept[];
  date?: string;
  seriousness?: CodeableConcept;
  recorder?: Reference;
  outcome?: CodeableConcept;
}

export interface MedicationStatement extends DomainResource {
  resourceType: 'MedicationStatement';
  identifier?: Identifier[];
  status: 'active' | 'completed' | 'entered-in-error' | 'intended' | 'stopped' | 'on-hold' | 'unknown' | 'not-taken';
  medicationCodeableConcept?: CodeableConcept;
  subject?: Reference;
  context?: Reference;
  effectiveDateTime?: string;
  dateAsserted?: string;
  reasonCode?: CodeableConcept[];
  dosage?: Array<{ text?: string; route?: CodeableConcept; doseAndRate?: Array<{ doseQuantity?: Quantity }> }>;
}

export interface MedicationDispense extends DomainResource {
  resourceType: 'MedicationDispense';
  identifier?: Identifier[];
  status: 'preparation' | 'in-progress' | 'cancelled' | 'on-hold' | 'completed' | 'entered-in-error' | 'stopped' | 'declined' | 'unknown';
  medicationCodeableConcept?: CodeableConcept;
  subject?: Reference;
  context?: Reference;
  quantity?: Quantity;
  daysSupply?: Quantity;
  whenPrepared?: string;
  whenHandedOver?: string;
  authorizingPrescription?: Reference[];
}

export interface ImagingStudy extends DomainResource {
  resourceType: 'ImagingStudy';
  identifier?: Identifier[];
  status: 'registered' | 'active' | 'cancelled' | 'completed' | 'entered-in-error' | 'unknown';
  subject?: Reference;
  encounter?: Reference;
  started?: string;
  numberOfSeries?: number;
  numberOfInstances?: number;
  series?: Array<{ uid: string; number?: number; modality?: Coding; started?: string; instance?: Array<{ uid: string; number?: number; sopClass?: Coding; title?: string }> }>;
}

export interface Specimen extends DomainResource {
  resourceType: 'Specimen';
  identifier?: Identifier[];
  status: 'available' | 'unavailable' | 'unsatisfactory' | 'entered-in-error';
  type?: CodeableConcept;
  subject?: Reference;
  receivedTime?: string;
  collectedDateTime?: string;
  container?: Array<{ type?: CodeableConcept; capacity?: Quantity }>;
}

export interface DetectedIssue extends DomainResource {
  resourceType: 'DetectedIssue';
  identifier?: Identifier[];
  status: 'preliminary' | 'final' | 'amended' | 'entered-in-error' | 'mitigated';
  code?: CodeableConcept;
  severity?: 'high' | 'moderate' | 'low';
  patient?: Reference;
  identifiedDateTime?: string;
  detail?: string;
  implicated?: Reference[];
}

export interface PaymentReconciliation extends DomainResource {
  resourceType: 'PaymentReconciliation';
  identifier?: Identifier[];
  status: 'active' | 'cancelled' | 'draft' | 'entered-in-error';
  period?: Period;
  created?: string;
  disposition?: string;
  paymentAmount?: Money;
  paymentDate?: string;
  paymentMethod?: CodeableConcept;
}

export interface Composition extends DomainResource {
  resourceType: 'Composition';
  identifier?: Identifier;
  status: 'preliminary' | 'final' | 'amended' | 'entered-in-error';
  type: CodeableConcept;
  category?: CodeableConcept[];
  subject?: Reference;
  encounter?: Reference;
  date: string;
  author: Reference[];
  title: string;
  section?: Array<{ title?: string; code?: CodeableConcept; text?: Narrative; entry?: Reference[] }>;
}

export interface VisionPrescription extends DomainResource {
  resourceType: 'VisionPrescription';
  identifier?: Identifier[];
  status: 'active' | 'cancelled' | 'draft' | 'entered-in-error';
  patient?: Reference;
  created?: string;
  dateWritten?: string;
  prescriber?: Reference;
  lensSpecification?: Array<{ product?: CodeableConcept; eye?: 'right' | 'left'; sphere?: number; cylinder?: number; axis?: number; add?: number }>;
}

export interface DeviceUseStatement extends DomainResource {
  resourceType: 'DeviceUseStatement';
  identifier?: Identifier[];
  status: 'active' | 'completed' | 'entered-in-error' | 'intended' | 'stopped' | 'on-hold' | 'unknown' | 'not-taken';
  subject?: Reference;
  device?: Reference;
  timingDateTime?: string;
  recordedOn?: string;
  reasonCode?: CodeableConcept[];
}

export interface NutritionOrder extends DomainResource {
  resourceType: 'NutritionOrder';
  identifier?: Identifier[];
  status: 'draft' | 'active' | 'on-hold' | 'revoked' | 'completed' | 'entered-in-error' | 'unknown';
  patient?: Reference;
  encounter?: Reference;
  dateTime?: string;
  orderer?: Reference;
  oralDiet?: { type?: CodeableConcept[]; texture?: Array<{ modifier?: CodeableConcept; foodType?: CodeableConcept }> };
  supplement?: Array<{ type?: CodeableConcept; productName?: string; quantity?: Quantity }>;
  enteralFormula?: { baseFormulaType?: CodeableConcept; additiveType?: CodeableConcept[]; volume?: Quantity; routeofAdministration?: CodeableConcept };
}

export interface SupplyDelivery extends DomainResource {
  resourceType: 'SupplyDelivery';
  identifier?: Identifier[];
  status?: 'in-progress' | 'completed' | 'abandoned' | 'entered-in-error';
  patient?: Reference;
  type?: CodeableConcept;
  quantity?: Quantity;
  suppliedItem?: { quantity?: Quantity; itemCodeableConcept?: CodeableConcept };
  occurrenceDateTime?: string;
}

export interface HealthcareService extends DomainResource {
  resourceType: 'HealthcareService';
  identifier?: Identifier[];
  active?: boolean;
  providedBy?: Reference;
  category?: CodeableConcept[];
  type?: CodeableConcept[];
  name?: string;
  location?: Reference[];
  endpoint?: Reference[];
  telecom?: Array<{ system?: string; value?: string }>;
}

export interface Endpoint extends DomainResource {
  resourceType: 'Endpoint';
  identifier?: Identifier[];
  status: 'active' | 'suspended' | 'error' | 'off' | 'entered-in-error' | 'test';
  connectionType?: Coding;
  name?: string;
  address?: string;
  payloadType?: CodeableConcept[];
  period?: Period;
}

export interface OrganizationAffiliation extends DomainResource {
  resourceType: 'OrganizationAffiliation';
  identifier?: Identifier[];
  active?: boolean;
  organization?: Reference;
  participatingOrganization?: Reference;
  network?: Reference[];
  code?: CodeableConcept[];
  specialty?: CodeableConcept[];
  location?: Reference[];
  healthcareService?: Reference[];
  endpoint?: Reference[];
}

export interface Substance extends DomainResource {
  resourceType: 'Substance';
  identifier?: Identifier[];
  status?: 'active' | 'inactive' | 'entered-in-error';
  category?: CodeableConcept[];
  code: CodeableConcept;
  description?: string;
  instance?: Array<{ identifier?: Identifier; expiry?: string; quantity?: Quantity }>;
}

export interface MeasureReport extends DomainResource {
  resourceType: 'MeasureReport';
  identifier?: Identifier[];
  status: 'complete' | 'pending' | 'error';
  type: 'individual' | 'subject-list' | 'summary' | 'data-collection';
  measure: string;
  subject?: Reference;
  date?: string;
  period: Period;
  group?: Array<{ code?: CodeableConcept; population?: Array<{ code?: CodeableConcept; count?: number }>; measureScore?: Quantity }>;
}

export interface OperationOutcome extends DomainResource {
  resourceType: 'OperationOutcome';
  issue: Array<{ severity: 'fatal' | 'error' | 'warning' | 'information'; code: string; diagnostics?: string; details?: CodeableConcept; expression?: string[] }>;
}

export interface BundleEntry {
  fullUrl?: string;
  resource?: FhirResource;
  request?: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; ifNoneExist?: string };
  response?: { status: string; location?: string; outcome?: OperationOutcome };
}

export interface Bundle extends DomainResource {
  resourceType: 'Bundle';
  identifier?: Identifier;
  type: 'document' | 'message' | 'message-response' | 'transaction' | 'transaction-response' | 'batch' | 'batch-response' | 'history' | 'searchset' | 'collection';
  timestamp?: string;
  total?: number;
  link?: Array<{ relation: string; url: string }>;
  entry?: BundleEntry[];
}

/** Any FHIR resource we know how to serialize/consume. */
export type FhirResource =
  | Patient | Encounter | Observation | ServiceRequest | MedicationRequest | Medication
  | Practitioner | PractitionerRole | Organization | Location | Device | Coverage | Claim
  | CarePlan | Task | CommunicationRequest | Measure | Library | ValueSet | AuditEvent
  | Provenance | Flag | MeasureReport | OperationOutcome | Bundle
  | Condition | AllergyIntolerance | Procedure | Immunization | DiagnosticReport | MedicationAdministration
  | QuestionnaireResponse | DocumentReference | Communication | Appointment | Schedule | Slot
  | ExplanationOfBenefit | Invoice | Account
  | ClaimResponse | CareTeam | Goal | Subscription | Questionnaire | Consent
  | AdverseEvent | MedicationStatement | MedicationDispense | ImagingStudy | Specimen | DetectedIssue | PaymentReconciliation | Composition
  | VisionPrescription | DeviceUseStatement | NutritionOrder | SupplyDelivery | HealthcareService | Endpoint | OrganizationAffiliation | Substance;

/** Runtime list of every resourceType the FhirResource union covers (for coverage reports). */
export const TYPED_FHIR_RESOURCES: readonly string[] = [
  'Patient', 'Encounter', 'Observation', 'ServiceRequest', 'MedicationRequest', 'Medication',
  'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Device', 'Coverage', 'Claim',
  'CarePlan', 'Task', 'CommunicationRequest', 'Measure', 'Library', 'ValueSet', 'AuditEvent',
  'Provenance', 'Flag', 'MeasureReport', 'OperationOutcome', 'Bundle',
  'Condition', 'AllergyIntolerance', 'Procedure', 'Immunization', 'DiagnosticReport', 'MedicationAdministration',
  'QuestionnaireResponse', 'DocumentReference', 'Communication', 'Appointment', 'Schedule', 'Slot',
  'ExplanationOfBenefit', 'Invoice', 'Account',
  'ClaimResponse', 'CareTeam', 'Goal', 'Subscription', 'Questionnaire', 'Consent',
  'AdverseEvent', 'MedicationStatement', 'MedicationDispense', 'ImagingStudy', 'Specimen', 'DetectedIssue', 'PaymentReconciliation', 'Composition',
  'VisionPrescription', 'DeviceUseStatement', 'NutritionOrder', 'SupplyDelivery', 'HealthcareService', 'Endpoint', 'OrganizationAffiliation', 'Substance',
];

/** Context passed to every hydrate/serialize — carries the realm + identifier systems. */
export interface FhirCtx {
  realmId: string;
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
  /** system → entity id lookup used to resolve References (e.g. MRN urn:mrn → patient id). */
  identifierSystems?: Record<string, string>;
}

/** Canonical code systems used by the harness (LOINC/SNOMED/RxNorm/ICD-10/CPT/HL7). */
export const CODE_SYSTEMS = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  icd10: 'http://hl7.org/fhir/sid/icd-10-cm',
  cpt: 'http://www.ama-assn.org/go/cpt',
  cvx: 'http://hl7.org/fhir/sid/cvx',
  mrn: 'urn:mrn',
  npi: 'http://hl7.org/fhir/sid/us-npi',
  ssn: 'http://hl7.org/fhir/sid/us-ssn',
  oid: 'urn:oid',
} as const;

export function code(system: string, codeValue: string, display?: string): Coding {
  return { system, code: codeValue, ...(display ? { display } : {}) };
}
export function concept(system: string, codeValue: string, display?: string): CodeableConcept {
  return { coding: [code(system, codeValue, display)], ...(display ? { text: display } : {}) };
}
