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

// BrokerEventRouter — the read path (Phase 3). Consumes StreamMessages from the
// EventBroker, maps each to a CanonicalEvent via streamMessageToEvent (the same
// adapter seam HL7v2/CSV/X12 use), and dispatches to handlers by event type.
// Tracks consume/dispatch stats for the admin Event broker panel.

import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';
import { streamMessageToEvent, type StreamMappingOptions } from '../adapters/event-stream.js';
import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';
import type { EventBroker } from './event-broker.js';

export type EventHandler = (event: CanonicalEvent, msg: StreamMessage) => Promise<void>;

export interface EventRoute {
  readonly binding: StreamBinding;
  readonly handler: EventHandler;
}

export interface BrokerEventRouterStats {
  readonly consumed: number;
  readonly mapped: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly bindings: number;
}

/** Event type wildcard — handlers registered here receive every mapped event. */
export const ANY_EVENT = '*';

export class BrokerEventRouter {
  private readonly routes: EventRoute[] = [];
  private readonly byType = new Map<string, EventHandler[]>();
  private stats: BrokerEventRouterStats = { consumed: 0, mapped: 0, dispatched: 0, failed: 0, bindings: 0 };

  constructor(private readonly mapping: StreamMappingOptions) {}

  /** Register a binding + handler (eventType from the binding). */
  subscribe(binding: StreamBinding, handler: EventHandler): BrokerEventRouter {
    this.routes.push({ binding, handler });
    const key = binding.eventType;
    const arr = this.byType.get(key) ?? [];
    arr.push(handler);
    this.byType.set(key, arr);
    return this;
  }

  /** Register a handler for a specific event type (no binding — used by internal dispatch). */
  on(eventType: CanonicalEventType | typeof ANY_EVENT, handler: EventHandler): BrokerEventRouter {
    const arr = this.byType.get(eventType) ?? [];
    arr.push(handler);
    this.byType.set(eventType, arr);
    return this;
  }

  /** Subscribe every registered binding to the broker and start consuming. */
  async attach(broker: EventBroker): Promise<void> {
    for (const route of this.routes) {
      await broker.subscribe(route.binding, (msg) => this.consume(route, msg));
    }
    this.stats = { ...this.stats, bindings: this.routes.length };
  }

  private async consume(route: EventRoute, msg: StreamMessage): Promise<void> {
    this.stats = { ...this.stats, consumed: this.stats.consumed + 1 };
    let event: CanonicalEvent;
    try {
      event = streamMessageToEvent(msg, route.binding, this.mapping);
      this.stats = { ...this.stats, mapped: this.stats.mapped + 1 };
    } catch {
      return; // undecodable → not ours
    }
    // decode the original canonical event id when the payload is one of ours
    const handlers = [...(this.byType.get(event.type) ?? []), ...(this.byType.get(ANY_EVENT) ?? [])];
    if (handlers.length === 0) return;
    await Promise.all(handlers.map(async (h) => {
      try {
        await h(event, msg);
        this.stats = { ...this.stats, dispatched: this.stats.dispatched + 1 };
      } catch {
        this.stats = { ...this.stats, failed: this.stats.failed + 1 };
      }
    }));
  }

  snapshot(): BrokerEventRouterStats { return { ...this.stats }; }
}
