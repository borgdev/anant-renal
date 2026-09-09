/******************************************************************************
 * R0 — live event feed (bounded canonical-event ring + subscriber set).
 *
 * The exec "live wall" needs a recent tail of canonical events that streamed
 * through the event broker, whatever the driver:
 *   • redis-streams / bullmq  → fed by the broker consumer in dev.ts/bootstrap.ts
 *   • in-process (dev default, CI) → fed by the SAME broker subscription, which
 *     delivers synchronously in-process, so the tail and the tests stay
 *     deterministic with no Redis required.
 *
 * The ring is bounded (default 1000) and newest-first, so `GET /api/live/events`
 * is a cheap replay-from-buffer with optional per-facility/per-realm filters, and
 * the SSE `/api/live/stream` pushes rows as they arrive plus a 15s heartbeat.
 ******************************************************************************/

import type { CanonicalEvent } from '../healthcare-core/events.js';

export interface LiveEventRow {
  eventId: string;
  eventType: string;
  subjectId?: string;
  subjectType?: string;
  patientId?: string;
  realmId?: string;
  facilityId?: string;
  sourceSystem: string;
  recordedTime: string;
  traceId: string;
  status: string;
  payload?: Record<string, unknown>;
}

export interface LiveFeedFilters {
  facilityId?: string;
  realmId?: string;
  limit?: number;
}

export class LiveEventFeed {
  private readonly ring: LiveEventRow[] = [];
  private readonly subscribers = new Set<(row: LiveEventRow) => void>();

  constructor(
    readonly driver: string,
    readonly topic: string,
    private readonly capacity = 1000,
  ) {}

  /** Newest-first, bounded ring. */
  push(event: CanonicalEvent): void {
    const row = this.toRow(event);
    this.ring.unshift(row);
    if (this.ring.length > this.capacity) this.ring.length = this.capacity;
    for (const cb of this.subscribers) {
      try { cb(row); } catch { /* subscriber error must not break the feed */ }
    }
  }

  /** Bounded tail with optional filters (newest-first). */
  rows(filters: LiveFeedFilters = {}): LiveEventRow[] {
    const limit = filters.limit === undefined ? 200 : Math.max(1, Math.min(Math.trunc(filters.limit) || 1, 500));
    let out = this.ring;
    if (filters.facilityId) out = out.filter((r) => r.facilityId === filters.facilityId);
    if (filters.realmId) out = out.filter((r) => r.realmId === filters.realmId);
    return out.slice(0, limit);
  }

  size(): number { return this.ring.length; }

  subscribe(cb: (row: LiveEventRow) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  clear(): void { this.ring.length = 0; }

  private toRow(event: CanonicalEvent): LiveEventRow {
    const subjectId = event.subjectId;
    const payload = event.payload as Record<string, unknown> | undefined;
    const subjectType = subjectId && subjectId.includes(':') ? subjectId.split(':')[0] : undefined;
    let patientId: string | undefined;
    if (payload && typeof payload.patientId === 'string') patientId = payload.patientId;
    else if (typeof subjectId === 'string' && (subjectId.startsWith('patient:') || subjectId.startsWith('pt:'))) patientId = subjectId;
    return {
      eventId: event.id,
      eventType: event.type,
      ...(subjectId ? { subjectId } : {}),
      ...(subjectType ? { subjectType } : {}),
      ...(patientId ? { patientId } : {}),
      realmId: event.scopeId,
      ...(event.facilityId ? { facilityId: event.facilityId } : {}),
      sourceSystem: 'broker',
      recordedTime: event.occurredAt,
      traceId: event.id,
      status: 'ok',
      ...(payload ? { payload } : {}),
    };
  }
}
