// EffectReducer — the only path by which the world may change.
//
// A presence emits a WorldEffect. The reducer:
//   1. Authorizes the effect against the presence's role/clearance/authority
//   2. Applies entity mutations transactionally
//   3. Appends to the effect ledger
//   4. Broadcasts events to the perception router
//   5. Schedules ambient consequences (order-lab → mature-lab job, etc.)

import type { AgentPresence, EmittedEffect, EntityUrn, WorldEffect } from './types.js';
import type { EntityGraph } from './entity-graph.js';
import type { EffectLedger } from './effect-ledger.js';
import type { PerceptionRouter } from './perception.js';
import type { Clock } from './clock.js';

export interface EffectAuthorityMap {
  // Which roles are allowed to emit which effect kinds.
  [role: string]: Array<WorldEffect['kind']>;
}

export const DEFAULT_AUTHORITY: EffectAuthorityMap = {
  nurse: ['admit-patient', 'transfer-patient', 'administer-med', 'record-vitals', 'record-assessment', 'record-agent-thought', 'notify-staff', 'flag-safety-event', 'update-care-plan', 'result-lab'],
  md: ['admit-patient', 'transfer-patient', 'discharge-patient', 'order-lab', 'order-med', 'hold-med', 'titrate-med', 'update-care-plan', 'schedule-followup', 'notify-staff', 'flag-safety-event', 'record-agent-thought', 'record-assessment', 'record-vitals', 'result-lab'],
  pa: ['order-lab', 'order-med', 'titrate-med', 'update-care-plan', 'schedule-followup', 'notify-staff', 'record-agent-thought'],
  pharmacist: ['hold-med', 'titrate-med', 'notify-staff', 'flag-safety-event', 'record-agent-thought'],
  tech: ['administer-med', 'record-vitals', 'record-agent-thought', 'notify-staff'],
  coder: ['submit-claim', 'record-agent-thought'],
  ops: ['request-prior-auth', 'submit-claim', 'schedule-followup', 'notify-staff', 'record-agent-thought'],
  auditor: ['record-agent-thought', 'flag-safety-event'],
  admin: [] as WorldEffect['kind'][],
};

export interface ReducerOpts {
  /** In twin mode, effect kinds listed here are "bound" (touch external systems). Otherwise shadow. */
  boundEffects?: Set<WorldEffect['kind']>;
  /** Mode of the realm — sim always shadows because there are no external systems. */
  mode: 'sim' | 'twin';
  /** Ambient scheduler hook — called with (effect, emitted) so ambient processes can schedule follow-up work (e.g. mature-lab). */
  onEffectScheduled?: (effect: EmittedEffect) => void;
  /** Optional override for role authority. */
  authority?: EffectAuthorityMap;
}

export class EffectReducer {
  constructor(
    private readonly graph: EntityGraph,
    private readonly ledger: EffectLedger,
    private readonly router: PerceptionRouter,
    private readonly clock: Clock,
    private readonly opts: ReducerOpts,
  ) {}

  emit(presence: AgentPresence, effect: WorldEffect): EmittedEffect {
    const authority = this.opts.authority ?? DEFAULT_AUTHORITY;
    const allowed = authority[presence.role] ?? [];
    if (!allowed.includes(effect.kind)) {
      const rejected = this.ledger.append({
        presenceId: presence.presenceId,
        agentSpecId: presence.agentSpecId,
        realmAt: this.clock.realmAt.toISOString(),
        effect,
        status: 'rejected',
        rejection: `role '${presence.role}' not authorized for effect '${effect.kind}'`,
      });
      return rejected;
    }

    // Determine status
    const status: 'shadow' | 'bound' = this.opts.mode === 'sim'
      ? 'shadow'
      : (this.opts.boundEffects?.has(effect.kind) ? 'bound' : 'shadow');

    const emitted = this.ledger.append({
      presenceId: presence.presenceId,
      agentSpecId: presence.agentSpecId,
      realmAt: this.clock.realmAt.toISOString(),
      effect,
      status,
    });

    // Apply mutations
    const mutations = this.apply(presence, effect);
    this.ledger.attachMutations(emitted.effectId, mutations.map((m) => ({ urn: m.urn, patch: m.patch })));

    // Broadcast an effect.applied event
    const delivered = this.router.broadcast({
      kind: 'effect.applied',
      payload: { effectId: emitted.effectId, presenceId: presence.presenceId, agentSpecId: presence.agentSpecId, effect, status },
      realmAt: emitted.realmAt,
      facilityId: presence.location.facilityId,
      ...(presence.location.unitId ? { unitId: presence.location.unitId } : {}),
      ...(this.effectPatientId(effect) ? { patientId: this.effectPatientId(effect)!, entityKind: 'patient', entityId: this.effectPatientId(effect)! } : {}),
    });
    this.ledger.attachTriggeredEvents(emitted.effectId, delivered.map((d) => d.eventId));

    // Broadcast entity.updated events for each mutation
    for (const m of mutations) {
      this.router.broadcast({
        kind: 'entity.updated',
        entityUrn: m.urn,
        entityKind: m.kind,
        entityId: m.id,
        payload: { patch: m.patch, cause: `effect:${effect.kind}` },
        realmAt: emitted.realmAt,
        facilityId: presence.location.facilityId,
        ...(presence.location.unitId ? { unitId: presence.location.unitId } : {}),
      });
    }

    // Schedule ambient follow-ups
    if (this.opts.onEffectScheduled) this.opts.onEffectScheduled(emitted);

    return emitted;
  }

