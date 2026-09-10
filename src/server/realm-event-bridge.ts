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

// Realm → broker bridge (Phase 3). Projects every EmittedEffect in a live realm
// to a CanonicalEvent and publishes it to the EventBroker — so simulations emit
// to Kafka/RabbitMQ/Redis/etc. as well as the SSE stream. Durable when given an
// outbox (enqueue + flush rides the transactional-outbox path), else direct
// publish. Tracks per-bridge stats for the admin panel.

import type { EmittedEffect } from '../realm/types.js';
import type { Realm } from '../realm/realm.js';
import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';
import { EVENT_TOPIC_EVENTS, type EventBroker } from './event-broker.js';
import type { EventOutbox } from './event-outbox.js';

/** Map a WorldEffect kind to the canonical event type downstream consumers expect. */
export function effectKindToEventType(kind: EmittedEffect['effect']['kind']): CanonicalEventType {
  switch (kind) {
    case 'admit-patient': return 'hospitalization.admitted';
    case 'discharge-patient': return 'hospitalization.discharged';
    case 'transfer-patient': return 'hospitalization.transfer';
    case 'order-lab': return 'treatment.scheduled';
    case 'result-lab': return 'lab.result-arrived';
    case 'record-vitals': return 'vital.observed';
    case 'record-assessment': return 'condition.recorded';
    case 'record-immunisation': return 'immunization.recorded';
    case 'order-med': return 'medication.ordered';
    case 'submit-claim': return 'claim.submitted';
    case 'request-prior-auth': return 'prior-auth.submitted';
    case 'update-care-plan': return 'encounter.summary';
    case 'schedule-followup': return 'treatment.scheduled';
    case 'flag-safety-event': return 'protocol.deviation';
    case 'open-ticket': return 'condition.recorded';
    default: return 'treatment.scheduled';
  }
}

export interface EffectToEventContext {
  realmId: string;
  facilityId: string;
  scopeId: string;
  sourceId?: string;
}

/** Project an EmittedEffect → CanonicalEvent (the realm's own write path). */
export function effectToCanonicalEvent(emitted: EmittedEffect, ctx: EffectToEventContext): CanonicalEvent {
  const effect = emitted.effect as { patientId?: string; [k: string]: unknown };
  return {
    id: `event:realm:${ctx.realmId}:${emitted.effectId}`,
    type: effectKindToEventType(emitted.effect.kind),
    occurredAt: emitted.realmAt,
    scopeId: ctx.scopeId,
    subjectId: effect.patientId ?? emitted.presenceId ?? 'unknown',
    facilityId: ctx.facilityId,
    payload: { effect: emitted.effect, effectId: emitted.effectId, agentSpecId: emitted.agentSpecId, presenceId: emitted.presenceId, status: emitted.status, realmId: ctx.realmId },
    provenance: { sourceId: ctx.sourceId ?? `realm:${ctx.realmId}`, observedAt: emitted.realmAt, ingestedAt: emitted.emittedAt },
    classification: 'phi',
  };
}

export interface RealmEventBridgeOptions {
  readonly broker: EventBroker;
  readonly outbox?: EventOutbox;
  readonly topic?: string;
  /** Publish only accepted effects (shadow/bound); skip rejected/suspended. */
  readonly skipRejected?: boolean;
  readonly onEvent?: (event: CanonicalEvent) => void;
}

export interface RealmEventBridgeStats {
  readonly attached: number;
  readonly projected: number;
  readonly published: number;
  readonly failed: number;
}

export class RealmEventBridge {
  private readonly broker: EventBroker;
  private readonly outbox: EventOutbox | undefined;
  private readonly topic: string;
  private readonly skipRejected: boolean;
  private readonly onEvent: ((event: CanonicalEvent) => void) | undefined;
  private readonly attached = new Map<string, () => void>();
  private stats: RealmEventBridgeStats = { attached: 0, projected: 0, published: 0, failed: 0 };

  constructor(opts: RealmEventBridgeOptions) {
    this.broker = opts.broker;
    this.outbox = opts.outbox;
    this.topic = opts.topic ?? EVENT_TOPIC_EVENTS;
    this.skipRejected = opts.skipRejected ?? true;
    this.onEvent = opts.onEvent;
  }

  /** Subscribe a realm's effect ledger to the bridge; returns a detach fn. */
  attach(realm: Realm): () => void {
    if (this.attached.has(realm.id)) return () => this.detach(realm.id);
    const facilityId = realm.graph.listKind('facility')[0]?.state['id'] as string | undefined ?? 'f1';
    const detach = realm.ledger.onAppend((emitted) => {
      if (this.skipRejected && emitted.status === 'rejected') return;
      void this.project(realm.id, emitted, facilityId);
    });
    this.attached.set(realm.id, detach);
    this.stats = { ...this.stats, attached: this.attached.size };
    return () => this.detach(realm.id);
  }

  detach(realmId: string): void {
    const detach = this.attached.get(realmId);
    if (detach) { detach(); this.attached.delete(realmId); }
    this.stats = { ...this.stats, attached: this.attached.size };
  }

  private async project(realmId: string, emitted: EmittedEffect, facilityId: string): Promise<void> {
    const event = effectToCanonicalEvent(emitted, { realmId, facilityId, scopeId: realmId });
    this.stats = { ...this.stats, projected: this.stats.projected + 1 };
    try {
      if (this.outbox) {
        await this.outbox.enqueue(event, { topic: this.topic, scopeId: realmId });
        await this.outbox.flush(this.broker, { limit: 20 });
      } else {
        await this.broker.publish({ topic: this.topic, event, headers: { 'x-event-id': event.id, 'x-realm': realmId } }, { partitionKey: realmId });
      }
      this.stats = { ...this.stats, published: this.stats.published + 1 };
      this.onEvent?.(event);
    } catch {
      this.stats = { ...this.stats, failed: this.stats.failed + 1 };
    }
  }

  snapshot(): RealmEventBridgeStats { return { ...this.stats }; }
}
