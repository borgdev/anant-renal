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

// EffectLedger — append-only log of every effect emitted in a realm.
// Effects are immutable once ledgered. Reversal requires a compensating effect.

import { createHash, randomUUID } from 'node:crypto';
import type { EmittedEffect, WorldEffect } from './types.js';

export class EffectLedger {
  private entries: EmittedEffect[] = [];
  private byPresence = new Map<string, EmittedEffect[]>();
  private subs: Array<(e: EmittedEffect) => void> = [];

  onAppend(cb: (e: EmittedEffect) => void): () => void {
    this.subs.push(cb);
    return () => { this.subs = this.subs.filter((x) => x !== cb); };
  }

  append(input: { presenceId: string; agentSpecId: string; realmAt: string; effect: WorldEffect; status: 'shadow' | 'bound' | 'rejected'; rejection?: string; approvalRef?: { approvalId: string; approvedBy: string; idempotencyKey: string; episodeId: string } }): EmittedEffect {
    const emittedAt = new Date().toISOString();
    const effectId = randomUUID();
    const rec: EmittedEffect = {
      effectId,
      presenceId: input.presenceId,
      agentSpecId: input.agentSpecId,
      emittedAt,
      realmAt: input.realmAt,
      effect: input.effect,
      status: input.status,
      ...(input.rejection !== undefined ? { rejection: input.rejection } : {}),
      ...(input.approvalRef !== undefined ? { approvalRef: input.approvalRef } : {}),
    };
    this.entries.push(rec);
    (this.byPresence.get(input.presenceId) ?? this.byPresence.set(input.presenceId, []).get(input.presenceId)!).push(rec);
    for (const cb of this.subs) cb(rec);
    return rec;
  }

  /** The effect an approval already produced, if any. This is what makes a retried
   *  dispatch at-most-once: the caller asks the LEDGER, not its own memory. */
  findByApprovalKey(idempotencyKey: string): EmittedEffect | undefined {
    return this.entries.find((e) => e.approvalRef?.idempotencyKey === idempotencyKey);
  }

  attachMutations(effectId: string, mutations: Array<{ urn: string; patch: Record<string, unknown> }>): void {
    const rec = this.entries.find((e) => e.effectId === effectId);
    if (rec) (rec as { mutations?: unknown }).mutations = mutations;
  }

  attachTriggeredEvents(effectId: string, eventIds: string[]): void {
    const rec = this.entries.find((e) => e.effectId === effectId);
    if (rec) rec.triggeredEvents = eventIds;
  }

  listAll(): readonly EmittedEffect[] { return this.entries; }
  listByPresence(presenceId: string): readonly EmittedEffect[] { return this.byPresence.get(presenceId) ?? []; }
  listByKind(kind: WorldEffect['kind']): readonly EmittedEffect[] { return this.entries.filter((e) => e.effect.kind === kind); }

  contentHash(): string {
    return createHash('sha256').update(JSON.stringify(this.entries)).digest('hex');
  }
}
