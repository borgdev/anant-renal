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

// Canonical → realm ingest bridge (Phase 2 consume path).
//
// FHIR hydration produces CanonicalEvent[] (see mapping.ts). This bridge
// applies them to a live realm:
//   • effect-able resources → WorldEffects via the ingest presence
//     (Encounter→admit/discharge, Observation lab→result-lab, vitals→record-vitals,
//      ServiceRequest→order-lab, MedicationRequest→order-med, CarePlan→update-care-plan)
//   • structural resources → direct EntityGraph upsert + hypergraph bridge
//     (Patient, Organization, Location, Practitioner, Device, Coverage, …)
// Both paths keep classification 'phi' and ride the existing PHI gates.

import type { Realm } from '../realm/realm.js';
import type { AgentPresence, EmittedEffect, EntityKind, EntityRecord } from '../realm/types.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { FhirCtx, FhirResource } from './types.js';
import { ENTITY_FHIR, entityKindFromResource, RESOURCE_TO_KIND } from './mapping.js';

export interface FhirIngestResult {
  resourceCount: number;
  effects: EmittedEffect[];
  structural: EntityRecord[];
  skipped: string[];
}

export interface FhirIngestOptions {
  realm: Realm;
  ctx: FhirCtx;
  presence: AgentPresence;
  events: readonly CanonicalEvent[];
  /** Default unit for structural/effect ingestion when the resource doesn't pin one. */
  defaultUnitId?: string;
}

function refId(ref: unknown): string | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as { reference?: string; id?: string };
  if (typeof r.id === 'string' && r.id) return r.id;
  if (typeof r.reference === 'string' && r.reference) {
    const slash = r.reference.indexOf('/');
    return slash >= 0 ? r.reference.slice(slash + 1) : r.reference;
  }
  return undefined;
}

function coding(resource: { code?: { coding?: Array<{ code?: string }> } }): string | undefined {
  return resource.code?.coding?.find((c) => c.code)?.code;
}

function category(resource: { category?: Array<{ coding?: Array<{ code?: string }>; text?: string }> }): string | undefined {
  const c = resource.category?.[0]?.coding?.[0]?.code;
  return c ?? resource.category?.[0]?.text;
}

