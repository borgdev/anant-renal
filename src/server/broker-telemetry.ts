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

// Telemetry decorator for EventBroker — wraps publish with a span + counter so
// every driver gets observability without embedding Telemetry inside drivers.

import type { EventBroker, EventBrokerPublishOptions, EventBrokerRecord } from './event-broker.js';
import type { Telemetry } from './telemetry.js';

export function withEventBrokerTelemetry(broker: EventBroker, telemetry: Telemetry, opts?: { quiet?: boolean }): EventBroker {
  return {
    get driver() { return broker.driver; },
    async publish(record: EventBrokerRecord, opts2?: EventBrokerPublishOptions): Promise<void> {
      // Quiet mode (dev demo sims) skips per-event span/metric emission — a live
      // simulator can publish thousands of events/sec and the JSON flood alone
      // saturates stdout + starves HTTP routes.
      if (opts?.quiet) {
        await broker.publish(record, opts2);
        return;
      }
      const span = telemetry.startSpan(`broker.publish ${broker.driver}`, {
        attributes: { driver: broker.driver, topic: record.topic, eventId: record.event.id },
      });
      try {
        await broker.publish(record, opts2);
        span.end('ok');
        telemetry.metric('broker.event.out', 1, { attributes: { driver: broker.driver, topic: record.topic } });
      } catch (err) {
        span.end('error', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    subscribe: (binding, handler) => broker.subscribe(binding, handler),
    start: () => broker.start(),
    stop: () => broker.stop(),
    health: () => broker.health(),
    deadLetterSize: () => broker.deadLetterSize(),
  };
}
