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

// JobBus driver factory.
//
// The one place where "which driver" is decided. Bootstrap calls this with a
// resolved ServerConfig + already-constructed dependencies (Redis client for
// BullMQ, Postgres store for Kafka dedup). Tests bypass the factory and
// construct InProcessJobBus directly.

import type { JobBus } from './job-bus.js';
import { InProcessJobBus } from './inprocess-job-bus.js';
import { BullMQJobBus } from './bullmq-job-bus.js';
import { KafkaJobBus } from './kafka-job-bus.js';
import type { ServerConfig } from './config.js';
import type { PostgresEventStore } from './postgres-event-store.js';
import type { ConnectionOptions } from 'bullmq';

export interface JobBusFactoryDeps {
  readonly config: ServerConfig;
  readonly bullmqConnection?: ConnectionOptions;
  readonly dedupStore?: PostgresEventStore;
}

export function createJobBus(deps: JobBusFactoryDeps): JobBus {
  switch (deps.config.jobBusDriver) {
    case 'inprocess':
      return new InProcessJobBus();
    case 'bullmq': {
      if (!deps.bullmqConnection) throw new Error('BullMQ driver requires a Redis connection');
      return new BullMQJobBus({ connection: deps.bullmqConnection });
    }
    case 'kafka': {
      if (!deps.dedupStore) throw new Error('Kafka driver requires a Postgres dedup store');
      return new KafkaJobBus({
        clientId: deps.config.kafkaClientId,
        config: { brokers: [...deps.config.kafkaBrokers] },
        dedupStore: deps.dedupStore,
      });
    }
  }
}