  private effectPatientId(effect: WorldEffect): string | undefined {
    return (effect as { patientId?: string }).patientId;
  }

  private apply(presence: AgentPresence, effect: WorldEffect): Array<{ urn: EntityUrn; kind: string; id: string; patch: Record<string, unknown> }> {
    const g = this.graph;
    const results: Array<{ urn: EntityUrn; kind: string; id: string; patch: Record<string, unknown> }> = [];
    const at = this.clock.realmAt.toISOString();

    switch (effect.kind) {
      case 'admit-patient': {
        const urn = g.urnFor('patient', effect.patientId);
        const rec = g.get(urn) ?? g.create('patient', effect.patientId, { admitted: true, facilityId: effect.facilityId, unitId: effect.unitId, admittedAt: at });
        const patch = { admitted: true, facilityId: effect.facilityId, unitId: effect.unitId, admittedAt: at, admissionReason: effect.reason };
        g.patch(rec.urn, patch, `effect:${effect.kind}`);
        results.push({ urn: rec.urn, kind: 'patient', id: rec.id, patch });
        return results;
      }
      case 'transfer-patient': {
        const urn = g.urnFor('patient', effect.patientId);
        if (!g.get(urn)) throw new Error(`transfer-target-missing: patient:${effect.patientId}`);
        const patch = { unitId: effect.toUnitId, previousUnitId: effect.fromUnitId, transferredAt: at };
        g.patch(urn, patch, `effect:${effect.kind}`);
        results.push({ urn, kind: 'patient', id: effect.patientId, patch });
        return results;
      }
      case 'discharge-patient': {
        const urn = g.urnFor('patient', effect.patientId);
        if (!g.get(urn)) throw new Error(`discharge-target-missing: patient:${effect.patientId}`);
        const patch = { admitted: false, disposition: effect.disposition, dischargedAt: at, dischargeReason: effect.reason };
        g.patch(urn, patch, `effect:${effect.kind}`);
        results.push({ urn, kind: 'patient', id: effect.patientId, patch });
        return results;
      }
      case 'order-lab': {
        const orderId = `${effect.patientId}-${effect.code}-${this.clock.seq}`;
        const rec = g.create('order', orderId, { kind: 'lab', code: effect.code, priority: effect.priority, patientId: effect.patientId, encounterId: effect.encounterId, status: 'ordered', orderedAt: at });
        results.push({ urn: rec.urn, kind: 'order', id: orderId, patch: rec.state });
        return results;
      }
      case 'result-lab': {
        const orderUrn = g.urnFor('order', effect.orderId);
        const order = g.get(orderUrn);
        if (order) g.patch(orderUrn, { status: 'resulted', resultedAt: at }, `effect:${effect.kind}`);
        const resultId = `${effect.orderId}-result`;
        const rec = g.create('result', resultId, { code: effect.code, value: effect.value, unit: effect.unit, abnormal: effect.abnormal, orderId: effect.orderId, at });
        if (order) g.addRelation(rec.urn, 'of-order', orderUrn);
        results.push({ urn: rec.urn, kind: 'result', id: resultId, patch: rec.state });
        return results;
      }
      case 'order-med': {
        const medOrderId = `${effect.patientId}-${effect.code}-${this.clock.seq}`;
        const rec = g.create('medication', medOrderId, { kind: 'order', code: effect.code, dose: effect.dose, route: effect.route, frequency: effect.frequency, indication: effect.indication, patientId: effect.patientId, status: 'active', orderedAt: at });
        results.push({ urn: rec.urn, kind: 'medication', id: medOrderId, patch: rec.state });
        return results;
      }
      case 'administer-med': {
        const urn = g.urnFor('medication', effect.medOrderId);
        if (!g.get(urn)) throw new Error(`med-order-missing: ${effect.medOrderId}`);
        const patch = { lastAdministeredAt: effect.givenAt, lastAdministeredDose: effect.dose };
        g.patch(urn, patch, `effect:${effect.kind}`);
        results.push({ urn, kind: 'medication', id: effect.medOrderId, patch });
        return results;
      }
      case 'hold-med': {
        const urn = g.urnFor('medication', effect.medOrderId);
        if (!g.get(urn)) throw new Error(`med-order-missing: ${effect.medOrderId}`);
        const patch = { status: 'held', holdReason: effect.reason, heldAt: at };
        g.patch(urn, patch, `effect:${effect.kind}`);
        results.push({ urn, kind: 'medication', id: effect.medOrderId, patch });
        return results;
      }
      case 'titrate-med': {
        const urn = g.urnFor('medication', effect.medOrderId);
        if (!g.get(urn)) throw new Error(`med-order-missing: ${effect.medOrderId}`);
        const patch = { titration: { delta: effect.delta, reason: effect.reason, at } };
        g.patch(urn, patch, `effect:${effect.kind}`);
        results.push({ urn, kind: 'medication', id: effect.medOrderId, patch });
        return results;
      }
      case 'record-vitals': {
        const patientUrn = g.urnFor('patient', effect.patientId);
        const patch = { lastVitals: { hr: effect.hr, bp: effect.bp, spo2: effect.spo2, temp: effect.temp, rr: effect.rr, at } };
        if (g.get(patientUrn)) g.patch(patientUrn, patch, `effect:${effect.kind}`);
        else g.create('patient', effect.patientId, patch);
        results.push({ urn: patientUrn, kind: 'patient', id: effect.patientId, patch });
        return results;
      }
      case 'record-assessment': {
        const patientUrn = g.urnFor('patient', effect.patientId);
        const patch = { lastAssessment: { id: effect.assessmentId, score: effect.score, band: effect.band, at } };
        if (g.get(patientUrn)) g.patch(patientUrn, patch, `effect:${effect.kind}`);
        else g.create('patient', effect.patientId, patch);
        results.push({ urn: patientUrn, kind: 'patient', id: effect.patientId, patch });
        return results;
      }
      case 'update-care-plan': {
        const patientUrn = g.urnFor('patient', effect.patientId);
        if (!g.get(patientUrn)) throw new Error(`patient-missing: ${effect.patientId}`);
        const patch = { carePlan: { ...(g.get(patientUrn)?.state as { carePlan?: Record<string, unknown> })?.carePlan, ...effect.patch, updatedAt: at } };
        g.patch(patientUrn, patch, `effect:${effect.kind}`);
        results.push({ urn: patientUrn, kind: 'patient', id: effect.patientId, patch });
        return results;
      }
      case 'schedule-followup': {
        const encId = `${effect.patientId}-followup-${this.clock.seq}`;
        const rec = g.create('encounter', encId, { kind: 'followup', patientId: effect.patientId, resource: effect.resource, followupKind: effect.followupKind, scheduledFor: effect.when, at });
        results.push({ urn: rec.urn, kind: 'encounter', id: encId, patch: rec.state });
        return results;
      }
      case 'notify-staff': {
        const noteId = `notify-${this.clock.seq}-${Math.random().toString(36).slice(2, 8)}`;
        const rec = g.create('agent-run', noteId, { kind: 'staff-notification', target: effect.targetRole, message: effect.message, priority: effect.priority, patientRef: effect.patientRef, at, presenceId: presence.presenceId });
        results.push({ urn: rec.urn, kind: 'agent-run', id: noteId, patch: rec.state });
        return results;
      }
      case 'flag-safety-event': {
        const patientUrn = g.urnFor('patient', effect.patientId);
        const flagId = `safety-${effect.patientId}-${this.clock.seq}`;
        const rec = g.create('agent-run', flagId, { kind: 'safety-flag', patientId: effect.patientId, safetyKind: effect.safetyKind, severity: effect.severity, at, presenceId: presence.presenceId });
        if (g.get(patientUrn)) g.addRelation(rec.urn, 'about-patient', patientUrn);
        results.push({ urn: rec.urn, kind: 'agent-run', id: flagId, patch: rec.state });
        return results;
      }
      case 'submit-claim': {
        const claimId = `claim-${effect.encounterId}-${this.clock.seq}`;
        const rec = g.create('insurance', claimId, { kind: 'claim', encounterId: effect.encounterId, payerId: effect.payerId, cptCodes: effect.cptCodes, icd10Codes: effect.icd10Codes, status: 'submitted', submittedAt: at });
        results.push({ urn: rec.urn, kind: 'insurance', id: claimId, patch: rec.state });
        return results;
      }
      case 'request-prior-auth': {
        const paId = `pa-${effect.patientId}-${effect.serviceCode}-${this.clock.seq}`;
        const rec = g.create('insurance', paId, { kind: 'prior-auth', patientId: effect.patientId, payerId: effect.payerId, serviceCode: effect.serviceCode, status: 'requested', requestedAt: at });
        results.push({ urn: rec.urn, kind: 'insurance', id: paId, patch: rec.state });
        return results;
      }
      case 'record-agent-thought': {
        const noteId = `thought-${presence.presenceId}-${this.clock.seq}-${Math.random().toString(36).slice(2, 8)}`;
        const rec = g.create('agent-run', noteId, { kind: 'thought', note: effect.note, presenceId: presence.presenceId, at });
        results.push({ urn: rec.urn, kind: 'agent-run', id: noteId, patch: rec.state });
        return results;
      }
      default: {
        const _exhaustive: never = effect;
        void _exhaustive;
        return results;
      }
    }
  }
}
