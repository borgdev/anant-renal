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
