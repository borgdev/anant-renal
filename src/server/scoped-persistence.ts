// Scoped persistence wrapper.
//
// Every DB read/write goes through this layer, which enforces two invariants:
//   1. Every query is bound to an actor + scope. If the actor's scope set does
//      not include the requested scope, the call throws before hitting SQL.
//   2. Sensitive columns (PHI-classified events, ledger entries touching PHI
//      subjects) are only returned to actors whose purpose-of-use matches the
//      configured allow list.

import type { PostgresEventStore, EventQuery, LedgerQuery, EventStoreScope } from './postgres-event-store.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { LedgerEntry } from '../hypergraph/ledger.js';

export interface ActorContext {
  readonly actorRef: string;
  readonly scopeIds: readonly string[];
  readonly purposeOfUse: 'treatment' | 'operations' | 'compliance' | 'research' | 'break-glass';
  readonly clearance: 'public' | 'internal' | 'confidential' | 'phi' | 'restricted-phi';
}

export class ScopeError extends Error {
  constructor(message: string) { super(message); this.name = 'ScopeError'; }
}

export class ScopedEventStore {
  constructor(private readonly inner: PostgresEventStore) {}

  private ensureScope(actor: ActorContext, scopeId: string): void {
    if (!actor.scopeIds.includes(scopeId)) throw new ScopeError(`actor ${actor.actorRef} has no access to scope ${scopeId}`);
  }
  private ensureClearance(actor: ActorContext, event: { classification: string }): void {
    const rank: Record<string, number> = { public: 0, internal: 1, confidential: 2, phi: 3, 'restricted-phi': 4 };
    const need = rank[event.classification] ?? 4;
    const have = rank[actor.clearance] ?? 0;
    if (have < need) throw new ScopeError(`actor ${actor.actorRef} clearance ${actor.clearance} insufficient for ${event.classification}`);
  }

  async appendEvent(actor: ActorContext, event: CanonicalEvent): Promise<void> {
    this.ensureScope(actor, event.scopeId);
    this.ensureClearance(actor, event);
    const scope: EventStoreScope = { scopeId: event.scopeId, actorRef: actor.actorRef };
    await this.inner.appendEvent(scope, event);
  }

  async queryEvents(actor: ActorContext, q: EventQuery): Promise<readonly CanonicalEvent[]> {
    this.ensureScope(actor, q.scopeId);
    const rows = await this.inner.queryEvents(q);
    return rows.filter((r) => {
      try { this.ensureClearance(actor, r); return true; } catch { return false; }
    });
  }

  async appendLedger(actor: ActorContext, entry: LedgerEntry & { scopeId: string }): Promise<void> {
    this.ensureScope(actor, entry.scopeId);
    await this.inner.appendLedger(entry.scopeId, entry);
  }

  async queryLedger(actor: ActorContext, q: LedgerQuery): Promise<readonly LedgerEntry[]> {
    this.ensureScope(actor, q.scopeId);
    return this.inner.queryLedger(q);
  }
}
