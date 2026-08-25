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

// Effect → FHIR write path (Phase 2). Every WorldEffect kind projects to the
// R4 resource(s) an EHR would receive. This is deterministic and pure — no
// realm access — so it can ride the live hypergraph (effect nodes already exist
// from Phase 1b) or replay the ledger offline.

import type { WorldEffect } from '../realm/types.js';
import type { FhirCtx, FhirResource } from './types.js';
import { CODE_SYSTEMS, code, concept } from './types.js';

export interface EffectFhirOptions {
  ctx: FhirCtx;
  /** FHIR Reference (e.g. `Patient/p1`) for the subject — defaults to `Patient/{patientId}` when present. */
  patientRef?: string;
  /** FHIR Reference (e.g. `Encounter/enc1`) for the encounter. */
  encounterRef?: string;
  issued?: string;
}

const VITALS_LOINC: Record<string, string> = {
  hr: '8867-4', bp: '55284-4', spo2: '2708-6', temp: '8310-5', rr: '9279-1',
};

const DISCHARGE_DISPOSITION: Record<string, string> = {
  home: 'http://terminology.hl7.org/CodeSystem/discharge-disposition|01',
  'home-health': 'http://terminology.hl7.org/CodeSystem/discharge-disposition|06',
  snf: 'http://terminology.hl7.org/CodeSystem/discharge-disposition|03',
  hospice: 'http://terminology.hl7.org/CodeSystem/discharge-disposition|50',
  transfer: 'http://terminology.hl7.org/CodeSystem/discharge-disposition|02',
  ama: 'http://terminology.hl7.org/CodeSystem/discharge-disposition|07',
  expired: 'http://terminology.hl7.org/CodeSystem/discharge-disposition|20',
};

function stamp(resource: FhirResource, ctx: FhirCtx): FhirResource {
  resource.meta = {
    source: ctx.sourceId,
    lastUpdated: ctx.ingestedAt,
    security: [code('http://terminology.hl7.org/CodeSystem/v3-Confidentiality', 'R', 'Restricted')],
  };
  return resource;
}

