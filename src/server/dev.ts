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

// Development bootstrap — the "dev profile".
//
// Runs the full Fastify control-plane (admin routes at /admin/*, knowledge
// routes, health, events, ledger) with only Postgres as an external dependency:
//   • Durable Postgres store             — events, ledger, audit, workspace
//   • InProcessJobBus                    — no Redis / Kafka
//   • Stdout telemetry
//   • Dev auth: trusts the `x-actor` header, or falls back to a power-user
//
// A non-durable in-memory store is available via HH_STORAGE=memory, and is also
// the last-resort fallback when Postgres cannot be reached — in that case the boot
// log says so at `error` level and /health reports `db: false`, because silently
// running without durability is how state disappears unnoticed.
//
// This file is only executed by the `dev` npm script; tests never import it.

import type { FastifyRequest } from 'fastify';
import { buildApp } from './app.js';
import { Telemetry, StdoutSink } from './telemetry.js';
import { InProcessJobBus } from './inprocess-job-bus.js';
import { loadConfig } from './config.js';
import { createEventBroker } from './event-broker-factory.js';
import { Redis } from 'ioredis';
import type { EventBrokerDriver } from './event-broker.js';
import { withEventBrokerTelemetry } from './broker-telemetry.js';
import { SqlEventOutbox, OutboxPublisher } from './event-outbox.js';
import { RealmEventBridge } from './realm-event-bridge.js';
import { WebhookRegistry, WebhookDeliverer } from './webhooks.js';
import { AlertService } from './alerts.js';
import { RetentionService } from './retention.js';
import { AuditingSecretsProvider, InMemorySecretsProvider } from '../control-plane/secrets.js';
import { getSqlStore } from './sql/index.js';
import { openDurableStore, postgresReachable, type DurableStore } from './postgres-bootstrap.js';
import { restoreRealmsFromSpecs } from './realm-restore.js';
import { decodeCanonicalEvent } from './event-broker.js';
import { LiveEventFeed } from './live-event-feed.js';
import {
  registerEventFanoutHandler, registerHeartbeatHandler, registerSnapshotBackupHandler,
  registerKnowledgeSyncHandler, registerAgentTriggerHandler,
  registerRetentionPurgeHandler, registerAlertEvaluateHandler,
} from './job-handlers.js';
import { LocalUserStore, seedDefaultUsers, SessionManager, sessionActorResolver, sqlSessionPersistence, sqlUserPersistence } from './auth/index.js';
import { getSimulatorController } from './simulator-routes.js';
import { resumeSimulatorFleet } from './simulator-persistence.js';
import type { PostgresEventStore } from './postgres-event-store.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { LedgerEntry } from '../hypergraph/ledger.js';
import type { ActorContext } from './scoped-persistence.js';
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

/** Minimal in-memory stand-in for `PostgresEventStore` used by the app. */
function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* in-memory: no-op */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents(q: { scopeId: string; types?: readonly string[]; since?: string; until?: string; limit?: number }) {
      let out = events.filter((e) => e.scopeId === q.scopeId);
      if (q.types) out = out.filter((e) => q.types!.includes(e.type));
      if (q.since) out = out.filter((e) => e.occurredAt >= q.since!);
      if (q.until) out = out.filter((e) => e.occurredAt < q.until!);
      if (q.limit) out = out.slice(0, q.limit);
      return out;
    },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger(q: { scopeId: string; transactionAt?: string; kinds?: readonly LedgerEntry['kind'][]; limit?: number }) {
      let out = ledger.slice();
      if (q.kinds) out = out.filter((e) => q.kinds!.includes(e.kind));
      if (q.transactionAt) out = out.filter((e) => e.transactionAt <= q.transactionAt!);
      if (q.limit) out = out.slice(0, q.limit);
      return out;
    },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
  return store;
}

/** Default power-user for local development when no `x-actor` header is sent. */
const DEV_ACTOR: ActorContext = {
  actorRef: 'dev:local',
  scopeIds: ['scope:facility-1', 'scope:*'],
  purposeOfUse: 'treatment',
  clearance: 'restricted-phi',
};

/**
 * Pick the event broker transport for the dev profile.
 *
 * An explicit `HH_EVENTBROKER_DRIVER` is always honoured. Otherwise Redis Streams
 * is preferred when Redis actually answers, because publishing from the process
 * makes transport compete with HTTP for the same core. Falling back to the
 * in-process broker is fine — but it is announced, never silent, since the two
 * behave very differently under load.
 */
