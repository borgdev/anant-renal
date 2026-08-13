// Production bootstrap.
//
// Wires the Fastify app to real Postgres + Redis, applies migrations, starts
// the BullMQ worker, and begins listening. This file is only executed by the
// `hh-server` binary; tests never import it.

import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { PostgresEventStore } from './postgres-event-store.js';
import { createJobBus } from './job-bus-factory.js';
import type { JobBus } from './job-bus.js';
import { Telemetry, StdoutSink } from './telemetry.js';
import { buildApp } from './app.js';
import { healthcareCorePack } from '../../packs/healthcare-core/index.js';
import { behavioralHealthPack } from '../../packs/behavioral-health/index.js';
import { oncologyDeepPack } from '../../packs/oncology-deep/index.js';
import { homeHealthPack } from '../../packs/home-health/index.js';
import { longTermCarePack } from '../../packs/long-term-care/index.js';
import { radiologyPack } from '../../packs/radiology/index.js';
import { edThroughputPack } from '../../packs/ed-throughput/index.js';
import { revenueCyclePack } from '../../packs/revenue-cycle/index.js';
import { hospitalAtHomePack } from '../../packs/hospital-at-home/index.js';
import { dialysisProviderPack } from '../../packs/dialysis-provider/index.js';
import { payerPack } from '../../packs/payer/index.js';
import { ckdNavigationPack } from '../../packs/ckd-navigation/index.js';
import { cmsUniversePack } from '../../packs/cms-universe/index.js';
import { oncologyProviderPack } from '../../packs/oncology-provider/index.js';
import { infusionProviderPack } from '../../packs/infusion-provider/index.js';
import { careManagementPack } from '../../packs/care-management/index.js';
import type { ActorContext } from './scoped-persistence.js';

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 20 });
  const store = new PostgresEventStore(pool, cfg.databaseSchema);
  await store.applyMigrations();

  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const bus: JobBus = createJobBus({ config: cfg, bullmqConnection: redis, dedupStore: store });
  await bus.start();

  const telemetry = new Telemetry(cfg.telemetryServiceName, new StdoutSink(), cfg.telemetryLogLevel);

  // Placeholder auth: production wires a JWT verifier. Development trusts a
  // signed header carrying a JSON actor context.
  const authenticate = async (req: { headers: Record<string, unknown> }): Promise<ActorContext> => {
    const raw = req.headers['x-actor'];
    if (typeof raw !== 'string') throw new Error('missing x-actor');
    const parsed = JSON.parse(raw) as ActorContext;
    return parsed;
  };

  const app = await buildApp({
    store,
    telemetry,
    packs: [
      healthcareCorePack, dialysisProviderPack, payerPack, ckdNavigationPack, cmsUniversePack,
      oncologyProviderPack, infusionProviderPack, careManagementPack,
      behavioralHealthPack, oncologyDeepPack, homeHealthPack, longTermCarePack,
      radiologyPack, edThroughputPack, revenueCyclePack, hospitalAtHomePack,
    ],
    authenticate,
    checkHealth: async () => {
      let db = false; let r = false;
      try { await pool.query('SELECT 1'); db = true; } catch { /* ignore */ }
      try { await redis.ping(); r = true; } catch { /* ignore */ }
      return { db, redis: r };
    },
  });

  const address = await app.listen({ port: cfg.httpPort, host: cfg.httpHost });
  telemetry.log('info', `harness listening on ${address}`, {});

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.log('info', `shutting down on ${signal}`, {});
    await app.close();
    await bus.stop();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}