/** Project a WorldEffect onto FHIR R4 resource(s). Returns [] for effects with no wire equivalent. */
export function effectToFhirResource(effect: WorldEffect, opts: EffectFhirOptions): FhirResource[] {
  const { ctx } = opts;
  const subject = (): string | undefined => {
    const pid = 'patientId' in effect ? effect.patientId : undefined;
    return opts.patientRef ?? (pid ? `Patient/${pid}` : undefined);
  };
  const encountered = (): string | undefined => opts.encounterRef ?? ('encounterId' in effect && effect.encounterId ? `Encounter/${effect.encounterId}` : undefined);

  switch (effect.kind) {
    case 'admit-patient':
      return [stamp({
        resourceType: 'Encounter',
        status: 'in-progress',
        class: code('http://terminology.hl7.org/CodeSystem/v3-ActCode', 'AMB', 'ambulatory'),
        type: [concept('http://terminology.hl7.org/CodeSystem/v3-ActCode', 'AMB', 'admission')],
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
        ...(effect.reason ? { reasonCode: [concept('http://terminology.hl7.org/CodeSystem/condition-code', 'admission', effect.reason)] } : {}),
      } as never, ctx)];

    case 'transfer-patient':
      return [stamp({
        resourceType: 'Encounter',
        status: 'in-progress',
        class: code('http://terminology.hl7.org/CodeSystem/v3-ActCode', 'AMB', 'ambulatory'),
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
        location: [{ location: { reference: `Location/${effect.toUnitId}` } }],
      } as never, ctx)];

    case 'discharge-patient': {
      const disposition = DISCHARGE_DISPOSITION[effect.disposition] ?? 'http://terminology.hl7.org/CodeSystem/discharge-disposition|09';
      return [stamp({
        resourceType: 'Encounter',
        status: 'finished',
        class: code('http://terminology.hl7.org/CodeSystem/v3-ActCode', 'AMB', 'ambulatory'),
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt, end: ctx.ingestedAt },
        hospitalization: { dischargeDisposition: concept(disposition.split('|')[0]!, disposition.split('|')[1]!, effect.disposition) },
      } as never, ctx)];
    }

    case 'order-lab':
      return [stamp({
        resourceType: 'ServiceRequest',
        status: 'active',
        intent: 'order',
        code: concept(CODE_SYSTEMS.loinc, effect.code, `LOINC ${effect.code}`),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        priority: effect.priority === 'stat' ? 'stat' : effect.priority === 'send-out' ? 'urgent' : 'routine',
        authoredOn: ctx.ingestedAt,
      } as never, ctx)];

    case 'order-med': {
      const doseAndRate = effect.dose ? [{ doseQuantity: { value: Number(effect.dose.replace(/[^0-9.]/g, '')) || undefined, unit: effect.dose.replace(/[0-9.]/g, '').trim() || undefined } }] : undefined;
      return [stamp({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: concept(CODE_SYSTEMS.rxnorm, effect.code, `RxNorm ${effect.code}`),
        subject: subject() ? { reference: subject() } : undefined,
        authoredOn: ctx.ingestedAt,
        dosageInstruction: [{
          text: [effect.dose, effect.route, effect.frequency].filter(Boolean).join(' '),
          route: effect.route ? concept('http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration', effect.route) : undefined,
          doseAndRate,
        }],
        ...(effect.indication ? { reasonCode: [concept('http://terminology.hl7.org/CodeSystem/condition-code', 'indication', effect.indication)] } : {}),
      } as never, ctx)];
    }

    case 'result-lab': {
      const valueQuantity = typeof effect.value === 'number'
        ? { value: effect.value, unit: effect.unit }
        : { value: Number(effect.value) || undefined, unit: effect.unit };
      return [stamp({
        resourceType: 'Observation',
        status: 'final',
        category: [concept('http://terminology.hl7.org/CodeSystem/observation-category', 'laboratory', 'Laboratory')],
        code: concept(CODE_SYSTEMS.loinc, effect.code, `LOINC ${effect.code}`),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        effectiveDateTime: opts.issued ?? ctx.ingestedAt,
        issued: ctx.ingestedAt,
        valueQuantity,
        ...(effect.abnormal ? { interpretation: [concept('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', effect.abnormal)] } : {}),
      } as never, ctx)];
    }

    case 'record-vitals': {
      const vitalCodes: Array<[string, number | undefined, string]> = [
        ['hr', effect.hr, 'bpm'], ['spo2', effect.spo2, '%'], ['temp', effect.temp, 'C'], ['rr', effect.rr, 'breaths/min'],
      ];
      const obs: FhirResource[] = [];
      for (const [key, value, unit] of vitalCodes) {
        if (value === undefined) continue;
        const loincCode = VITALS_LOINC[key]!;
        obs.push(stamp({
          resourceType: 'Observation',
          status: 'final',
          category: [concept('http://terminology.hl7.org/CodeSystem/observation-category', 'vital-signs', 'Vital Signs')],
          code: concept(CODE_SYSTEMS.loinc, loincCode, key.toUpperCase()),
          subject: subject() ? { reference: subject() } : undefined,
          effectiveDateTime: opts.issued ?? ctx.ingestedAt,
          issued: ctx.ingestedAt,
          valueQuantity: { value, unit },
        } as never, ctx));
      }
      if (effect.bp) {
        const [sys, dia] = effect.bp.split('/').map((x) => Number(x));
        obs.push(stamp({
          resourceType: 'Observation',
          status: 'final',
          category: [concept('http://terminology.hl7.org/CodeSystem/observation-category', 'vital-signs', 'Vital Signs')],
          code: concept(CODE_SYSTEMS.loinc, VITALS_LOINC.bp!, 'Blood pressure'),
          subject: subject() ? { reference: subject() } : undefined,
          effectiveDateTime: opts.issued ?? ctx.ingestedAt,
          issued: ctx.ingestedAt,
          valueQuantity: { value: sys, unit: 'mmHg' },
          component: [{ code: concept(CODE_SYSTEMS.loinc, '8462-4', 'Diastolic'), valueQuantity: { value: dia, unit: 'mmHg' } }],
        } as never, ctx));
      }
      return obs;
    }

    case 'record-assessment':
      return [stamp({
        resourceType: 'Observation',
        status: 'final',
        category: [concept('http://terminology.hl7.org/CodeSystem/observation-category', 'survey', 'Survey')],
        code: concept(CODE_SYSTEMS.loinc, 'assessment', effect.assessmentId),
        subject: subject() ? { reference: subject() } : undefined,
        effectiveDateTime: opts.issued ?? ctx.ingestedAt,
        issued: ctx.ingestedAt,
        valueQuantity: { value: effect.score },
        ...(effect.band ? { interpretation: [concept('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', effect.band)] } : {}),
      } as never, ctx)];

    case 'update-care-plan':
      return [stamp({
        resourceType: 'CarePlan',
        status: 'active',
        intent: 'plan',
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
        ...(effect.patch.title ? { title: String(effect.patch.title) } : {}),
      } as never, ctx)];

    case 'submit-claim':
      return [stamp({
        resourceType: 'Claim',
        status: 'active',
        type: concept('http://terminology.hl7.org/CodeSystem/claim-type', 'professional', 'Professional'),
        use: 'claim',
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { facility: { reference: encountered() } } : {}),
        created: ctx.ingestedAt,
        diagnosis: (effect.icd10Codes ?? []).map((c, i) => ({ sequence: i + 1, diagnosis: concept(CODE_SYSTEMS.icd10, c) })),
        item: (effect.cptCodes ?? []).map((c, i) => ({ sequence: i + 1, productOrService: concept(CODE_SYSTEMS.cpt, c) })),
      } as never, ctx)];

    case 'request-prior-auth':
      return [stamp({
        resourceType: 'Claim',
        status: 'active',
        type: concept('http://terminology.hl7.org/CodeSystem/claim-type', 'professional', 'Professional'),
        use: 'preauthorization',
        subject: subject() ? { reference: subject() } : undefined,
        created: ctx.ingestedAt,
        item: [{ sequence: 1, productOrService: concept(CODE_SYSTEMS.cpt, effect.serviceCode) }],
      } as never, ctx)];

    case 'open-ticket':
      return [stamp({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        priority: effect.priority === 'critical' ? 'stat' : effect.priority === 'high' ? 'urgent' : 'routine',
        code: concept('http://terminology.hl7.org/CodeSystem/task-code', effect.ticketKind),
        subject: effect.subjectRef ? { reference: effect.subjectRef } : subject() ? { reference: subject() } : undefined,
        description: effect.summary,
        authoredOn: ctx.ingestedAt,
      } as never, ctx)];

    case 'flag-safety-event':
      return [stamp({
        resourceType: 'Flag',
        status: 'active',
        category: [concept('http://terminology.hl7.org/CodeSystem/flag-category', 'safety', 'Safety')],
        code: concept(CODE_SYSTEMS.snomed, effect.safetyKind),
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
      } as never, ctx)];

    case 'schedule-followup':
      return [stamp({
        resourceType: 'ServiceRequest',
        status: 'active',
        intent: 'plan',
        code: concept('http://terminology.hl7.org/CodeSystem/servicerequest-category', effect.followupKind),
        subject: subject() ? { reference: subject() } : undefined,
        occurrenceDateTime: effect.when,
        authoredOn: ctx.ingestedAt,
        performerType: concept('http://terminology.hl7.org/CodeSystem/practitioner-role', effect.resource),
      } as never, ctx)];

    case 'operator-directive':
      return [stamp({
        resourceType: 'CommunicationRequest',
        status: 'active',
        priority: 'urgent',
        subject: subject() ? { reference: subject() } : undefined,
        authoredOn: ctx.ingestedAt,
        payload: [{ contentString: effect.originalText }],
      } as never, ctx)];

    default:
      return []; // shadow/observability effects (record-agent-thought, notify-staff, …) have no wire resource
  }
}

/** The FHIR resource type(s) an effect kind projects to (for admin display). */
export function effectResourceType(effect: WorldEffect): string[] {
  switch (effect.kind) {
    case 'admit-patient': case 'transfer-patient': case 'discharge-patient': return ['Encounter'];
    case 'order-lab': case 'schedule-followup': return ['ServiceRequest'];
    case 'order-med': return ['MedicationRequest'];
    case 'result-lab': case 'record-vitals': case 'record-assessment': return ['Observation'];
    case 'update-care-plan': return ['CarePlan'];
    case 'submit-claim': case 'request-prior-auth': return ['Claim'];
    case 'open-ticket': return ['Task'];
    case 'flag-safety-event': return ['Flag'];
    case 'operator-directive': return ['CommunicationRequest'];
    default: return [];
  }
}
