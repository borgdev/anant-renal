/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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
//
// F4: every code below resolves through the terminology registry
// (`code-registry.ts`). A slug with no mapping THROWS, so an unvalidated code
// can never leave the building. Before F4 the internal slugs were written
// straight into RxNorm/LOINC/CVX/SNOMED fields, and a clinician received a
// "code" no code system recognises.

import type { WorldEffect } from '../realm/types.js';
import type { FhirCtx, FhirResource } from './types.js';
import { code, concept } from './types.js';
import { codeFor, conceptFor } from './code-registry.js';
import { requireDose } from './dose.js';

export interface EffectFhirOptions {
  ctx: FhirCtx;
  /** FHIR Reference (e.g. `Patient/p1`) for the subject — defaults to `Patient/{patientId}` when present. */
  patientRef?: string;
  /** FHIR Reference (e.g. `Encounter/enc1`) for the encounter — for a dialysis session this is the standing episode. */
  encounterRef?: string;
  /**
   * The session's entity id. `start-session` carries its own; `end-session` does
   * not, so the caller passes the id of the session it is closing — that is how
   * the same `Procedure` is closed rather than a second one created.
   */
  sessionId?: string;
  issued?: string;
}

/** Vitals that project as their own Observation, in emission order. */
const VITAL_SERIES: ReadonlyArray<{ key: 'hr' | 'spo2' | 'temp' | 'rr'; unit: string }> = [
  { key: 'hr', unit: 'bpm' },
  { key: 'spo2', unit: '%' },
  { key: 'temp', unit: 'C' },
  { key: 'rr', unit: 'breaths/min' },
];

