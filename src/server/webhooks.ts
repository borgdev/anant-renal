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

// Durable webhooks (Phase 4) — the first consumer of the Phase 3 event fabric.
// Every canonical event is fanned out to matching webhook endpoints through a
// durable delivery outbox: HMAC-SHA256 signed POST, exponential retry/backoff,
// dead-letter after max attempts, and replay-by-cursor. Works on any SqlDb.

import { createHmac, randomUUID } from 'node:crypto';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { SqlStore, WebhookDeliveryRow, WebhookEndpointRow } from './sql/sql-store.js';

export const WEBHOOK_DEFAULT_MAX_ATTEMPTS = 5;

/** HMAC-SHA256 signature of a JSON payload with the endpoint secret. */
export function signWebhook(secret: string, payload: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

export interface WebhookEndpointInput {
  id?: string;
  realmId?: string;
  url: string;
  secret: string;
  eventTypes: string[]; // '*' = all
  active?: boolean;
}

export interface WebhookStats { pending: number; delivered: number; dead: number; }

export class WebhookRegistry {
  constructor(private readonly store: SqlStore) {}

  async create(input: WebhookEndpointInput): Promise<WebhookEndpointRow> {
    const row: WebhookEndpointRow = {
      id: input.id ?? `wh-${randomUUID()}`,
      realmId: input.realmId ?? null,
      url: input.url,
      secret: input.secret,
      eventTypesJson: JSON.stringify(input.eventTypes),
      active: input.active === false ? 0 : 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveWebhookEndpoint(row);
    return row;
  }

  async list(): Promise<WebhookEndpointRow[]> { return this.store.listWebhookEndpoints(); }
  async get(id: string): Promise<WebhookEndpointRow | undefined> { return this.store.getWebhookEndpoint(id); }
  async remove(id: string): Promise<boolean> { return this.store.deleteWebhookEndpoint(id); }
  async stats(): Promise<WebhookStats> { return this.store.webhookDeliveryCounts(); }
}

export interface WebhookDelivererOptions {
  maxAttempts?: number;
  backoffMs?: number;
  /** HTTP client for tests (defaults to global fetch). */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
  onDelivered?: (deliveryId: string, webhookId: string, eventId: string) => void;
}

export class WebhookDeliverer {
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly doFetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
  private readonly onDelivered: ((deliveryId: string, webhookId: string, eventId: string) => void) | undefined;

  constructor(
    private readonly store: SqlStore,
    private readonly registry: WebhookRegistry,
    opts: WebhookDelivererOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? WEBHOOK_DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.doFetch = opts.fetch ?? (async (url, init) => {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
      return { ok: res.ok, status: res.status };
    });
    this.onDelivered = opts.onDelivered;
  }

  /** Fan a canonical event out to matching endpoints (enqueue → best-effort flush). */
  async onEvent(event: CanonicalEvent): Promise<{ enqueued: number; delivered: number }> {
    const endpoints = (await this.registry.list()).filter((e) => e.active === 1 && this.matches(e, event));
    let enqueued = 0;
    for (const ep of endpoints) {
      await this.store.enqueueWebhookDelivery({
        id: `whd-${randomUUID()}`,
        webhookId: ep.id,
        eventId: event.id,
        eventJson: JSON.stringify(event),
      });
      enqueued += 1;
    }
    const delivered = await this.flush();
    return { enqueued, delivered };
  }

  private matches(ep: WebhookEndpointRow, event: CanonicalEvent): boolean {
    const types = JSON.parse(ep.eventTypesJson) as string[];
    if (!(types.includes('*') || types.includes(event.type))) return false;
    if (ep.realmId && event.scopeId !== ep.realmId) return false;
    return true;
  }

  /** Drain pending deliveries → POST each with signature; retry/backoff → DLQ. */
  async flush(limit = 25): Promise<number> {
    let delivered = 0;
    for (;;) {
      const rows = await this.store.pendingWebhookDeliveries(limit);
      if (rows.length === 0) break;
      for (const row of rows) {
        const ep = await this.store.getWebhookEndpoint(row.webhookId);
        if (!ep || ep.active !== 1) {
          await this.store.markWebhookDelivered(row.id, 'disabled', new Date().toISOString());
          continue;
        }
        const event = JSON.parse(row.eventJson) as CanonicalEvent;
        const signature = signWebhook(ep.secret, event);
        try {
          const res = await this.doFetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-event': event.type, 'x-webhook-event-id': event.id }, body: row.eventJson });
          if (!res.ok) throw new Error(`webhook endpoint returned HTTP ${res.status}`);
          await this.store.markWebhookDelivered(row.id, signature);
          delivered += 1;
          this.onDelivered?.(row.id, ep.id, event.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const nextAttemptAt = new Date(Date.now() + this.backoffMs).toISOString();
          await this.store.markWebhookFailed(row.id, message, this.maxAttempts, nextAttemptAt);
        }
      }
      if (rows.length < limit) break;
    }
    return delivered;
  }
}