/** Map a canonical event carrying a FHIR resource to WorldEffects the realm applies. */
function eventToEffects(evt: CanonicalEvent, opts: FhirIngestOptions): { effects?: Parameters<Realm['emit']>[1][]; skipped?: string } {
  const resource = (evt.payload as { fhir?: FhirResource }).fhir;
  if (!resource) return { skipped: `no-fhir-payload:${evt.type}` };
  const rt = resource.resourceType;
  const patientRef = refId((resource as { subject?: unknown }).subject);
  const defaultUnit = opts.defaultUnitId ?? 'U1';

  switch (rt) {
    case 'Encounter': {
      const enc = resource as { status?: string; hospitalization?: { dischargeDisposition?: { coding?: Array<{ code?: string }> } } };
      const status = enc.status;
      if (status === 'in-progress' || status === 'planned' || status === 'arrived' || status === 'triaged') {
        if (!patientRef) return { skipped: 'encounter-without-subject' };
        return { effects: [{ kind: 'admit-patient', patientId: patientRef, facilityId: opts.ctx.facilityId, unitId: defaultUnit }] };
      }
      if (status === 'finished') {
        if (!patientRef) return { skipped: 'encounter-without-subject' };
        const disp = enc.hospitalization?.dischargeDisposition?.coding?.[0]?.code;
        const disposition = disp === '01' ? 'home' : disp === '06' ? 'home-health' : disp === '03' ? 'snf' : disp === '50' ? 'hospice' : disp === '02' ? 'transfer' : disp === '07' ? 'ama' : disp === '20' ? 'expired' : 'home';
        return { effects: [{ kind: 'discharge-patient', patientId: patientRef, disposition: disposition as 'home' }] };
      }
      return { skipped: `encounter-status:${status ?? 'none'}` };
    }
    case 'ServiceRequest': {
      const sr = resource as { subject?: unknown; code?: { coding?: Array<{ code?: string }> }; priority?: string; encounter?: unknown };
      if (!patientRef) return { skipped: 'servicerequest-without-subject' };
      const code = coding(sr) ?? 'unknown';
      return { effects: [{ kind: 'order-lab', patientId: patientRef, code, priority: sr.priority === 'stat' ? 'stat' : sr.priority === 'urgent' ? 'send-out' : 'routine', ...(refId(sr.encounter) ? { encounterId: refId(sr.encounter)! } : {}) }] };
    }
    case 'MedicationRequest': {
      const mr = resource as { subject?: unknown; medicationCodeableConcept?: { coding?: Array<{ code?: string }> }; dosageInstruction?: Array<{ text?: string; timing?: { repeat?: { frequency?: number; periodUnit?: string } }; route?: { coding?: Array<{ code?: string }> }; doseAndRate?: Array<{ doseQuantity?: { value?: number; unit?: string } }> }> };
      if (!patientRef) return { skipped: 'medicationrequest-without-subject' };
      const code = mr.medicationCodeableConcept?.coding?.[0]?.code ?? 'unknown';
      const di = mr.dosageInstruction?.[0];
      const dose = di?.doseAndRate?.[0]?.doseQuantity ? `${di.doseAndRate[0].doseQuantity.value ?? ''} ${di.doseAndRate[0].doseQuantity.unit ?? ''}`.trim() : undefined;
      const route = di?.route?.coding?.[0]?.code;
      const frequency = di?.timing?.repeat?.frequency ? `Q${di.timing.repeat.frequency}H` : undefined;
      return { effects: [{ kind: 'order-med', patientId: patientRef, code, dose: dose ?? '', route: route ?? '', frequency: frequency ?? '' }] };
    }
    case 'Observation': {
      const obs = resource as { status?: string; category?: unknown; code?: unknown; valueQuantity?: { value?: number; unit?: string }; interpretation?: Array<{ coding?: Array<{ code?: string }> }>; basedOn?: Array<{ reference?: string }> };
      const cat = category(obs as { category?: Array<{ coding?: Array<{ code?: string }> }> });
      const code = coding(obs as { code?: { coding?: Array<{ code?: string }> } }) ?? 'unknown';
      if (cat === 'vital-signs') {
        if (!patientRef) return { skipped: 'vitals-without-subject' };
        const vitals: Record<string, number | undefined> = {};
        const loincToKey: Record<string, 'hr' | 'spo2' | 'temp' | 'rr'> = { '8867-4': 'hr', '2708-6': 'spo2', '8310-5': 'temp', '9279-1': 'rr' };
        const key = loincToKey[code];
        if (key && obs.valueQuantity?.value !== undefined) vitals[key] = obs.valueQuantity.value;
        if (code === '55284-4' && obs.valueQuantity?.value !== undefined) vitals['bp'] = obs.valueQuantity.value;
        return { effects: [{ kind: 'record-vitals', patientId: patientRef, ...vitals }] };
      }
      // laboratory → result-lab
      if (!patientRef) return { skipped: 'lab-without-subject' };
      const orderRef = obs.basedOn?.[0]?.reference ? refId(obs.basedOn[0].reference) : undefined;
      const abnormal = obs.interpretation?.[0]?.coding?.[0]?.code;
      return { effects: [{ kind: 'result-lab', orderId: orderRef ?? `result:${resource.id ?? code}`, code, value: obs.valueQuantity?.value ?? '', unit: obs.valueQuantity?.unit ?? '', ...(abnormal ? { abnormal: abnormal as 'H' } : {}) }] };
    }
    case 'CarePlan': {
      const cp = resource as { subject?: unknown; title?: string };
      if (!patientRef) return { skipped: 'careplan-without-subject' };
      return { effects: [{ kind: 'update-care-plan', patientId: patientRef, patch: { title: cp.title ?? 'care plan' } }] };
    }
    default:
      return { skipped: `no-effect-for:${rt}` };
  }
}

