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

// Lazy optional-dependency loader for broker drivers. Each Phase 3 driver that
// depends on an SDK that is NOT a hard dependency (amqplib, nats, @aws-sdk/*,
// @google-cloud/pubsub, @azure/event-hubs) loads it lazily so importing the
// driver module never fails — only constructing the driver does, with a clear
// message. Mirrors the `node:sqlite` lazy `createRequire` pattern.

import { createRequire } from 'node:module';
import { EventBrokerError } from './event-broker.js';

const require = createRequire(import.meta.url);

export function lazyRequire<T>(moduleName: string): () => T {
  let mod: T | undefined;
  let attempted = false;
  return (): T => {
    if (!attempted) {
      attempted = true;
      try {
        mod = require(moduleName) as T;
      } catch {
        throw new EventBrokerError(
          `driver requires optional dependency '${moduleName}' — install it (npm i ${moduleName}) or pick another HH_EVENTBROKER_DRIVER`,
        );
      }
    }
    return mod as T;
  };
}
