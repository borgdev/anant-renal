// M14.D — Notification bus + subscription registry
//
// In-process fan-out for operator-visible events. A subscription is (role,
// eventKinds[], sink). When an effect matching any subscription's kinds lands
// in a realm's ledger, all matching sinks receive a Notification record.
//
// This is deliberately *in-process*: for cross-process use (webhooks, browser
// push, email), a sink can be a function that forwards to whatever transport
// the operator wires up. The core loop stays local-first.

import type { Realm } from './realm.js';
import type { EmittedEffect, WorldEffect } from './types.js';

export interface Notification {
  id: string;
  at: string;
  realmId: string;
  kind: WorldEffect['kind'];
  severity: 'info' | 'warn' | 'critical';
  summary: string;
  effectId: string;
  targetRole?: string;
  approvalId?: string;
  planId?: string;
}

export type NotificationSink = (n: Notification) => void;

export interface Subscription {
  id: string;
  role?: string;
  eventKinds: Array<WorldEffect['kind']>;
  sink: NotificationSink;
}

function severityFor(effect: WorldEffect): Notification['severity'] {
  if (effect.kind === 'flag-safety-event') {
    const sev = (effect as { severity?: string }).severity;
    if (sev === 'critical' || sev === 'high') return 'critical';
    if (sev === 'moderate') return 'warn';
    return 'info';
  }
  if (effect.kind === 'advance-plan') {
    const outcome = (effect as { outcome?: string }).outcome;
    if (outcome === 'blocked' || outcome === 'aborted') return 'warn';
    return 'info';
  }
  return 'info';
}

function summaryFor(effect: WorldEffect, presenceId: string): string {
  switch (effect.kind) {
    case 'flag-safety-event': {
      const e = effect as { severity?: string; description?: string };
      return `Safety event (${e.severity ?? 'unknown'}): ${e.description ?? '(no description)'}`;
    }
    case 'advance-plan': {
      const e = effect as { planId: string; stepId: string; outcome: string; note?: string };
      return `Plan ${e.planId} step ${e.stepId} → ${e.outcome}${e.note ? ` (${e.note})` : ''}`;
    }
    case 'operator-directive': {
      const e = effect as { verb: string; originalText: string };
      return `Directive by ${presenceId}: ${e.verb} — "${e.originalText}"`;
    }
    default:
      return `${effect.kind} by ${presenceId}`;
  }
}

export class NotificationBus {
  private subs = new Map<string, Subscription>();
  private history: Notification[] = [];
  private readonly maxHistory = 500;
  private nextId = 1;

  subscribe(sub: Omit<Subscription, 'id'>): string {
    const id = `sub-${this.nextId++}`;
    this.subs.set(id, { ...sub, id });
    return id;
  }

  unsubscribe(id: string): boolean { return this.subs.delete(id); }

  listSubscriptions(): Subscription[] { return [...this.subs.values()]; }

  /** Publish a raw ledger entry — will be filtered against every subscription. */
  publish(realmId: string, entry: EmittedEffect): Notification | undefined {
    if (entry.status === 'rejected') return undefined;
    const matching = [...this.subs.values()].filter((s) => s.eventKinds.includes(entry.effect.kind));
    if (matching.length === 0) return undefined;

    const notif: Notification = {
      id: `notif-${realmId}-${entry.effectId}`,
      at: entry.realmAt,
      realmId,
      kind: entry.effect.kind,
      severity: severityFor(entry.effect),
      summary: summaryFor(entry.effect, entry.presenceId),
      effectId: entry.effectId,
    };
    // Approval / plan bookkeeping enrichment.
    if (entry.effect.kind === 'advance-plan') {
      const eff = entry.effect as { planId: string };
      notif.planId = eff.planId;
    }
    if (entry.effect.kind === 'flag-safety-event') {
      const eff = entry.effect as { unitId?: string };
      if (eff.unitId) notif.targetRole = 'nurse'; // best-effort role hint
    }

    for (const s of matching) {
      if (s.role && notif.targetRole && s.role !== notif.targetRole) continue;
      try { s.sink(notif); } catch { /* swallow — sink errors must not stall the bus */ }
    }

    this.history.push(notif);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    return notif;
  }

  recent(limit: number = 50): Notification[] { return this.history.slice(-limit).reverse(); }
  clear(): void { this.history = []; }
}

export const NotificationHub = new NotificationBus();

/** Wire a bus to a realm's ledger so every accepted effect flows through. */
export function attachBus(realm: Realm, bus: NotificationBus = NotificationHub): () => void {
  return realm.ledger.onAppend((entry) => { bus.publish(realm.id, entry); });
}
