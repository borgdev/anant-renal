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

  append(input: { presenceId: string; agentSpecId: string; realmAt: string; effect: WorldEffect; status: 'shadow' | 'bound' | 'rejected'; rejection?: string }): EmittedEffect {
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
    };
    this.entries.push(rec);
    (this.byPresence.get(input.presenceId) ?? this.byPresence.set(input.presenceId, []).get(input.presenceId)!).push(rec);
    for (const cb of this.subs) cb(rec);
    return rec;
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