/** Structural kind → state shape for direct graph upsert (patient, org, unit, staff, equipment, insurance). */
function structuralState(kind: EntityKind, resource: FhirResource): Record<string, unknown> {
  switch (kind) {
    case 'patient': {
      const p = resource as { name?: Array<{ family?: string; given?: string[] }>; gender?: string; birthDate?: string; identifier?: Array<{ value?: string }>; managingOrganization?: { reference?: string } };
      return {
        name: p.name?.[0] ? [p.name[0].family, ...(p.name[0].given ?? [])].filter(Boolean).join(' ') : undefined,
        sex: p.gender,
        birthDate: p.birthDate,
        mrn: p.identifier?.[0]?.value ?? resource.id,
        facilityId: refId(p.managingOrganization) ?? undefined,
      };
    }
    case 'org-node': {
      const o = resource as { name?: string; type?: Array<{ coding?: Array<{ code?: string }> }>; partOf?: { reference?: string } };
      return { name: o.name ?? resource.id, nodeKind: o.type?.[0]?.coding?.[0]?.code ?? 'dept', parentId: refId(o.partOf) ?? undefined };
    }
    case 'unit': {
      const l = resource as { name?: string; partOf?: { reference?: string } };
      return { code: l.name ?? resource.id, facilityId: refId(l.partOf) ?? undefined };
    }
    case 'staff': {
      const pr = resource as { name?: Array<{ family?: string }>; identifier?: Array<{ value?: string }>; role?: unknown };
      return { name: pr.name?.[0]?.family ?? resource.id, npi: pr.identifier?.[0]?.value ?? resource.id, role: (resource as { role?: unknown }).role ?? 'staff' };
    }
    case 'equipment': {
      const d = resource as { serialNumber?: string; type?: { coding?: Array<{ code?: string }> }; patient?: { reference?: string } };
      return { kind: d.type?.coding?.[0]?.code ?? 'device', serial: d.serialNumber ?? resource.id, assignedPatientId: refId(d.patient) ?? undefined };
    }
    case 'insurance': {
      const c = resource as { identifier?: Array<{ value?: string }>; beneficiary?: { reference?: string }; payor?: Array<{ reference?: string }>; period?: { start?: string; end?: string }; status?: string };
      return {
        policyNumber: c.identifier?.[0]?.value ?? resource.id,
        patientId: refId(c.beneficiary) ?? undefined,
        payerId: refId(c.payor?.[0]) ?? undefined,
        effectiveStart: c.period?.start, effectiveEnd: c.period?.end,
        status: c.status ?? 'active',
        kind: 'claim' in resource ? 'claim' : undefined,
      };
    }
    // ---- M24: clinical record family ----
    case 'condition': {
      const c = resource as { code?: { coding?: Array<{ code?: string; system?: string; display?: string }> }; clinicalStatus?: unknown; verificationStatus?: unknown; category?: unknown; severity?: unknown; subject?: unknown; encounter?: unknown; onsetDateTime?: string; abatementDateTime?: string; recordedDate?: string };
      const cd = c.code?.coding?.[0];
      return {
        code: cd?.code ?? coding(c as { code?: { coding?: Array<{ code?: string }> } }) ?? resource.id,
        codeSystem: cd?.system, display: cd?.display,
        clinicalStatus: codingPath(c.clinicalStatus), verificationStatus: codingPath(c.verificationStatus),
        category: codingPath(c.category), severity: codingPath(c.severity),
        patientId: refId(c.subject) ?? undefined, encounterId: refId(c.encounter) ?? undefined,
        onset: c.onsetDateTime, abatement: c.abatementDateTime, recordedAt: c.recordedDate,
      };
    }
    case 'allergy': {
      const a = resource as { code?: { coding?: Array<{ code?: string; display?: string }> }; clinicalStatus?: unknown; verificationStatus?: unknown; type?: string; category?: Array<'food' | 'medication' | 'environment' | 'biologic'>; criticality?: string; patient?: unknown; onsetDateTime?: string; recordedDate?: string };
      return {
        code: a.code?.coding?.[0]?.code ?? resource.id,
        display: a.code?.coding?.[0]?.display,
        clinicalStatus: codingPath(a.clinicalStatus), verificationStatus: codingPath(a.verificationStatus),
        type: a.type, category: a.category, criticality: a.criticality,
        patientId: refId(a.patient) ?? undefined, onset: a.onsetDateTime, recordedAt: a.recordedDate,
      };
    }
    case 'procedure': {
      const p = resource as { status?: string; code?: { coding?: Array<{ code?: string; system?: string; display?: string }> }; category?: unknown; subject?: unknown; encounter?: unknown; performedDateTime?: string; outcome?: unknown; reasonCode?: unknown };
      return {
        status: p.status ?? 'completed',
        code: p.code?.coding?.[0]?.code ?? resource.id,
        codeSystem: p.code?.coding?.[0]?.system, display: p.code?.coding?.[0]?.display,
        category: codingPath(p.category), outcome: codingPath(p.outcome), reasonCode: codingPath(p.reasonCode),
        patientId: refId(p.subject) ?? undefined, encounterId: refId(p.encounter) ?? undefined,
        performedAt: p.performedDateTime,
      };
    }
    case 'immunization': {
      const im = resource as { status?: string; vaccineCode?: { coding?: Array<{ code?: string; display?: string }> }; patient?: unknown; occurrenceDateTime?: string; lotNumber?: string; site?: unknown; route?: unknown; doseQuantity?: { value?: number; unit?: string }; recorded?: string };
      return {
        status: im.status ?? 'completed',
        vaccineCode: im.vaccineCode?.coding?.[0]?.code ?? resource.id,
        display: im.vaccineCode?.coding?.[0]?.display,
        patientId: refId(im.patient) ?? undefined,
        occurrence: im.occurrenceDateTime, lotNumber: im.lotNumber,
        site: codingPath(im.site), route: codingPath(im.route),
        dose: im.doseQuantity?.value, unit: im.doseQuantity?.unit, recorded: im.recorded,
      };
    }
    case 'diagnostic-report': {
      const d = resource as { status?: string; code?: { coding?: Array<{ code?: string; system?: string; display?: string }> }; category?: unknown; subject?: unknown; encounter?: unknown; effectiveDateTime?: string; issued?: string; result?: Array<{ reference?: string }>; conclusion?: string };
      return {
        status: d.status ?? 'final',
        code: d.code?.coding?.[0]?.code ?? resource.id,
        codeSystem: d.code?.coding?.[0]?.system, display: d.code?.coding?.[0]?.display,
        category: codingPath(d.category),
        patientId: refId(d.subject) ?? undefined, encounterId: refId(d.encounter) ?? undefined,
        effectiveAt: d.effectiveDateTime, issuedAt: d.issued,
        resultIds: (d.result ?? []).map((r) => refId(r)).filter(Boolean),
        conclusion: d.conclusion,
      };
    }
    case 'medication-admin': {
      const m = resource as { status?: string; medicationCodeableConcept?: { coding?: Array<{ code?: string; display?: string }> }; subject?: unknown; context?: unknown; effectiveDateTime?: string; request?: unknown; dosage?: { route?: unknown; dose?: { value?: number; unit?: string } } };
      return {
        status: m.status ?? 'completed',
        code: m.medicationCodeableConcept?.coding?.[0]?.code ?? resource.id,
        display: m.medicationCodeableConcept?.coding?.[0]?.display,
        patientId: refId(m.subject) ?? undefined, contextId: refId(m.context) ?? undefined,
        effectiveAt: m.effectiveDateTime, requestId: refId(m.request) ?? undefined,
        route: codingPath(m.dosage?.route), dose: m.dosage?.dose?.value, unit: m.dosage?.dose?.unit,
      };
    }
    // ---- M24: care-coordination family ----
    case 'questionnaire-response': {
      const q = resource as { status?: string; questionnaire?: string; subject?: unknown; encounter?: unknown; authored?: string; author?: unknown; item?: unknown };
      return {
        status: q.status ?? 'completed', questionnaire: q.questionnaire,
        subjectId: refId(q.subject) ?? undefined, encounterId: refId(q.encounter) ?? undefined,
        authoredAt: q.authored, authorRef: refId(q.author), items: q.item,
      };
    }
    case 'document-reference': {
      const dr = resource as { status?: string; type?: unknown; category?: unknown; subject?: unknown; date?: string; author?: Array<unknown>; description?: string; content?: Array<{ attachment?: { contentType?: string; url?: string; title?: string } }> };
      const att = dr.content?.[0]?.attachment;
      return {
        status: dr.status ?? 'current', type: codingPath(dr.type), category: codingPath(dr.category),
        subjectId: refId(dr.subject) ?? undefined, date: dr.date, authorRef: refId(dr.author?.[0]),
        description: dr.description, contentType: att?.contentType, url: att?.url, title: att?.title,
      };
    }
    case 'communication': {
      const cm = resource as { status?: string; category?: unknown; priority?: string; subject?: unknown; sent?: string; received?: string; recipient?: Array<unknown>; sender?: unknown; payload?: Array<{ contentString?: string }> };
      return {
        status: cm.status ?? 'completed', category: codingPath(cm.category), priority: cm.priority,
        subjectId: refId(cm.subject) ?? undefined, sentAt: cm.sent, receivedAt: cm.received,
        recipientRef: refId(cm.recipient?.[0]), senderRef: refId(cm.sender),
        payloadText: cm.payload?.[0]?.contentString,
      };
    }
    case 'appointment': {
      const ap = resource as { status?: string; serviceType?: unknown; reasonCode?: unknown; start?: string; end?: string; minutesDuration?: number; description?: string; created?: string; participant?: Array<{ actor?: unknown }> };
      return {
        status: ap.status ?? 'booked', serviceType: codingPath(ap.serviceType), reasonCode: codingPath(ap.reasonCode),
        start: ap.start, end: ap.end, minutesDuration: ap.minutesDuration, description: ap.description, created: ap.created,
        patientId: refId(ap.participant?.[0]?.actor) ?? undefined,
      };
    }
    case 'schedule': {
      const s = resource as { active?: boolean; serviceType?: unknown; specialty?: unknown; actor?: Array<unknown>; planningHorizon?: { start?: string; end?: string } };
      return {
        active: s.active, serviceType: codingPath(s.serviceType), specialty: codingPath(s.specialty),
        actorRef: refId(s.actor?.[0]), horizonStart: s.planningHorizon?.start, horizonEnd: s.planningHorizon?.end,
      };
    }
    case 'slot': {
      const sl = resource as { status?: string; serviceType?: unknown; schedule?: unknown; start?: string; end?: string; overbooked?: boolean };
      return {
        status: sl.status ?? 'free', serviceType: codingPath(sl.serviceType),
        scheduleId: refId(sl.schedule) ?? undefined, start: sl.start, end: sl.end, overbooked: sl.overbooked,
      };
    }
    // ---- M24: payer/ops family ----
    case 'explanation-of-benefit': {
      const e = resource as { status?: string; use?: string; type?: unknown; patient?: unknown; insurer?: unknown; provider?: unknown; created?: string; outcome?: string; disposition?: string; total?: Array<{ amount?: { value?: number; currency?: string } }>; payment?: { amount?: { value?: number; currency?: string } } };
      return {
        status: e.status ?? 'active', use: e.use ?? 'claim', type: codingPath(e.type),
        patientId: refId(e.patient) ?? undefined, insurerId: refId(e.insurer) ?? undefined, providerId: refId(e.provider) ?? undefined,
        created: e.created, outcome: e.outcome, disposition: e.disposition,
        totalAmount: e.total?.[0]?.amount?.value, paymentAmount: e.payment?.amount?.value,
        currency: e.total?.[0]?.amount?.currency ?? e.payment?.amount?.currency,
      };
    }
    case 'invoice': {
      const i = resource as { status?: string; type?: unknown; subject?: unknown; recipient?: unknown; date?: string; issuer?: unknown; totalNet?: { value?: number; currency?: string }; totalGross?: { value?: number; currency?: string } };
      return {
        status: i.status ?? 'issued', type: codingPath(i.type),
        subjectId: refId(i.subject) ?? undefined, recipientRef: refId(i.recipient), date: i.date, issuerRef: refId(i.issuer),
        totalNet: i.totalNet?.value, totalGross: i.totalGross?.value, currency: i.totalNet?.currency ?? i.totalGross?.currency,
      };
    }
    case 'account': {
      const ac = resource as { status?: string; type?: unknown; name?: string; subject?: Array<{ reference?: string }>; owner?: unknown; description?: string; period?: { start?: string; end?: string } };
      const subj = ac.subject?.[0];
      return {
        status: ac.status ?? 'active', type: codingPath(ac.type), name: ac.name,
        subjectRef: subj?.reference ?? refId(subj), ownerRef: refId(ac.owner), description: ac.description,
        periodStart: ac.period?.start, periodEnd: ac.period?.end,
      };
    }
    // ---- C batch: payer remittance, care-team, goals, subscription, forms, consent ----
    case 'claim-response': {
      const c = resource as { status?: string; use?: string; type?: unknown; patient?: unknown; created?: string; insurer?: unknown; outcome?: string; disposition?: string; total?: Array<{ amount?: { value?: number; currency?: string } }>; payment?: { amount?: { value?: number; currency?: string } } };
      return {
        status: c.status ?? 'active', use: c.use ?? 'claim', type: codingPath(c.type),
        patientId: refId(c.patient) ?? undefined, created: c.created, insurerId: refId(c.insurer) ?? undefined,
        outcome: c.outcome, disposition: c.disposition,
        totalAmount: c.total?.[0]?.amount?.value, paymentAmount: c.payment?.amount?.value,
        currency: c.total?.[0]?.amount?.currency ?? c.payment?.amount?.currency,
      };
    }
    case 'care-team': {
      const ct = resource as { status?: string; name?: string; subject?: unknown; encounter?: unknown; participant?: Array<{ member?: unknown }> };
      return {
        status: ct.status ?? 'active', name: ct.name,
        patientId: refId(ct.subject) ?? undefined, encounterId: refId(ct.encounter) ?? undefined,
        memberRef: refId(ct.participant?.[0]?.member),
      };
    }
    case 'goal': {
      const g = resource as { lifecycleStatus?: string; description?: { coding?: Array<{ code?: string; display?: string }> }; subject?: unknown; startDate?: string; target?: Array<{ measure?: unknown; detailQuantity?: { value?: number; unit?: string } }> };
      const t = g.target?.[0];
      return {
        lifecycleStatus: g.lifecycleStatus ?? 'active',
        code: g.description?.coding?.[0]?.code, description: g.description?.coding?.[0]?.display,
        patientId: refId(g.subject) ?? undefined, startDate: g.startDate,
        measureCode: codingPath(t?.measure), targetValue: t?.detailQuantity?.value, targetUnit: t?.detailQuantity?.unit,
      };
    }
    case 'subscription': {
      const s = resource as { status?: string; reason?: string; criteria?: string; end?: string; channel?: { type?: string; endpoint?: string; payload?: string } };
      return {
        status: s.status ?? 'active', reason: s.reason, criteria: s.criteria, end: s.end,
        channelType: s.channel?.type, endpoint: s.channel?.endpoint, payload: s.channel?.payload,
      };
    }
    case 'questionnaire': {
      const q = resource as { status?: string; title?: string; name?: string; url?: string; version?: string; item?: unknown };
      return { status: q.status ?? 'active', title: q.title, name: q.name, url: q.url, version: q.version, items: q.item };
    }
    case 'consent': {
      const cs = resource as { status?: string; scope?: unknown; category?: unknown; patient?: unknown; dateTime?: string; provision?: { type?: string } };
      return {
        status: cs.status ?? 'active', scope: codingPath(cs.scope), category: codingPath(cs.category),
        patientId: refId(cs.patient) ?? undefined, dateTime: cs.dateTime, provisionType: cs.provision?.type,
      };
    }
    // ---- D batch ----
    case 'adverse-event': {
      const a = resource as { status?: string; event?: unknown; subject?: unknown; date?: string; seriousness?: unknown; actuality?: string };
      return {
        status: a.status ?? 'available', code: codingPath(a.event), display: codingPath(a.event),
        patientId: refId(a.subject) ?? undefined, date: a.date, seriousness: codingPath(a.seriousness), actuality: a.actuality,
      };
    }
    case 'medication-statement': {
      const m = resource as { status?: string; medicationCodeableConcept?: unknown; subject?: unknown; effectiveDateTime?: string; dateAsserted?: string };
      return {
        status: m.status ?? 'active', code: codingPath(m.medicationCodeableConcept),
        patientId: refId(m.subject) ?? undefined, effectiveAt: m.effectiveDateTime, dateAsserted: m.dateAsserted,
      };
    }
    case 'medication-dispense': {
      const m = resource as { status?: string; medicationCodeableConcept?: unknown; subject?: unknown; quantity?: { value?: number; unit?: string }; whenPrepared?: string; whenHandedOver?: string; authorizingPrescription?: Array<unknown> };
      return {
        status: m.status ?? 'completed', code: codingPath(m.medicationCodeableConcept),
        patientId: refId(m.subject) ?? undefined,
        quantity: m.quantity?.value, unit: m.quantity?.unit,
        whenPrepared: m.whenPrepared, whenHandedOver: m.whenHandedOver,
        requestId: refId(m.authorizingPrescription?.[0]),
      };
    }
    case 'imaging-study': {
      const im = resource as { status?: string; subject?: unknown; started?: string; series?: Array<{ modality?: { coding?: Array<{ code?: string }> } }> };
      return {
        status: im.status ?? 'completed', patientId: refId(im.subject) ?? undefined, started: im.started,
        modality: codingPath(im.series?.[0]?.modality),
      };
    }
    case 'specimen': {
      const sp = resource as { status?: string; type?: unknown; subject?: unknown; collectedDateTime?: string; receivedTime?: string };
      return {
        status: sp.status ?? 'available', type: codingPath(sp.type),
        patientId: refId(sp.subject) ?? undefined, collectedAt: sp.collectedDateTime, receivedAt: sp.receivedTime,
      };
    }
    case 'detected-issue': {
      const di = resource as { status?: string; code?: unknown; severity?: string; patient?: unknown; identifiedDateTime?: string; detail?: string };
      return {
        status: di.status ?? 'final', code: codingPath(di.code), severity: di.severity,
        patientId: refId(di.patient) ?? undefined, identifiedAt: di.identifiedDateTime, detail: di.detail,
      };
    }
    case 'payment-reconciliation': {
      const pr = resource as { status?: string; created?: string; disposition?: string; paymentAmount?: { value?: number; currency?: string }; paymentDate?: string };
      return {
        status: pr.status ?? 'active', created: pr.created, disposition: pr.disposition,
        paymentAmount: pr.paymentAmount?.value, currency: pr.paymentAmount?.currency, paymentDate: pr.paymentDate,
      };
    }
    case 'composition': {
      const co = resource as { status?: string; type?: unknown; subject?: unknown; date?: string; title?: string; author?: Array<unknown>; section?: Array<{ title?: string; text?: { div?: string } }> };
      return {
        status: co.status ?? 'final', type: codingPath(co.type),
        patientId: refId(co.subject) ?? undefined, date: co.date, title: co.title,
        authorRef: refId(co.author?.[0]),
        sectionTitle: co.section?.[0]?.title, sectionText: co.section?.[0]?.text?.div,
      };
    }
    // ---- D4 batch ----
    case 'vision-prescription': {
      const v = resource as { status?: string; patient?: unknown; created?: string; dateWritten?: string; prescriber?: unknown; lensSpecification?: Array<{ product?: unknown; eye?: string }> };
      return {
        status: v.status ?? 'active', patientId: refId(v.patient) ?? undefined, created: v.created, dateWritten: v.dateWritten,
        prescriberRef: refId(v.prescriber), product: codingPath(v.lensSpecification?.[0]?.product), eye: v.lensSpecification?.[0]?.eye,
      };
    }
    case 'device-use': {
      const d = resource as { status?: string; subject?: unknown; device?: unknown; recordedOn?: string; reasonCode?: Array<unknown> };
      return {
        status: d.status ?? 'active', patientId: refId(d.subject) ?? undefined, deviceId: refId(d.device),
        recordedOn: d.recordedOn, code: codingPath(d.reasonCode?.[0]),
      };
    }
    case 'nutrition-order': {
      const n = resource as { status?: string; patient?: unknown; dateTime?: string; orderer?: unknown; oralDiet?: { type?: Array<unknown> } };
      return {
        status: n.status ?? 'active', patientId: refId(n.patient) ?? undefined, dateTime: n.dateTime,
        ordererRef: refId(n.orderer), dietType: codingPath(n.oralDiet?.type?.[0]),
      };
    }
    case 'supply-delivery': {
      const s = resource as { status?: string; patient?: unknown; type?: unknown; quantity?: { value?: number; unit?: string }; suppliedItem?: { itemCodeableConcept?: unknown }; occurrenceDateTime?: string };
      return {
        status: s.status, patientId: refId(s.patient) ?? undefined, type: codingPath(s.type),
        quantity: s.quantity?.value, unit: s.quantity?.unit, code: codingPath(s.suppliedItem?.itemCodeableConcept),
        occurrence: s.occurrenceDateTime,
      };
    }
    case 'healthcare-service': {
      const h = resource as { active?: boolean; providedBy?: unknown; category?: Array<unknown>; name?: string; location?: Array<unknown>; endpoint?: Array<unknown> };
      return {
        active: h.active, orgId: refId(h.providedBy), category: codingPath(h.category?.[0]), name: h.name,
        facilityId: refId(h.location?.[0]), endpointId: refId(h.endpoint?.[0]),
      };
    }
    case 'endpoint': {
      const e = resource as { status?: string; connectionType?: unknown; name?: string; address?: string; payloadType?: Array<unknown> };
      return {
        status: e.status ?? 'active', connectionType: codingPath(e.connectionType), name: e.name, address: e.address,
        payloadType: codingPath(e.payloadType?.[0]),
      };
    }
    case 'org-affiliation': {
      const o = resource as { active?: boolean; organization?: unknown; participatingOrganization?: unknown; code?: Array<unknown>; specialty?: Array<unknown>; healthcareService?: Array<unknown> };
      return {
        active: o.active, orgId: refId(o.organization), participantOrgId: refId(o.participatingOrganization),
        code: codingPath(o.code?.[0]), specialty: codingPath(o.specialty?.[0]), serviceId: refId(o.healthcareService?.[0]),
      };
    }
    case 'substance': {
      const su = resource as { status?: string; code?: unknown; description?: string };
      return { status: su.status, code: codingPath(su.code), description: su.description };
    }
    default:
      return {};
  }
}