async function chooseBrokerDriver(
  configured: EventBrokerDriver,
  redisUrl: string,
  telemetry: Telemetry,
): Promise<EventBrokerDriver> {
  if (process.env.HH_EVENTBROKER_DRIVER) return configured;
  if (configured !== 'inprocess') return configured;
  const probe = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 });
  try {
    await probe.connect();
    await probe.ping();
    telemetry.log('info', `event broker: redis-streams (redis reachable at ${redisUrl})`, {});
    return 'redis-streams';
  } catch (err) {
    telemetry.log('warn', 'event broker: inprocess — Redis unreachable, so transport shares this process with HTTP', {
      attributes: {
        error: err instanceof Error ? err.message : String(err),
        remedy: `start Redis or set HH_EVENTBROKER_DRIVER explicitly (redisUrl=${redisUrl})`,
      },
    });
    return 'inprocess';
  } finally {
    probe.disconnect();
  }
}

export async function main(): Promise<void> {
  const port = Number(process.env.HH_HTTP_PORT ?? 3000);
  const host = process.env.HH_HTTP_HOST ?? '127.0.0.1';
  const config = loadConfig(process.env);

  // Console auth — seeded local users + in-memory sessions. The app-level
  // authenticate() below resolves an `hh_session` cookie so the console runs
  // under the logged-in identity.
  const users = new LocalUserStore();
  const sessions = new SessionManager();
  const resolveSessionActor = sessionActorResolver({ users, sessions });
  const telemetry = new Telemetry('healthcare-harness-dev', new StdoutSink(), config.telemetryLogLevel);

  // Phase 0 — EventBroker (publish + consume CanonicalEvents across drivers).
  // quiet: the demo simulator publishes thousands of events/sec; per-event spans
  // + metrics + recv logs saturated stdout and starved HTTP routes (~8s for a 4KB
  // patients response). Keep the read path but drop per-event emission in dev.
  //
  // TRANSPORT CHOICE: with a fleet running, publishing straight from the process
  // makes the transport compete with HTTP for the same single core (measured:
  // ~100% of one core for ~29 events/s, delivering ~23/s). Redis Streams moves the
  // fan-out off that hot path. The durable outbox stays in Postgres either way —
  // Redis is transport, not the write-ahead record — so a Redis restart cannot
  // lose an event that the ledger already recorded.
  const brokerDriver = await chooseBrokerDriver(config.eventBrokerDriver, config.redisUrl, telemetry);
  const broker = withEventBrokerTelemetry(createEventBroker({
    driver: brokerDriver,
    kafka: { brokers: config.kafkaBrokers, clientId: config.kafkaClientId, groupId: config.kafkaGroupId },
    redisUrl: config.redisUrl,
    streamGroup: config.eventBrokerTopic,
  }), telemetry, { quiet: true });
  // Wildcard binding: broker drivers dispatch by topic (not eventType), so this
  // subscription receives every canonical type on the topic.
  const ALL_TYPES = '*' as unknown as import('../healthcare-core/events.js').CanonicalEventType;
  // Read path: consume the canonical stream (per-event recv is logged at debug,
  // i.e. suppressed at the default 'info' level — enable with HH_LOG_LEVEL=debug).
  await broker.subscribe(
    { topic: config.eventBrokerTopic, source: 'dev', eventType: 'patient.registered', subjectPath: 'subjectId' },
    async (msg) => {
      const e = decodeCanonicalEvent(msg.value);
      telemetry.log('debug', `[event-broker:${broker.driver}] recv ${e?.type ?? '?'} ${e?.id ?? msg.offset}`, {});
    },
  );
  await broker.start();

  // R0 — live event wall: bounded canonical-event ring fed by the broker
  // consumer (works under every driver incl. in-process), exposed to the exec
  // console via /api/live/events + /api/live/stream.
  const liveFeed = new LiveEventFeed(broker.driver, config.eventBrokerTopic);
  await broker.subscribe(
    { topic: config.eventBrokerTopic, source: 'dev-live', eventType: ALL_TYPES, subjectPath: 'subjectId' },
    async (msg) => {
      const e = decodeCanonicalEvent(msg.value);
      if (e) liveFeed.push(e);
    },
  );

  // Phase 0 — durable outbox (SqlStore: SQLite file, or Postgres anant-health via HH_STORAGE).
  //
  // The store below is the app's event/ledger/audit store AND the backing store of
  // the swarm workspace (cohort definitions + memberships, outcome episodes,
  // evidence reviews, releases, NBA decisions). An in-memory stand-in therefore
  // discarded every one of those on restart while all endpoints kept answering
  // 200 — the failure was invisible precisely because nothing errored.
  const storageMode = (process.env.HH_STORAGE ?? '').toLowerCase();
  let durable: DurableStore | null = null;
  if (storageMode === 'memory') {
    telemetry.log('warn', 'HH_STORAGE=memory — state will NOT survive a restart (explicit choice)', {});
  } else {
    try {
      durable = await openDurableStore({ databaseUrl: config.databaseUrl, schema: config.databaseSchema });
      telemetry.log('info', `durable store ready: postgres ${durable.database} (schema ${durable.schema})`, {});
      // One durable backend rather than two: SqlStore (sessions, realms, outbox,
      // nudges, simulator fleet) joins the workspace store on Postgres unless the
      // operator explicitly chose a dialect.
      if (!process.env.HH_STORAGE) process.env.HH_STORAGE = 'postgres';
    } catch (err) {
      telemetry.log('error', 'DURABLE STORE UNAVAILABLE — falling back to in-memory: nothing recorded this session will survive a restart', {
        attributes: {
          error: err instanceof Error ? err.message : String(err),
          databaseUrl: config.databaseUrl,
          remedy: 'start Postgres (docker compose up -d postgres) or set HH_STORAGE=memory to accept non-durable state',
        },
      });
    }
  }
  const store = durable?.store ?? inMemoryStore();

  const sqlStore = await getSqlStore();
  // Console sessions are durable: both consoles share ONE `hh_session` token, so
  // without this a `tsx watch` reload logged every console out and whichever
  // page you reloaded first looked like it had lost the other console's login.
  sessions.attachPersistence(sqlSessionPersistence(sqlStore));
  // AWAIT the restore — it is one small indexed read. Fire-and-forgetting it left
  // a window where the in-memory session map was still empty, so the first
  // request after a reload 401'd and whichever console you opened looked like it
  // had lost the other console's login. Restoring before the app is built closes
  // that window entirely.
  const restoredSessions = await sessions.restore().catch(() => 0);
  if (restoredSessions > 0) telemetry.log('info', `restored ${restoredSessions} console session(s)`);
  // Console users are durable too: a user an operator created, or a password they
  // reset, must not vanish on the next reload. Restore FIRST, then seed, so a
  // restored account always wins over the shipped default of the same name.
  users.attachPersistence(sqlUserPersistence(sqlStore));
  const restoredUsers = await users.restore().catch(() => 0);
  seedDefaultUsers(users);
  if (restoredUsers > 0) telemetry.log('info', `restored ${restoredUsers} console user(s)`);
  // A session can outlive the account it names (removed user, wiped table): drop
  // those so `hh_session` can never authenticate a principal that no longer exists.
  const orphaned = sessions.pruneUnknownUsers(new Set(users.list().map((u) => u.username)));
  if (orphaned > 0) telemetry.log('warn', `dropped ${orphaned} session(s) whose account no longer exists`, {});
  // Restore persisted realms (B3) so `tsx watch` reloads keep the worlds alive.
  // Deferred: rebuilding a large fleet snapshot can block the loop for seconds,
  // which used to exceed Fastify's plugin timeout and abort the whole boot.
  // The server now starts serving immediately; worlds reappear moments later.
  void restoreRealmsFromSpecs(sqlStore)
    .then((ids) => { if (ids.length) telemetry.log('info', `restored ${ids.length} realms`, { attributes: { realms: ids.join(',') } }); })
    .catch((err: unknown) => telemetry.log('warn', 'realm restore failed', { attributes: { error: err instanceof Error ? err.message : String(err) } }));
  const outbox = new SqlEventOutbox(sqlStore, config.eventBrokerTopic);

  // Phase 3 — periodic outbox flusher + realm → broker bridge.
  const outboxPublisher = new OutboxPublisher(outbox, broker, {
    flushIntervalMs: 500,
    onFlush: (n) => telemetry.log('debug', `outbox flushed ${n}`, {}),
    onError: (err) => telemetry.log('warn', 'outbox flush failed — events are retained and will retry', {
      attributes: { error: err instanceof Error ? err.message : String(err) },
    }),
  });
  outboxPublisher.start();
  const realmBridge = new RealmEventBridge({ broker, outbox });

  // Phase 4 — enterprise services (webhooks, alerts, retention, secrets).
  const webhookRegistry = new WebhookRegistry(sqlStore);
  const webhookDeliverer = new WebhookDeliverer(sqlStore, webhookRegistry, {
    onDelivered: (id) => telemetry.log('debug', `webhook delivered ${id}`, {}),
  });
  const alerts = new AlertService(sqlStore);
  const retention = new RetentionService(sqlStore);
  await retention.seedDefaults();
  // Bounded backlog growth: periodically purge delivered events per retention policies.
  const retentionTimer = setInterval(() => { void retention.purge().catch(() => undefined); }, 6 * 3600 * 1000);
  retentionTimer.unref?.();
  const secrets = new AuditingSecretsProvider(new InMemorySecretsProvider(), () => ({ ref: 'dev:local', purpose: 'operations' }));

  // Phase 0 — wire the JobBus (register handlers, enqueue a liveness heartbeat).
  const bus = new InProcessJobBus();
  await bus.start();
  registerEventFanoutHandler(bus, outbox, broker);
  registerHeartbeatHandler(bus, (m) => telemetry.log('info', m, {}));
  // Phase 4 — durable jobs: retention purge + alert evaluation.
  registerRetentionPurgeHandler(bus, retention);
  registerAlertEvaluateHandler(bus, alerts, async () => ({
    'broker.dlq': await broker.deadLetterSize(),
    'outbox.dead': (await outbox.counts()).dead,
    'http.request': 0,
  }));
  await bus.enqueue('retention.purge', { at: new Date().toISOString() }, { idempotencyKey: `ret-${Date.now()}` });
  await bus.enqueue('alert.evaluate', { at: new Date().toISOString() }, { idempotencyKey: `alert-${Date.now()}` });
  registerSnapshotBackupHandler(bus, async (realmId) => {
    await sqlStore.saveRealmSnapshot({ realmId, mode: 'sim', createdAt: new Date().toISOString(), snapshotJson: JSON.stringify({ backedUpAt: new Date().toISOString(), realmId }) });
  });
  registerKnowledgeSyncHandler(bus, async (sourceId) => { telemetry.log('info', `[job-bus] knowledge.sync ${sourceId}`, {}); return { ok: true }; });
  registerAgentTriggerHandler(bus, async (p) => { telemetry.log('info', `[job-bus] agent.trigger ${p.agentId} ${p.triggerType}`, {}); });
  await bus.enqueue('system.heartbeat', { at: new Date().toISOString() }, { idempotencyKey: `hb-${Date.now()}` });

  const app = await buildApp({
    store,
    telemetry,
    packs: [
      healthcareCorePack, dialysisProviderPack, payerPack, ckdNavigationPack, cmsUniversePack,
      oncologyProviderPack, infusionProviderPack, careManagementPack,
      behavioralHealthPack, oncologyDeepPack, homeHealthPack, longTermCarePack,
      radiologyPack, edThroughputPack, revenueCyclePack, hospitalAtHomePack,
    ],
    // Dev auth: honor an explicit `x-actor` header (JSON ActorContext), else a
    // valid console session (`hh_session` cookie), else the local power-user.
    authenticate: async (req: FastifyRequest): Promise<ActorContext> => {
      const raw = req.headers['x-actor'];
      if (typeof raw === 'string') {
        try { return JSON.parse(raw) as ActorContext; } catch { /* fall through */ }
      }
      const viaSession = resolveSessionActor(req);
      if (viaSession) return viaSession;
      return DEV_ACTOR;
    },
    // Readiness must reflect durable-storage truth. `db: false` here means the
    // store is in memory and nothing will survive a restart — previously this was
    // hardcoded true, so a non-durable harness reported itself perfectly healthy.
    checkHealth: async () => ({
      db: durable ? await postgresReachable(durable.pool) : false,
      // This profile runs the in-process job bus, so Redis is genuinely unused;
      // `db` is the field that carries durable-storage truth.
      redis: true,
    }),
    // Phase 0 — write path: append → outbox → broker.
    onEvent: async (event) => {
      // Enqueue only: the durable row IS the delivery guarantee, and OutboxPublisher
      // drains it on its interval. Flushing here as well meant every event swept the
      // outbox in parallel with the publisher's own drain.
      await outbox.enqueue(event);
      await webhookDeliverer.onEvent(event);
    },
    eventBroker: broker,
    liveEventFeed: liveFeed,
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
    ...(process.env.HH_CORS_ORIGINS ? { corsOrigins: process.env.HH_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  });

  const address = await app.listen({ port, host });
  telemetry.log('info', `harness (dev profile) listening on ${address}`, {});

  // Simulator — optional auto-started demo fleet so the whole stack (realms →
  // swarm reasoners → exec console) runs on live synthetic data with no manual
  // setup. Set HH_DEMO_SIM=1 (optionally HH_DEMO_SIM_SCENARIO). The fleet is
  // isolated to sim:* realm ids and reset() tears it down — persisted
  // realms/specs are never touched.
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
  // (reloads/restarts bring the sim back with its realms + controls intact).
  await resumeSimulatorFleet(getSimulatorController(), sqlStore);

  telemetry.log('info', `${durable ? `durable postgres store (${durable.database}/${durable.schema})` : 'IN-MEMORY store (not durable)'} + ${bus.driverName()} job bus + ${broker.driver} event broker (${config.eventBrokerTopic})`, {});
  telemetry.log('info', 'admin UI routes: /admin/*  ·  health: /health  ·  packs: /packs', {});

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.log('info', `shutting down on ${signal}`, {});
    await app.close();
    outboxPublisher.stop();
    await broker.stop();
    await bus.stop();
    // Release the pool so a `tsx watch` reload cannot leak connections.
    await durable?.pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

// Executed only when run directly (e.g. `npm run dev`), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