function stamp(resource: FhirResource, ctx: FhirCtx): FhirResource {
  resource.meta = {
    source: ctx.sourceId,
    lastUpdated: ctx.ingestedAt,
    // A registry entry is structurally a Coding (system/code/display).
    security: [codeFor('security-label', 'restricted')],
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
        class: codeFor('encounter-class', 'AMB'),
        type: [conceptFor('encounter-class', 'AMB')],
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
        // No coded admission reason is available, so carry text only rather than
        // invent a code in a real code system.
        ...(effect.reason ? { reasonCode: [{ text: effect.reason }] } : {}),
      } as never, ctx)];

    case 'transfer-patient':
      return [stamp({
        resourceType: 'Encounter',
        status: 'in-progress',
        class: codeFor('encounter-class', 'AMB'),
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
        location: [{ location: { reference: `Location/${effect.toUnitId}` } }],
      } as never, ctx)];

    case 'discharge-patient':
      return [stamp({
        resourceType: 'Encounter',
        status: 'finished',
        class: codeFor('encounter-class', 'AMB'),
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt, end: ctx.ingestedAt },
        hospitalization: { dischargeDisposition: conceptFor('discharge-disposition', effect.disposition) },
      } as never, ctx)];

    case 'order-lab':
      return [stamp({
        resourceType: 'ServiceRequest',
        status: 'active',
        intent: 'order',
        code: conceptFor('lab', effect.code),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        priority: effect.priority === 'stat' ? 'stat' : effect.priority === 'send-out' ? 'urgent' : 'routine',
        authoredOn: ctx.ingestedAt,
      } as never, ctx)];

    case 'order-med': {
      // F4.4 — read the dose EXACTLY or refuse the write. The previous
      // `Number(dose.replace(/[^0-9.]/g,'')) || undefined` concatenated digits
      // across separators ('1-2 tabs' -> 12) and read frequencies as doses
      // ('q12h' -> 12). A medication order must never be invented by a regex.
      const dose = effect.dose ? requireDose(effect.dose) : undefined;
      return [stamp({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: conceptFor('drug', effect.code),
        subject: subject() ? { reference: subject() } : undefined,
        authoredOn: ctx.ingestedAt,
        dosageInstruction: [{
          text: [effect.dose, effect.route, effect.frequency].filter(Boolean).join(' '),
          ...(effect.route ? { route: conceptFor('route', effect.route) } : {}),
          ...(dose ? { doseAndRate: [{ doseQuantity: { value: dose.amount, ...(dose.unit ? { unit: dose.unit } : {}) } }] } : {}),
        }],
        // Indication has no verified coded concept; text only, never a fake code.
        ...(effect.indication ? { reasonCode: [{ text: effect.indication }] } : {}),
      } as never, ctx)];
    }

    case 'result-lab':
      return [stamp({
        resourceType: 'Observation',
        status: 'final',
        category: [conceptFor('observation-category', 'laboratory')],
        code: conceptFor('lab', effect.code),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        // `effect.observedAt` first, matching `record-assessment` and
        // `record-immunisation` below. The effect's own instant is the one that survives
        // a round trip through the realm; `opts.issued` is the caller's, and
        // `ctx.ingestedAt` is merely when we happened to read the resource.
        effectiveDateTime: effect.observedAt ?? opts.issued ?? ctx.ingestedAt,
        issued: ctx.ingestedAt,
        valueQuantity: typeof effect.value === 'number'
          ? { value: effect.value, unit: effect.unit }
          : { value: Number(effect.value) || undefined, unit: effect.unit },
        ...(effect.abnormal ? { interpretation: [concept('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', effect.abnormal)] } : {}),
      } as never, ctx)];

    case 'record-vitals': {
      const obs: FhirResource[] = [];
      for (const { key, unit } of VITAL_SERIES) {
        const value = effect[key];
        if (value === undefined) continue;
        obs.push(stamp({
          resourceType: 'Observation',
          status: 'final',
          category: [conceptFor('observation-category', 'vital-signs')],
          code: conceptFor('vital', key),
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
          category: [conceptFor('observation-category', 'vital-signs')],
          // The panel code with systolic/diastolic components — previously the
          // systolic value was carried under the PANEL code (55284-4).
          code: conceptFor('vital', 'bp'),
          subject: subject() ? { reference: subject() } : undefined,
          effectiveDateTime: opts.issued ?? ctx.ingestedAt,
          issued: ctx.ingestedAt,
          component: [
            { code: conceptFor('vital', 'bp-systolic'), valueQuantity: { value: sys, unit: 'mmHg' } },
            { code: conceptFor('vital', 'bp-diastolic'), valueQuantity: { value: dia, unit: 'mmHg' } },
          ],
        } as never, ctx));
      }
      return obs;
    }

    case 'record-assessment':
      return [stamp({
        resourceType: 'Observation',
        status: 'final',
        category: [conceptFor('observation-category', 'survey')],
        code: conceptFor('assessment', effect.assessmentId),
        subject: subject() ? { reference: subject() } : undefined,
        effectiveDateTime: effect.observedAt ?? opts.issued ?? ctx.ingestedAt,
        issued: ctx.ingestedAt,
        valueQuantity: { value: effect.score },
        ...(effect.band ? { interpretation: [concept('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', effect.band)] } : {}),
      } as never, ctx)];

    case 'record-immunisation':
      // P6 — immunisation record → FHIR Immunization. This is the patient's own
      // history; what is DUE is decided by the deterministic prevention rules.
      return [stamp({
        resourceType: 'Immunization',
        status: 'completed',
        vaccineCode: conceptFor('vaccine', effect.vaccine),
        patient: subject() ? { reference: subject() } : undefined,
        occurrenceDateTime: effect.administeredAt ?? opts.issued ?? ctx.ingestedAt,
        recorded: ctx.ingestedAt,
        ...(effect.lotNumber ? { lotNumber: effect.lotNumber } : {}),
        protocolApplied: [{ doseNumberPositiveInt: effect.seriesDose, ...(effect.seriesTotal ? { seriesDosesPositiveInt: effect.seriesTotal } : {}) }],
        ...(effect.note ? { note: [{ text: effect.note }] } : {}),
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
      // F4.5 — a dialysis claim is INSTITUTIONAL. The claim-type was hardcoded
      // `professional`, which a payer rejects for a facility service.
      return [stamp({
        resourceType: 'Claim',
        status: 'active',
        type: conceptFor('claim-type', 'institutional'),
        use: 'claim',
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { facility: { reference: encountered() } } : {}),
        created: ctx.ingestedAt,
        diagnosis: (effect.icd10Codes ?? []).map((c, i) => ({ sequence: i + 1, diagnosis: concept('http://hl7.org/fhir/sid/icd-10-cm', c) })),
        item: (effect.cptCodes ?? []).map((c, i) => ({ sequence: i + 1, productOrService: concept('http://www.ama-assn.org/go/cpt', c) })),
      } as never, ctx)];

    case 'request-prior-auth':
      return [stamp({
        resourceType: 'Claim',
        status: 'active',
        type: conceptFor('claim-type', 'institutional'),
        use: 'preauthorization',
        subject: subject() ? { reference: subject() } : undefined,
        created: ctx.ingestedAt,
        item: [{ sequence: 1, productOrService: concept('http://www.ama-assn.org/go/cpt', effect.serviceCode) }],
      } as never, ctx)];

    case 'open-ticket':
      return [stamp({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        priority: effect.priority === 'critical' ? 'stat' : effect.priority === 'high' ? 'urgent' : 'routine',
        code: conceptFor('task-code', effect.ticketKind),
        subject: effect.subjectRef ? { reference: effect.subjectRef } : subject() ? { reference: subject() } : undefined,
        description: effect.summary,
        authoredOn: ctx.ingestedAt,
      } as never, ctx)];

    case 'flag-safety-event':
      return [stamp({
        resourceType: 'Flag',
        status: 'active',
        category: [concept('http://terminology.hl7.org/CodeSystem/flag-category', 'safety', 'Safety')],
        code: conceptFor('safety-flag', effect.safetyKind),
        subject: subject() ? { reference: subject() } : undefined,
        period: { start: ctx.ingestedAt },
      } as never, ctx)];

    case 'schedule-followup':
      return [stamp({
        resourceType: 'ServiceRequest',
        status: 'active',
        intent: 'plan',
        code: conceptFor('followup', effect.followupKind),
        subject: subject() ? { reference: subject() } : undefined,
        occurrenceDateTime: effect.when,
        authoredOn: ctx.ingestedAt,
        performerType: conceptFor('practitioner-role', effect.resource),
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

    /* ---------------------------------------------- F7 · renal wire model */

    case 'start-session': {
      // D3 — the session is a `Procedure`, and `opts.encounterRef` is the
      // standing episode `Encounter` it belongs to. We carry the session id so
      // `end-session` can close the same resource.
      const sessionId = opts.sessionId ?? effect.sessionId;
      return [stamp({
        resourceType: 'Procedure',
        ...(sessionId ? { id: sessionId } : {}),
        status: 'in-progress',
        code: conceptFor('procedure', effect.modality),
        category: conceptFor('procedure-category', 'dialysis'),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        performedPeriod: { start: opts.issued ?? ctx.ingestedAt },
      } as never, ctx)];
    }

    case 'end-session': {
      const sessionId = opts.sessionId;
      const ended = opts.issued ?? ctx.ingestedAt;
      const procedure = stamp({
        resourceType: 'Procedure',
        ...(sessionId ? { id: sessionId } : {}),
        status: 'completed',
        code: conceptFor('procedure', 'hemodialysis'),
        category: conceptFor('procedure-category', 'dialysis'),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        performedPeriod: { start: ended, end: ended },
        ...(effect.stoppedEarly === true || effect.complication
          ? { outcome: { text: effect.complication ?? 'stopped-early' } }
          : {}),
      } as never, ctx);

      // Delivered metrics ride with the session, referencing it via `partOf`.
      const metrics: FhirResource[] = [];
      const metric = (slug: string, value: number | undefined, unit?: string): void => {
        if (value === undefined) return;
        metrics.push(stamp({
          resourceType: 'Observation',
          ...(sessionId ? { id: `${sessionId}-${slug}` } : {}),
          status: 'final',
          category: [conceptFor('observation-category', 'laboratory')],
          code: conceptFor('session-metric', slug),
          subject: subject() ? { reference: subject() } : undefined,
          ...(encountered() ? { encounter: { reference: encountered() } } : {}),
          ...(sessionId ? { partOf: [{ reference: `Procedure/${sessionId}` }] } : {}),
          effectiveDateTime: ended,
          valueQuantity: { value, ...(unit ? { unit } : {}) },
        } as never, ctx));
      };
      metric('uf-volume', effect.ufVolumeL, 'L');
      metric('recirculation', effect.recirculationPct, '%');
      metric('qb-avg', effect.qbAvg, 'mL/min');

      // The post-dialysis weight IS the dry-weight estimate.
      if (effect.postWeightKg !== undefined) {
        metrics.push(stamp({
          resourceType: 'Observation',
          ...(sessionId ? { id: `${sessionId}-dry-weight` } : {}),
          status: 'final',
          category: [conceptFor('observation-category', 'vital-signs')],
          code: conceptFor('body-weight', 'dry-weight'),
          subject: subject() ? { reference: subject() } : undefined,
          ...(encountered() ? { encounter: { reference: encountered() } } : {}),
          effectiveDateTime: ended,
          valueQuantity: { value: effect.postWeightKg, unit: 'kg' },
        } as never, ctx));
      }
      return [procedure, ...metrics];
    }

    case 'record-access': {
      const at = opts.issued ?? ctx.ingestedAt;

      // An untoward access event is an ADVERSE EVENT, not a procedure — the EMR
      // files it where the safety team will see it.
      if (effect.event === 'thrombosis' || effect.event === 'infection') {
        return [stamp({
          resourceType: 'AdverseEvent',
          status: 'available',
          actuality: 'actual',
          event: conceptFor('access-event', effect.event),
          subject: subject() ? { reference: subject() } : undefined,
          date: at,
          ...(effect.note ? { outcome: { text: effect.note } } : {}),
        } as never, ctx)];
      }

      // An intervention on the access is a Procedure.
      if (effect.event === 'angioplasty' || effect.event === 'declot'
        || effect.event === 'catheter-placed' || effect.event === 'avf-created') {
        return [stamp({
          resourceType: 'Procedure',
          status: 'completed',
          code: conceptFor('access-event', effect.event),
          subject: subject() ? { reference: subject() } : undefined,
          ...(encountered() ? { encounter: { reference: encountered() } } : {}),
          performedDateTime: at,
          ...(effect.note ? { note: [{ text: effect.note }] } : {}),
        } as never, ctx)];
      }

      // Surveillance / cannulation difficulty is a MEASUREMENT.
      const component = (slug: string, value: number | undefined, unit?: string) => {
        if (value === undefined) return undefined;
        return { code: conceptFor('access-metric', slug), valueQuantity: { value, ...(unit ? { unit } : {}) } };
      };
      const components = [
        component('venous-pressure', effect.venousPressureMmHg, 'mmHg'),
        component('arterial-pressure', effect.arterialPressureMmHg, 'mmHg'),
        component('access-flow', effect.accessFlowMlMin, 'mL/min'),
        component('recirculation', effect.recirculationPct, '%'),
        component('blood-flow', effect.measuredAtQb, 'mL/min'),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      if (components.length === 0) return [];

      return [stamp({
        resourceType: 'Observation',
        status: 'final',
        category: [conceptFor('observation-category', 'hemodynamic')],
        code: conceptFor('access-event', effect.event),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        effectiveDateTime: at,
        component: components,
      } as never, ctx)];
    }

    /* ------------------------------------------- F8 · intra-session detail */

    case 'record-session-telemetry': {
      // One reading. The session batches every point at `end-session`; this
      // projection exists so a single reading is representable on its own (and
      // so `effectResourceType` is honest about the capability).
      const at = opts.issued ?? ctx.ingestedAt;
      const sessionId = opts.sessionId;
      const out: FhirResource[] = [];
      const add = (slug: string, domain: 'vital' | 'session-telemetry', category: 'vital-signs' | 'hemodynamic', value: number | undefined, unit: string): void => {
        if (value === undefined) return;
        out.push(stamp({
          resourceType: 'Observation',
          ...(sessionId ? { id: `${sessionId}-t${effect.minute}-${slug}` } : {}),
          status: 'final',
          category: [conceptFor('observation-category', category)],
          code: conceptFor(domain, slug),
          subject: subject() ? { reference: subject() } : undefined,
          ...(encountered() ? { encounter: { reference: encountered() } } : {}),
          ...(sessionId ? { partOf: [{ reference: `Procedure/${sessionId}` }] } : {}),
          effectiveDateTime: at,
          valueQuantity: { value, unit },
        } as never, ctx));
      };
      add('hr', 'vital', 'vital-signs', effect.hr, 'bpm');
      add('temp', 'vital', 'vital-signs', effect.tempC, 'C');
      add('qb', 'session-telemetry', 'hemodynamic', effect.qb, 'mL/min');
      add('qd', 'session-telemetry', 'hemodynamic', effect.qd, 'mL/min');
      add('venous-pressure', 'session-telemetry', 'hemodynamic', effect.venousPressure, 'mmHg');
      add('arterial-pressure', 'session-telemetry', 'hemodynamic', effect.arterialPressure, 'mmHg');
      add('uf-rate', 'session-telemetry', 'hemodynamic', effect.ufRateMlH, 'mL/h');
      add('uf-volume', 'session-telemetry', 'hemodynamic', effect.ufVolumeL, 'L');
      if (effect.bp) {
        const [sys, dia] = effect.bp.split('/').map((x) => Number(x));
        out.push(stamp({
          resourceType: 'Observation',
          ...(sessionId ? { id: `${sessionId}-t${effect.minute}-bp` } : {}),
          status: 'final',
          category: [conceptFor('observation-category', 'vital-signs')],
          code: conceptFor('vital', 'bp'),
          subject: subject() ? { reference: subject() } : undefined,
          ...(sessionId ? { partOf: [{ reference: `Procedure/${sessionId}` }] } : {}),
          effectiveDateTime: at,
          component: [
            { code: conceptFor('vital', 'bp-systolic'), valueQuantity: { value: sys, unit: 'mmHg' } },
            { code: conceptFor('vital', 'bp-diastolic'), valueQuantity: { value: dia, unit: 'mmHg' } },
          ],
        } as never, ctx));
      }
      return out;
    }

    case 'record-access-acoustic': {
      // SYNTHETIC ONLY, enforced on the WRITE PATH as well as in the reducer: a
      // mel-band feature vector must never reach an EMR looking like a real
      // measurement. The payload is a coded placeholder plus a provenance
      // extension — never the audio, and never presented as measured data.
      if ((effect as { synthetic?: boolean }).synthetic !== true) {
        throw new Error(
          `refusing to write acoustic capture ${effect.captureId}: the synthetic flag is not set. ` +
            'A derived feature vector is not a measurement and must not be filed as one.',
        );
      }
      return [stamp({
        resourceType: 'Observation',
        id: effect.captureId,
        status: 'final',
        category: [conceptFor('observation-category', 'survey')],
        code: conceptFor('safety-flag', 'access-risk'),
        subject: subject() ? { reference: subject() } : undefined,
        ...(encountered() ? { encounter: { reference: encountered() } } : {}),
        effectiveDateTime: opts.issued ?? ctx.ingestedAt,
        extension: [
          { url: 'urn:ananthealth:fhir/StructureDefinition/synthetic-capture', valueBoolean: true },
          { url: 'urn:ananthealth:fhir/StructureDefinition/capture-provenance', valueString: effect.provenance },
          { url: 'urn:ananthealth:fhir/StructureDefinition/capture-baseline', valueBoolean: effect.baseline },
          { url: 'urn:ananthealth:fhir/StructureDefinition/feature-kind', valueString: effect.featureKind ?? 'mel-band-energies' },
        ],
      } as never, ctx)];
    }

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
    case 'result-lab': case 'record-vitals': case 'record-assessment': case 'record-immunisation': return ['Observation'];
    case 'update-care-plan': return ['CarePlan'];
    case 'submit-claim': case 'request-prior-auth': return ['Claim'];
    case 'open-ticket': return ['Task'];
    case 'flag-safety-event': return ['Flag'];
    case 'operator-directive': return ['CommunicationRequest'];
    // F7 — the renal effects no longer fall through to `[]`.
    case 'start-session': return ['Procedure'];
    case 'end-session': return ['Procedure', 'Observation'];
    case 'record-access': return ['Observation', 'Procedure', 'AdverseEvent'];
    // F8 — intra-session detail.
    case 'record-session-telemetry': return ['Observation'];
    case 'record-access-acoustic': return ['Observation'];
    default: return [];
  }
}
