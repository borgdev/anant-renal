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

// EventBroker driver factory. The one place "which broker" is decided, selected
// by HH_EVENTBROKER_DRIVER — mirrors createJobBus / buildSqlDb. Phase 3 breadth:
// all nine drivers land here. SDK-backed drivers (rabbitmq/nats/sqs-sns/pubsub/
// event-hubs) lazy-load their optional SDKs and throw a clear error when the
// dependency or config is missing.

import type { EventBroker, EventBrokerDriver } from './event-broker.js';
import { EventBrokerError } from './event-broker.js';
import { InProcessEventBroker, type InProcessEventBrokerOptions } from './inprocess-event-broker.js';
import { KafkaEventBroker } from './kafka-event-broker.js';
import { RedisStreamsEventBroker } from './redis-streams-event-broker.js';
import { BullMqEventBroker } from './bullmq-event-broker.js';
import { RabbitMqEventBroker } from './rabbitmq-event-broker.js';
import { NatsEventBroker } from './nats-event-broker.js';
import { SqsSnsEventBroker } from './sqs-sns-event-broker.js';
import { PubSubEventBroker } from './pubsub-event-broker.js';
import { EventHubsEventBroker } from './event-hubs-event-broker.js';

export interface EventBrokerFactoryDeps {
  readonly driver: EventBrokerDriver;
  readonly inprocess?: InProcessEventBrokerOptions;
  readonly kafka?: { brokers: readonly string[]; clientId: string; groupId?: string };
  readonly redisUrl?: string;
  readonly streamGroup?: string;
  // Phase 3 breadth config (each driver also accepts injected SDKs for tests)
  readonly bullmq?: { url: string; maxAttempts?: number };
  readonly rabbitmq?: { url: string; maxAttempts?: number };
  readonly nats?: { url: string; maxAttempts?: number };
  readonly sqsSns?: { topicArn: string; queueUrl: string; region?: string; dlqUrl?: string };
  readonly pubsub?: { projectId: string };
  readonly eventHubs?: { connectionString: string; eventHubName: string };
}

export function createEventBroker(deps: EventBrokerFactoryDeps): EventBroker {
  switch (deps.driver) {
    case 'inprocess':
      return new InProcessEventBroker(deps.inprocess);
    case 'kafka': {
      if (!deps.kafka) throw new EventBrokerError('kafka driver requires kafka config (brokers, clientId)');
      return new KafkaEventBroker(deps.kafka);
    }
    case 'redis-streams': {
      if (!deps.redisUrl) throw new EventBrokerError('redis-streams driver requires redisUrl');
      return new RedisStreamsEventBroker({ url: deps.redisUrl, ...(deps.streamGroup ? { group: deps.streamGroup } : {}) });
    }
    case 'bullmq': {
      if (!deps.bullmq) throw new EventBrokerError('bullmq driver requires bullmq.url (HH_REDIS_URL)');
      return new BullMqEventBroker(deps.bullmq);
    }
    case 'rabbitmq': {
      if (!deps.rabbitmq) throw new EventBrokerError('rabbitmq driver requires rabbitmq.url (HH_RABBITMQ_URL)');
      return new RabbitMqEventBroker(deps.rabbitmq);
    }
    case 'nats': {
      if (!deps.nats) throw new EventBrokerError('nats driver requires nats.url (HH_NATS_URL)');
      return new NatsEventBroker(deps.nats);
    }
    case 'sqs-sns': {
      if (!deps.sqsSns) throw new EventBrokerError('sqs-sns driver requires topicArn + queueUrl (HH_SNS_TOPIC / HH_SQS_QUEUE_URL)');
      return new SqsSnsEventBroker(deps.sqsSns);
    }
    case 'pubsub': {
      if (!deps.pubsub) throw new EventBrokerError('pubsub driver requires projectId (HH_PUBSUB_PROJECT)');
      return new PubSubEventBroker(deps.pubsub);
    }
    case 'event-hubs': {
      if (!deps.eventHubs) throw new EventBrokerError('event-hubs driver requires connectionString + eventHubName');
      return new EventHubsEventBroker(deps.eventHubs);
    }
  }
}
