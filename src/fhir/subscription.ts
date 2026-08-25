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

// FHIR Subscription / change-data-capture pump (Phase 5 EHR-bridge). Polls a
// remote FHIR server's resource history (or takes a CDC batch) and hydrates
// each changed resource to CanonicalEvents via the Phase 2 registry — so an
// external EHR keeps a realm current (twin mode).

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';
import { FhirClient } from './client.js';
import { hydrateBundle } from './mapping.js';
import type { FhirCtx, FhirResource } from './types.js';

export interface SubscriptionPumpOptions {
  client: FhirClient;
  ctx: FhirCtx;
  /** Resource types to watch (e.g. ['Patient','Observation','Encounter']). */
  resourceTypes: string[];
  /** Optional last-poll timestamp cursor (ISO). */
  since?: string;
  /** Per-batch callback (default: no-op — wire to ingestCanonicalEvents). */
  onEvents?: (events: CanonicalEvent[]) => Promise<void> | void;
}

export interface SubscriptionPumpResult {
  fetched: number;
  events: CanonicalEvent[];
  nextSince: string;
}

/** Convert a FHIR Subscription notification / CDC payload to canonical events. */
export function subscriptionNotificationToEvents(resources: readonly FhirResource[], ctx: FhirCtx): CanonicalEvent[] {
  const bundle = { resourceType: 'Bundle', type: 'collection', entry: resources.map((resource) => ({ resource })) } as never;
  return hydrateBundle(bundle as never, ctx);
}

export class FhirSubscriptionPump {
  private readonly client: FhirClient;
  private readonly ctx: FhirCtx;
  private readonly resourceTypes: string[];
  private since: string;
  private readonly onEvents: ((events: CanonicalEvent[]) => Promise<void> | void) | undefined;

  constructor(opts: SubscriptionPumpOptions) {
    this.client = opts.client;
    this.ctx = opts.ctx;
    this.resourceTypes = opts.resourceTypes;
    this.since = opts.since ?? new Date(0).toISOString();
    this.onEvents = opts.onEvents;
  }

  /**
   * Poll each watched resource type's `_lastUpdated` history since the cursor,
   * hydrate the changed resources, and forward the events. Advances the cursor.
   */
  async poll(): Promise<SubscriptionPumpResult> {
    const events: CanonicalEvent[] = [];
    let fetched = 0;
    let newest = this.since;
    for (const type of this.resourceTypes) {
      const bundle = await this.client.search<FhirResource>(type, {
        _lastUpdated: `gt${this.since}`,
        _count: '100',
        _sort: '-_lastUpdated',
      });
      const resources = (bundle.entry ?? []).map((e) => e.resource).filter((r): r is FhirResource => Boolean(r));
      fetched += resources.length;
      for (const r of resources) {
        const updated = (r.meta?.lastUpdated) ?? this.since;
        if (updated > newest) newest = updated;
      }
      events.push(...subscriptionNotificationToEvents(resources, this.ctx));
    }
    this.since = newest;
    if (this.onEvents) await this.onEvents(events);
    return { fetched, events, nextSince: this.since };
  }

  cursor(): string { return this.since; }
}