/** Extract the first coding code from any CodeableConcept-ish shape (or a string). */
function codingPath(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return undefined;
  const cc = v as { coding?: Array<{ code?: string }>; text?: string };
  return cc.coding?.[0]?.code ?? cc.text;
}

/** Apply a structural resource directly to the graph + hypergraph bridge. */
function upsertStructural(realm: Realm, kind: EntityKind, id: string, state: Record<string, unknown>): EntityRecord | undefined {
  const graph = realm.graph;
  const urn = graph.urnFor(kind, id);
  const existing = graph.get(urn);
  const clean = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined && v !== null));
  const rec = existing
    ? graph.patch(urn, clean as Record<string, unknown>, 'fhir-ingest')
    : graph.create(kind, id, clean as Record<string, unknown>);
  // ride the Phase 1b hypergraph bridge so ingested entities become nodes too.
  if (realm.hypergraph) realm.hypergraph.upsertEntity(rec as EntityRecord);
  return rec as EntityRecord;
}

function resourceKind(resource: FhirResource): EntityKind | undefined {
  return RESOURCE_TO_KIND[resource.resourceType] ?? entityKindFromResource(resource.resourceType);
}

/** A resource that maps to a structural kind AND carries an id (direct graph upsert, not an effect). */
function isStructuralResource(resource: FhirResource): boolean {
  const kind = resourceKind(resource);
  return !!kind && isStructuralKind(kind) && !!resource.id;
}

