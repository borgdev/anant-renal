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

// USCDI + US Core / QI-Core profile bindings. USCDI defines the classes of
// data every certified EHR must exchange; US Core provides FHIR
// implementation guidance and QI-Core adds quality-measure hooks. The harness
// binds its canonical events + entities to USCDI data classes so packs stay
// portable across EHRs.

export type USCDIVersion = 'v3' | 'v4' | 'v5';

export interface USCDIDataClass {
  readonly id: string;
  readonly title: string;
  readonly usCoreProfile: string;
  readonly qiCoreProfile?: string;
  readonly elements: readonly string[];
}

/** USCDI v4 data classes referenced by the harness (subset — extendable). */
export const uscdiV4: readonly USCDIDataClass[] = Object.freeze([
  {
    id: 'uscdi:patient-demographics',
    title: 'Patient Demographics',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
    qiCoreProfile: 'http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-patient',
    elements: ['name', 'birthDate', 'gender', 'identifier', 'address', 'race', 'ethnicity', 'preferredLanguage'],
  },
  {
    id: 'uscdi:encounter-information',
    title: 'Encounter Information',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter',
    qiCoreProfile: 'http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-encounter',
    elements: ['class', 'type', 'period', 'reasonCode', 'hospitalization', 'location'],
  },
  {
    id: 'uscdi:laboratory',
    title: 'Laboratory',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-lab',
    qiCoreProfile: 'http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-observation-lab',
    elements: ['code', 'value', 'referenceRange', 'effectiveDateTime', 'specimen', 'interpretation'],
  },
  {
    id: 'uscdi:medications',
    title: 'Medications',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-medicationrequest',
    qiCoreProfile: 'http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-medicationrequest',
    elements: ['medication', 'status', 'intent', 'authoredOn', 'requester', 'dosageInstruction'],
  },
  {
    id: 'uscdi:problems',
    title: 'Problems',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns',
    qiCoreProfile: 'http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-condition-problems-health-concerns',
    elements: ['code', 'clinicalStatus', 'verificationStatus', 'onset', 'abatement'],
  },
  {
    id: 'uscdi:procedures',
    title: 'Procedures',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-procedure',
    qiCoreProfile: 'http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-procedure',
    elements: ['code', 'status', 'performed', 'performer', 'reasonCode'],
  },
  {
    id: 'uscdi:vital-signs',
    title: 'Vital Signs',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-vital-signs',
    elements: ['code', 'value', 'effectiveDateTime', 'category'],
  },
  {
    id: 'uscdi:health-insurance-information',
    title: 'Health Insurance Information',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-coverage',
    elements: ['status', 'kind', 'beneficiary', 'payor', 'period', 'class'],
  },
  {
    id: 'uscdi:care-team-members',
    title: 'Care Team Members',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-careteam',
    elements: ['status', 'participant', 'category'],
  },
  {
    id: 'uscdi:goals',
    title: 'Goals and Preferences',
    usCoreProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-goal',
    elements: ['lifecycleStatus', 'description', 'target', 'expressedBy'],
  },
]);

/**
 * Bind a canonical harness event type to the USCDI class + FHIR profile it
 * represents. Used by adapters + measures to prove regulatory portability.
 */
export interface USCDIBinding {
  readonly harnessType: string;
  readonly uscdiId: string;
  readonly requiredElements: readonly string[];
}

export const canonicalUSCDIBindings: readonly USCDIBinding[] = Object.freeze([
  { harnessType: 'treatment.scheduled', uscdiId: 'uscdi:encounter-information', requiredElements: ['period', 'location'] },
  { harnessType: 'treatment.completed', uscdiId: 'uscdi:encounter-information', requiredElements: ['period', 'location', 'hospitalization'] },
  { harnessType: 'treatment.missed', uscdiId: 'uscdi:encounter-information', requiredElements: ['period'] },
  { harnessType: 'lab.result', uscdiId: 'uscdi:laboratory', requiredElements: ['code', 'value', 'effectiveDateTime'] },
  { harnessType: 'medication.ordered', uscdiId: 'uscdi:medications', requiredElements: ['medication', 'status', 'intent'] },
  { harnessType: 'coverage.active', uscdiId: 'uscdi:health-insurance-information', requiredElements: ['payor', 'beneficiary', 'period'] },
  { harnessType: 'condition.recorded', uscdiId: 'uscdi:problems', requiredElements: ['code', 'clinicalStatus'] },
  { harnessType: 'procedure.performed', uscdiId: 'uscdi:procedures', requiredElements: ['code', 'status', 'performed'] },
  { harnessType: 'vital.observed', uscdiId: 'uscdi:vital-signs', requiredElements: ['code', 'value', 'effectiveDateTime'] },
]);

export function findBinding(harnessType: string): USCDIBinding | undefined {
  return canonicalUSCDIBindings.find((b) => b.harnessType === harnessType);
}
