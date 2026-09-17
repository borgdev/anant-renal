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
 * business logic, computational optimization techniques,
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

// Cross-pack step 4 — the two actions that had no implementation.
//
// `x:hospitalization->payer-auth` declares three actions and only `audit` could
// run. The other two were reported `executed: false` with the reason
// "needs the coordinator and a pack queue that do not exist yet", which was
// honest and useless in equal measure: the hand-off was declared, validated,
// visible on `/admin/swarm/cross-pack`, and did nothing.
//
// Both of the missing pieces are the same shape — a record that outlives the
// request and that a pack can act on:
//
//   * `notify-pack` hands a workflow to a TARGET pack → a queue entry that pack
//     can drain. Without it "notify" means "a log line was written".
//   * `open-case` opens a durable case → a case with an id, a state and an owner.
//     Without it "open a case" means "a string was appended to a list".
//
// Durable storage is the existing `swarm_workspace` JSON document store
// (`SqlStore.saveWorkspace`), keyed `(kind, id)`. That is deliberate rather than
// thrifty: it is already the store backing every other durable executive asset,
// it is dialect-portable, and a second persistence path invented for two record
// types would be a second thing to keep correct.
//
// The in-memory maps stay as the read path so a route never awaits SQL, and they
// are the source of truth for a runtime with no store attached (tests, and a dev
// profile before a database exists). `hydrate()` is what makes the durable copy
// real: on boot the maps are refilled from storage, so a case opened before a
// restart is still open afterwards.

import { randomUUID } from 'node:crypto';
import type { CrossPackAction, CrossPackFiringContext, CrossPackHandlers, CrossPackWorkflow } from './cross-pack-workflows.js';

/** The slice of `SqlStore` this needs. Structural, so tests can pass a stub. */
export interface CrossPackPersistence {
  saveWorkspace(row: { kind: string; id: string; entityJson: string; createdAt?: string; updatedAt?: string }): Promise<void>;
  listWorkspace(kind?: string): Promise<Array<{ kind: string; id: string; entityJson: string; createdAt: string; updatedAt: string }>>;
}

export const NOTIFICATION_KIND = 'cross-pack-notification';
export const CASE_KIND = 'cross-pack-case';

/** One workflow handed to a target pack, waiting for that pack to pick it up. */
export interface CrossPackNotification {
  readonly id: string;
  /** The pack the workflow is handed TO — the one that will do the work. */
  readonly packId: string;
  /** The workflow the target pack is being asked to run, in ITS vocabulary. */
  readonly workflowId: string;
  /** The cross-pack workflow that handed it over. */
  readonly handoffId: string;
  readonly eventType: string;
  readonly eventId?: string;
  readonly payload: Record<string, unknown>;
  readonly enqueuedAt: string;
  readonly state: 'pending' | 'claimed';
  readonly claimedAt?: string;
}

/** A durable case, opened by a hand-off and owned by one pack. */
export interface CrossPackCase {
  readonly id: string;
  readonly packId: string;
  readonly caseKind: string;
  readonly handoffId: string;
  readonly eventType: string;
  readonly eventId?: string;
  readonly payload: Record<string, unknown>;
  readonly openedAt: string;
  readonly state: 'open' | 'closed';
  readonly closedAt?: string;
  readonly slaHours?: number;
}

export interface CrossPackRuntimeOptions {
  readonly persistence?: CrossPackPersistence | undefined;
  readonly now?: (() => string) | undefined;
  readonly nextId?: (() => string) | undefined;
}

/**
 * The queue and the case log, plus the handlers that fill them.
 *
 * Not a class with `static` state: the process needs exactly one, but tests need
 * one each, and a singleton would make "the tests share state" a thing to
 * remember. `setCrossPackRuntime` below is the process-wide instance, mirroring
 * how the router is installed.
 */
export class CrossPackRuntime {
  private readonly notificationsByPack = new Map<string, CrossPackNotification[]>();
  private readonly allNotifications: CrossPackNotification[] = [];
  private readonly casesById = new Map<string, CrossPackCase>();
  private readonly persistence: CrossPackPersistence | undefined;
  private readonly now: () => string;
  private readonly nextId: () => string;
  /** Writes that could not be persisted. Read by the route, so a dev profile
   *  with no database is visibly memory-only rather than quietly so. */
  private readonly writeErrors: string[] = [];

  constructor(options: CrossPackRuntimeOptions = {}) {
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextId = options.nextId ?? (() => randomUUID());
  }

  /** Enqueue a workflow for the target pack, and persist the entry. */
  async notify(
    action: Extract<CrossPackAction, { kind: 'notify-pack' }>,
    workflow: CrossPackWorkflow,
    context: CrossPackFiringContext,
  ): Promise<CrossPackNotification> {
    const notification: CrossPackNotification = {
      id: this.nextId(),
      packId: action.packId,
      workflowId: action.workflowId,
      handoffId: workflow.id,
      eventType: context.eventType,
      ...(context.eventId ? { eventId: context.eventId } : {}),
      payload: action.payload,
      enqueuedAt: context.at,
      state: 'pending',
    };
    this.allNotifications.push(notification);
    const queue = this.notificationsByPack.get(notification.packId) ?? [];
    queue.push(notification);
    this.notificationsByPack.set(notification.packId, queue);
    await this.persist(NOTIFICATION_KIND, notification.id, notification);
    return notification;
  }

