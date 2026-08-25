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
import { createEventBroker } from './event-broker-factory.js';
import { withEventBrokerTelemetry } from './broker-telemetry.js';
import { SqlEventOutbox, OutboxPublisher } from './event-outbox.js';
import { RealmEventBridge } from './realm-event-bridge.js';
import { WebhookRegistry, WebhookDeliverer } from './webhooks.js';
import { AlertService } from './alerts.js';
import { RetentionService } from './retention.js';
import { AuditingSecretsProvider, InMemorySecretsProvider } from '../control-plane/secrets.js';
import { getSqlStore } from './sql/index.js';
import { restoreRealmsFromSpecs } from './realm-restore.js';
import { getSimulatorController } from './simulator-routes.js';
import { resumeSimulatorFleet } from './simulator-persistence.js';
import { decodeCanonicalEvent } from './event-broker.js';
import {
  registerEventFanoutHandler, registerHeartbeatHandler, registerSnapshotBackupHandler,
  registerKnowledgeSyncHandler, registerAgentTriggerHandler,
  registerRetentionPurgeHandler, registerAlertEvaluateHandler,
} from './job-handlers.js';
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
import { LocalUserStore, seedDefaultUsers, SessionManager, sessionActorResolver } from './auth/index.js';
import type { FastifyRequest } from 'fastify';

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 20 });
  const store = new PostgresEventStore(pool, cfg.databaseSchema);
  await store.applyMigrations();

  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const bus: JobBus = createJobBus({ config: cfg, bullmqConnection: redis, dedupStore: store });
  await bus.start();

  const telemetry = new Telemetry(cfg.telemetryServiceName, new StdoutSink(), cfg.telemetryLogLevel);

  // Phase 0 — EventBroker + durable outbox + JobBus handlers (production).
  const broker = withEventBrokerTelemetry(createEventBroker({
    driver: cfg.eventBrokerDriver,
    kafka: { brokers: cfg.kafkaBrokers, clientId: cfg.kafkaClientId, groupId: cfg.kafkaGroupId },
    redisUrl: cfg.redisUrl,
    streamGroup: cfg.eventBrokerTopic,
  }), telemetry);
  // Read path: consume the canonical stream (logs every delivered event).
  await broker.subscribe(
    { topic: cfg.eventBrokerTopic, source: 'bootstrap', eventType: 'patient.registered', subjectPath: 'subjectId' },
    async (msg) => {
      const e = decodeCanonicalEvent(msg.value);
      telemetry.log('info', `[event-broker:${broker.driver}] recv ${e?.type ?? '?'} ${e?.id ?? msg.offset}`, {});
    },
  );
  await broker.start();
  const outbox = new SqlEventOutbox(await getSqlStore(), cfg.eventBrokerTopic);
  const outboxPublisher = new OutboxPublisher(outbox, broker, { flushIntervalMs: 1000 });
  outboxPublisher.start();
  const realmBridge = new RealmEventBridge({ broker, outbox });

  // Phase 4 — enterprise services (webhooks, alerts, retention, secrets).
  const sqlStore = await getSqlStore();
  // Restore persisted realms (B3) so the console comes back with its worlds.
  await restoreRealmsFromSpecs(sqlStore);
  const webhookRegistry = new WebhookRegistry(sqlStore);
  const webhookDeliverer = new WebhookDeliverer(sqlStore, webhookRegistry);
  const alerts = new AlertService(sqlStore);
  const retention = new RetentionService(sqlStore);
  await retention.seedDefaults();
  // Bounded backlog growth: periodically purge delivered events per retention policies.
  const retentionTimer = setInterval(() => { void retention.purge().catch(() => undefined); }, 6 * 3600 * 1000);
  retentionTimer.unref?.();
  // NOTE: prod should back this onto Vault / AWS Secrets Manager / GCP Secret Manager.
  const secrets = new AuditingSecretsProvider(new InMemorySecretsProvider(), () => ({ ref: 'system', purpose: 'operations' }));
  registerRetentionPurgeHandler(bus, retention);
  registerAlertEvaluateHandler(bus, alerts, async () => ({
    'broker.dlq': await broker.deadLetterSize(),
    'outbox.dead': (await outbox.counts()).dead,
    'http.request': 0,
  }));
  await bus.enqueue('retention.purge', { at: new Date().toISOString() }, { idempotencyKey: `ret-${Date.now()}` });
  await bus.enqueue('alert.evaluate', { at: new Date().toISOString() }, { idempotencyKey: `alert-${Date.now()}` });
  registerEventFanoutHandler(bus, outbox, broker);
  registerHeartbeatHandler(bus, (m) => telemetry.log('info', m, {}));
  registerSnapshotBackupHandler(bus, async (realmId) => {
    const s = await getSqlStore();
    await s.saveRealmSnapshot({ realmId, mode: 'twin', createdAt: new Date().toISOString(), snapshotJson: JSON.stringify({ backedUpAt: new Date().toISOString(), realmId }) });
  });
  registerKnowledgeSyncHandler(bus, async (sourceId) => {
    telemetry.log('info', `[job-bus] knowledge.sync ${sourceId}`, {});
    return { ok: true };
  });
  registerAgentTriggerHandler(bus, async (p) => { telemetry.log('info', `[job-bus] agent.trigger ${p.agentId} ${p.triggerType}`, {}); });
  await bus.enqueue('system.heartbeat', { at: new Date().toISOString() }, { idempotencyKey: `hb-${Date.now()}` });

  // Console auth — seeded local users + in-memory sessions (swap for a real
  // IdP / Redis-backed sessions in production SSO setups).
  const users = new LocalUserStore();
  seedDefaultUsers(users);
  const sessions = new SessionManager();
  const resolveSessionActor = sessionActorResolver({ users, sessions });

  // Placeholder auth: production wires a JWT verifier. Development trusts a
  // signed header carrying a JSON actor context; a valid console session
  // (hh_session cookie) is resolved to that user's ActorContext.
  const authenticate = async (req: FastifyRequest): Promise<ActorContext> => {
    const raw = req.headers['x-actor'];
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as ActorContext; } catch { /* fall through */ }
    }
    const viaSession = resolveSessionActor(req);
    if (viaSession) return viaSession;
    throw new Error('missing x-actor or session');
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
    // Phase 0 — write path: append → outbox → broker.
    onEvent: async (event) => { await outbox.enqueue(event); await outbox.flush(broker); await webhookDeliverer.onEvent(event); },
    eventBroker: broker,
    // Phase 3 — admin broker panel + realm→broker streaming.
    eventOutbox: outbox,
    realmEventBridge: realmBridge,
    // Phase 4 — enterprise services.
    webhookDeliverer,
    alerts,
    retention,
    secrets,
    // Console auth — shared with the /auth/* routes.
    users,
    sessions,
    // Enforce session + role on /admin/* APIs (401 unauth, /admin/swarm/* → exec roles).
    adminApiAuth: true,
    ...(cfg.corsOrigins ? { corsOrigins: cfg.corsOrigins } : {}),
  });

  const address = await app.listen({ port: cfg.httpPort, host: cfg.httpHost });
  telemetry.log('info', `harness listening on ${address}`, {});

  // Simulator — optional demo fleet (HH_DEMO_SIM=1) so a hosted instance can
  // run the whole stack on synthetic data. Isolated to sim:* realm ids; reset()
  // tears it down without touching persisted realms/specs.
  if (process.env.HH_DEMO_SIM === '1') {
    const sim = getSimulatorController();
    if (sim) {
      const scenario = process.env.HH_DEMO_SIM_SCENARIO ?? 'dialysis-demo';
      try {
        await sim.start(scenario);
        const snap = sim.snapshot();
        telemetry.log('info', `[simulator] demo scenario '${scenario}' running — ${snap.totals.realms} realm(s), ${snap.totals.patients} patient(s)`, {});
      } catch (err) {
        telemetry.log('warn', `[simulator] demo scenario '${scenario}' failed to start: ${err instanceof Error ? err.message : String(err)}`, {});
      }
    }
  }
  // If no fresh scenario was started above, resume a previously-persisted fleet
  // (deploys/restarts bring the sim back with its realms + controls intact).
  await resumeSimulatorFleet(getSimulatorController(), sqlStore);

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.log('info', `shutting down on ${signal}`, {});
    await app.close();
    outboxPublisher.stop();
    await broker.stop();
    await bus.stop();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}