function applyStructural(realm: Realm, kind: EntityKind, resource: FhirResource): EntityRecord | undefined {
  const state = structuralState(kind, resource);
  if (Object.keys(state).length === 0) return undefined;
  return upsertStructural(realm, kind, resource.id!, state);
}

/** Apply a single FHIR resource to a realm — structural upsert OR effect emission (Phase A two-pass building block). */
export function ingestResource(
  opts: FhirIngestOptions,
  resource: FhirResource,
): { structural?: EntityRecord; effects?: EmittedEffect[]; skipped?: string } {
  const { realm, ctx, presence } = opts;
  const kind = resourceKind(resource);
  if (kind && isStructuralKind(kind) && resource.id) {
    const structural = applyStructural(realm, kind, resource);
    if (structural) return { structural };
    return { skipped: `no-structural-state:${resource.resourceType}` };
  }
  const mapping = ENTITY_FHIR[kind as EntityKind];
  if (!mapping) return { skipped: `no-mapping:${resource.resourceType}` };
  const events = mapping.hydrate(resource, ctx);
  const effects: EmittedEffect[] = [];
  for (const evt of events) {
    const mapped = eventToEffects(evt, opts);
    if (mapped.skipped) return { skipped: mapped.skipped };
    for (const effect of mapped.effects ?? []) {
      effects.push(realm.emit(presence.presenceId, effect));
    }
  }
  return { effects };
}

