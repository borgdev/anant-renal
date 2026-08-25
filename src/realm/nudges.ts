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

// M25 — Ambient nudge delivery + Nudge Ledger.
//
// Rehearsed nudges (from the counterfactual studio) get delivered through real-world channel
// adapters and recorded in a ledger with expected vs observed, so the loop closes when the
// twin observes a response. Every delivery carries the rehearsal/variant id + expected effect
// + expiry (per README M25).

import { randomUUID } from 'node:crypto';
import type { Realm } from './realm.js';
import type { SqlStore } from '../server/sql/index.js';

export type NudgeChannel = 'in-app' | 'sms' | 'email' | 'calendar' | 'fhir';
export type NudgeStatus = 'queued' | 'delivered' | 'failed' | 'expired' | 'observed';

export interface NudgeSpec {
  realmId: string;
  patientId: string;
  channel: NudgeChannel;
  nudgeKind: string;
  /** Expected effect — event-feature or state deltas the rehearsal projected. */
  expectedEffect: Record<string, number>;
  /** Counterfactual rehearsal that proposed this nudge (provenance). */
  rehearsalId?: string;
  variantId?: string;
  expiresAt?: string;
}

export interface NudgeRecord extends NudgeSpec {
  id: string;
  status: NudgeStatus;
  sentAt: string;
  channelReceipt?: string;
  observedAt?: string;
  observedOutcome?: Record<string, unknown>;
}

/** A real-world channel. `in-app` is real; sms/email/calendar/fhir are swappable stubs. */
export interface NudgeChannelAdapter {
  readonly id: NudgeChannel;
  send(nudge: NudgeSpec): Promise<{ receipt: string }>;
}

/** Real channel: the patient/family twin perceives the nudge in-app (artifact + perception). */
export class InAppNudgeChannel implements NudgeChannelAdapter {
  readonly id = 'in-app' as const;
  constructor(private readonly realm: Realm) {}

  async send(nudge: NudgeSpec): Promise<{ receipt: string }> {
    const receipt = `in-app-${randomUUID().slice(0, 8)}`;
    const urn = this.realm.graph.urnFor('patient', nudge.patientId);
    this.realm.graph.create('work-artifact', receipt, {
      kind: 'nudge',
      nudgeKind: nudge.nudgeKind,
      patientId: nudge.patientId,
      channel: 'in-app',
      expectedEffect: nudge.expectedEffect,
      ...(nudge.rehearsalId ? { rehearsalId: nudge.rehearsalId } : {}),
      ...(nudge.variantId ? { variantId: nudge.variantId } : {}),
      deliveredAt: new Date().toISOString(),
    });
    this.realm.perception.broadcast({
      kind: 'nudge.delivered',
      entityUrn: urn,
      entityKind: 'patient',
      entityId: nudge.patientId,
      payload: { nudgeKind: nudge.nudgeKind, channel: 'in-app', expectedEffect: nudge.expectedEffect },
      realmAt: new Date().toISOString(),
    });
    return { receipt };
  }
}

/** Placeholder for Twilio/SES/ICS/FHIR — swap real implementations behind the same interface. */
export class StubNudgeChannel implements NudgeChannelAdapter {
  constructor(readonly id: Exclude<NudgeChannel, 'in-app'>) {}
  async send(): Promise<{ receipt: string }> {
    return { receipt: `${this.id}-stub-${randomUUID().slice(0, 8)}` };
  }
}

export interface NudgePersistence {
  save(rec: NudgeRecord): Promise<void>;
  updateObserved(id: string, observedAt: string, outcome: Record<string, unknown>): Promise<void>;
}

/** SqlStore-backed persistence — the ledger survives restarts (swap SQLite ↔ Postgres freely). */
export function sqliteNudgePersistence(store: SqlStore): NudgePersistence {
  return {
    async save(rec) {
      await store.saveNudge({
        id: rec.id,
        realmId: rec.realmId,
        patientId: rec.patientId,
        channel: rec.channel,
        nudgeKind: rec.nudgeKind,
        expectedEffectJson: JSON.stringify(rec.expectedEffect),
        rehearsalId: rec.rehearsalId ?? null,
        variantId: rec.variantId ?? null,
        expiresAt: rec.expiresAt ?? null,
        status: rec.status,
        sentAt: rec.sentAt,
        observedAt: rec.observedAt ?? null,
        observedOutcomeJson: rec.observedOutcome ? JSON.stringify(rec.observedOutcome) : null,
      });
    },
    async updateObserved(id, observedAt, outcome) {
      await store.updateNudgeObserved(id, observedAt, JSON.stringify(outcome));
    },
  };
}

export class NudgeLedger {
  private readonly records = new Map<string, NudgeRecord>();

  constructor(private readonly persist?: NudgePersistence) {}

  async deliver(spec: NudgeSpec, adapter: NudgeChannelAdapter): Promise<NudgeRecord> {
    const id = `nudge-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const rec: NudgeRecord = { ...spec, id, status: 'queued', sentAt: new Date().toISOString() };
    try {
      const { receipt } = await adapter.send(spec);
      rec.status = 'delivered';
      rec.channelReceipt = receipt;
    } catch {
      rec.status = 'failed';
    }
    this.records.set(id, rec);
    await this.persist?.save(rec);
    return rec;
  }

  async observe(id: string, outcome: Record<string, unknown>, at = new Date().toISOString()): Promise<NudgeRecord | undefined> {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    rec.status = 'observed';
    rec.observedAt = at;
    rec.observedOutcome = outcome;
    await this.persist?.updateObserved(id, at, outcome);
    return rec;
  }

  list(realmId?: string): NudgeRecord[] {
    const all = [...this.records.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    return realmId ? all.filter((r) => r.realmId === realmId) : all;
  }

  get(id: string): NudgeRecord | undefined {
    return this.records.get(id);
  }
}