  /** Open a durable case for the target pack. */
  async openCase(
    action: Extract<CrossPackAction, { kind: 'open-case' }>,
    workflow: CrossPackWorkflow,
    context: CrossPackFiringContext,
  ): Promise<CrossPackCase> {
    const opened: CrossPackCase = {
      id: this.nextId(),
      packId: action.packId,
      caseKind: action.caseKind,
      handoffId: workflow.id,
      eventType: context.eventType,
      ...(context.eventId ? { eventId: context.eventId } : {}),
      payload: action.payload,
      openedAt: context.at,
      state: 'open',
      // The SLA is the workflow's, not the case's: a hand-off that promises a
      // re-review within 24 hours promises it for every case it opens.
      ...(workflow.slaHours !== undefined ? { slaHours: workflow.slaHours } : {}),
    };
    this.casesById.set(opened.id, opened);
    await this.persist(CASE_KIND, opened.id, opened);
    return opened;
  }

  /**
   * The handlers `handleCrossPackEvent` needs, bound to this runtime.
   *
   * Returned rather than built inline at each call site so dev and bootstrap
   * cannot wire a subtly different pair — the two profiles diverging here is how
   * one of them ends up quietly not enqueueing.
   */
  handlers(): CrossPackHandlers {
    return {
      onNotify: (action, workflow, context) => this.notify(action, workflow, context).then(() => undefined),
      onOpenCase: (action, workflow, context) => this.openCase(action, workflow, context).then(() => undefined),
    };
  }

  /** Pending (or all) hand-offs for one pack, oldest first. */
  notifications(packId?: string, state?: CrossPackNotification['state']): readonly CrossPackNotification[] {
    const source = packId ? this.notificationsByPack.get(packId) ?? [] : this.allNotifications;
    return state ? source.filter((n) => n.state === state) : [...source];
  }

  /** A pack drains its queue: the entry is claimed, not deleted. */
  async claim(notificationId: string): Promise<CrossPackNotification | undefined> {
    const existing = this.allNotifications.find((n) => n.id === notificationId);
    if (!existing || existing.state === 'claimed') return existing;
    const claimed: CrossPackNotification = { ...existing, state: 'claimed', claimedAt: this.now() };
    this.replaceNotification(claimed);
    await this.persist(NOTIFICATION_KIND, claimed.id, claimed);
    return claimed;
  }

  cases(filter: { packId?: string; state?: CrossPackCase['state'] } = {}): readonly CrossPackCase[] {
    return [...this.casesById.values()]
      .filter((c) => (filter.packId ? c.packId === filter.packId : true))
      .filter((c) => (filter.state ? c.state === filter.state : true))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  getCase(id: string): CrossPackCase | undefined {
    return this.casesById.get(id);
  }

  async closeCase(id: string): Promise<CrossPackCase | undefined> {
    const existing = this.casesById.get(id);
    if (!existing || existing.state === 'closed') return existing;
    const closed: CrossPackCase = { ...existing, state: 'closed', closedAt: this.now() };
    this.casesById.set(closed.id, closed);
    await this.persist(CASE_KIND, closed.id, closed);
    return closed;
  }

  /** Whether a durable store is attached at all — distinct from "writes failed". */
  get durable(): boolean {
    return this.persistence !== undefined;
  }

  durableWriteErrors(): readonly string[] {
    return [...this.writeErrors];
  }

  /**
   * Refill the in-memory maps from the store.
   *
   * This is what makes the persistence real rather than decorative: without it a
   * case survives a restart in the database and disappears from every screen,
   * which is worse than not persisting at all because the record exists and
   * nothing can see it.
   */
  async hydrate(): Promise<{ notifications: number; cases: number }> {
    if (!this.persistence) return { notifications: 0, cases: 0 };
    let notifications = 0;
    let cases = 0;
    try {
      for (const row of await this.persistence.listWorkspace(NOTIFICATION_KIND)) {
        const parsed = safeParse<CrossPackNotification>(row.entityJson);
        if (!parsed?.id) continue;
        if (this.allNotifications.some((n) => n.id === parsed.id)) continue;
        this.allNotifications.push(parsed);
        const queue = this.notificationsByPack.get(parsed.packId) ?? [];
        queue.push(parsed);
        this.notificationsByPack.set(parsed.packId, queue);
        notifications += 1;
      }
      for (const row of await this.persistence.listWorkspace(CASE_KIND)) {
        const parsed = safeParse<CrossPackCase>(row.entityJson);
        if (!parsed?.id) continue;
        this.casesById.set(parsed.id, parsed);
        cases += 1;
      }
    } catch (err) {
      // A boot that cannot read its own record must still boot — the alternative
      // is a console that will not start because a queue table is unavailable.
      this.writeErrors.push(`hydrate: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { notifications, cases };
  }

  private replaceNotification(next: CrossPackNotification): void {
    const at = this.allNotifications.findIndex((n) => n.id === next.id);
    if (at >= 0) this.allNotifications[at] = next;
    const queue = this.notificationsByPack.get(next.packId);
    if (queue) {
      const q = queue.findIndex((n) => n.id === next.id);
      if (q >= 0) queue[q] = next;
    }
  }

  private async persist(kind: string, id: string, value: unknown): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.saveWorkspace({ kind, id, entityJson: JSON.stringify(value) });
    } catch (err) {
      // Recorded, not swallowed. And NOT rethrown into the handler: the hand-off
      // itself did happen, and making the whole event fail because one queue write
      // missed would drop the other actions in the same workflow.
      this.writeErrors.push(`${kind}/${id}: ${err instanceof Error ? err.message : String(err)}`);
      while (this.writeErrors.length > 20) this.writeErrors.shift();
    }
  }
}

function safeParse<T>(json: string): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

/* ---------- the process-wide instance ---------- */

let active: CrossPackRuntime | undefined;

export function setCrossPackRuntime(runtime: CrossPackRuntime): void {
  active = runtime;
}

export function crossPackRuntime(): CrossPackRuntime | undefined {
  return active;
}