/** Apply FHIR-derived canonical events to a live realm (structural-first so effects always reference live entities). */
export function ingestCanonicalEvents(opts: FhirIngestOptions): FhirIngestResult {
  const { realm, ctx, presence, events } = opts;
  const result: FhirIngestResult = { resourceCount: 0, effects: [], structural: [], skipped: [] };

  const resources: FhirResource[] = [];
  for (const evt of events) {
    const resource = (evt.payload as { fhir?: FhirResource }).fhir;
    if (!resource) { result.skipped.push(`no-fhir:${evt.type}`); continue; }
    resources.push(resource);
  }
  result.resourceCount = resources.length;

  // Pass 1 — structural resources first, so effect-able resources (order-lab,
  // admit-patient, result-lab, …) always reference entities that already exist.
  for (const resource of resources) {
    if (!isStructuralResource(resource)) continue;
    const out = ingestResource(opts, resource);
    if (out.structural) result.structural.push(out.structural);
    else if (out.skipped) result.skipped.push(out.skipped);
  }
  // Pass 2 — effect-able resources.
  for (const resource of resources) {
    if (isStructuralResource(resource)) continue;
    const out = ingestResource(opts, resource);
    if (out.effects) result.effects.push(...out.effects);
    else if (out.skipped) result.skipped.push(out.skipped);
  }
  return result;
}

export function isStructuralKind(kind: EntityKind): boolean {
  return [
    'patient', 'facility', 'unit', 'org-node', 'staff', 'equipment', 'insurance', 'physical-object',
    'condition', 'allergy', 'procedure', 'immunization', 'diagnostic-report', 'medication-admin',
    'questionnaire-response', 'document-reference', 'communication', 'appointment', 'schedule', 'slot',
    'explanation-of-benefit', 'invoice', 'account',
    'claim-response', 'care-team', 'goal', 'subscription', 'questionnaire', 'consent',
    'adverse-event', 'medication-statement', 'medication-dispense', 'imaging-study', 'specimen', 'detected-issue', 'payment-reconciliation', 'composition',
    'vision-prescription', 'device-use', 'nutrition-order', 'supply-delivery', 'healthcare-service', 'endpoint', 'org-affiliation', 'substance',
  ].includes(kind);
}
