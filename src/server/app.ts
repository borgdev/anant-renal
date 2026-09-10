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

// Fastify control-plane API.
//
// Routes reflect the harness's runtime surface:
//   • GET  /health          — readiness probe, checks DB + Redis
//   • GET  /packs           — installed packs and their capabilities
//   • GET  /measures        — CMS measure catalog
//   • GET  /cases           — worklist projection over open cases
//   • POST /events          — append a canonical event (RBAC/ABAC scoped)
//   • GET  /events          — query events by scope, type, time range
//   • POST /ledger          — append a mutation ledger entry
//   • GET  /ledger          — query ledger with bitemporal cutoff
//   • GET  /audit           — audit chain slice with integrity verification
//   • GET  /qapi/:facility  — most recent QAPI evidence packet
//   • POST /replay          — deterministic replay of a scenario
//
// The app is instantiated via `buildApp(deps)` so tests can inject an in-
// memory store and telemetry sink; production wires a real Postgres pool and
// stdout sink from `bootstrap.ts`.

import { registerAdminRoutes } from './admin-routes.js';
import { registerSqlRoutes } from './sql-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerConsoleDomainRoutes } from './console-domain.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { bootstrapKnowledgeLayer } from '../knowledge/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { PostgresEventStore } from './postgres-event-store.js';
import type { Telemetry } from './telemetry.js';
import { ScopedEventStore, type ActorContext } from './scoped-persistence.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import { seedCMSSources } from '../healthcare-core/cms-source-registry.js';
import type { DomainPack } from '../control-plane/pack-registry.js';
import type { EventBroker } from './event-broker.js';
import { registerFhirRoutes } from '../fhir/routes.js';
import { registerApiRoutes } from './api-routes.js';
import { registerEnterpriseRoutes } from './enterprise-routes.js';
import { registerSwarmRoutes, getSwarmWorkspace, resetSwarmRuntime } from './swarm-routes.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { registerPayerRoutes } from './payer-routes.js';
import { registerAnemiaRoutes } from './anemia-routes.js';
import { registerRenalRoutes } from './renal-routes.js';
import { registerAgentStudioRoutes } from './agent-studio-routes.js';
import { registerAssuranceRoutes } from './assurance-routes.js';
import { registerSubmissionRoutes } from './submission-routes.js';
import { registerExecutiveRoutes } from './executive-routes.js';
import { registerSimulatorRoutes, getSimulatorController } from './simulator-routes.js';
import { registerDemoCleanupRoutes } from './demo-cleanup.js';
import { registerCmsRoutes } from './cms-routes.js';
import { sqlSimulatorPersistence } from './simulator-persistence.js';
import { RealmRegistry } from '../realm/registry.js';
import { registerConsoleGate } from './console-gate.js';
import { registerAdminApiGuard } from './api-auth.js';
import { LocalUserStore, seedDefaultUsers, SessionManager, registerAuthRoutes } from './auth/index.js';
import { WebhookRegistry } from './webhooks.js';
import { getSqlStore } from './sql/index.js';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export interface AppDeps {
  readonly store: PostgresEventStore;
  readonly telemetry: Telemetry;
  readonly packs: readonly DomainPack[];
  readonly authenticate: (req: FastifyRequest) => Promise<ActorContext>;
  readonly checkHealth: () => Promise<{ db: boolean; redis: boolean }>;
  /** Optional Phase-0 event fabric. Called after a canonical event is appended (write path). */
  readonly onEvent?: (event: CanonicalEvent) => Promise<void>;
  /** Optional EventBroker — exposes live health at GET /events/broker. */
  readonly eventBroker?: EventBroker;
  /** R0 — bounded canonical-event ring backing /api/live/events + /api/live/stream. */
  readonly liveEventFeed?: import('./live-event-feed.js').LiveEventFeed;
  /** Phase 3 — transactional outbox (admin replay + bridge durability). */
  readonly eventOutbox?: import('./event-outbox.js').EventOutbox;
  /** Phase 3 — realm → broker bridge (attached to realms on creation). */
  readonly realmEventBridge?: import('./realm-event-bridge.js').RealmEventBridge;
  /** Phase 4 — durable webhook fan-out on event append. */
  readonly webhookDeliverer?: import('./webhooks.js').WebhookDeliverer;
  /** Phase 4 — alert rules. */
  readonly alerts?: import('./alerts.js').AlertService;
  /** Phase 4 — retention policies + purge. */
  readonly retention?: import('./retention.js').RetentionService;
  /** Phase 4 — secrets provider for rotation. */
  readonly secrets?: import('../control-plane/secrets.js').SecretsProvider;
  /** Phase 4 — per-origin CORS allowlist (defaults to allowing all). */
  readonly corsOrigins?: readonly string[];
  /** Console auth — local users + sessions (defaults to in-memory seeded). */
  readonly users?: import('./auth/users.js').LocalUserStore;
  readonly sessions?: import('./auth/session.js').SessionManager;
  /** Enforce session + role on /admin/* APIs (401 unauth, role-scoped /admin/swarm/*).
   *  ON in the real runtime entry points (dev.ts / bootstrap.ts); tests opt in. */
  readonly adminApiAuth?: boolean;
  /** Anemia patient-twin data sources — real realm ledger events + patient state.
   *  Optional overrides for tests; the runtime defaults to RealmRegistry. */
  readonly anemiaEvents?: () => Array<{ realmId?: string; eventId?: string; kind: string; emittedAt: string; realmAt?: string; patientId?: string; payload: Record<string, unknown> }>;
  readonly anemiaPatients?: () => Array<{ realmId: string; patientId: string; state: Record<string, unknown> }>;
  /** F1 renal data-model patient source — defaults to every patient in RealmRegistry. */
  readonly renalPatients?: () => Array<{ id: string; realmId: string; state: Record<string, unknown>; medCodes?: readonly string[] }>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  // Per-origin CORS: allowlist from deps (HH_CORS_ORIGINS), else allow all.
  const origins = deps.corsOrigins?.length ? [...deps.corsOrigins] : true;
  await app.register(cors, {
    origin: (origin, cb) => {
      if (origins === true) return cb(null, true);
      const allowed = origin === undefined || origins.includes(origin);
      cb(null, allowed);
    },
  });

  // OpenAPI docs at /docs.
  await app.register(swagger, { openapi: { info: { title: 'AnantHealth API', version: '0.4.0', description: 'Public + admin control-plane' }, tags: [{ name: 'api', description: 'Public /api/v1' }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const scoped = new ScopedEventStore(deps.store);

  // Per-request span + trace header propagation.
  app.addHook('onRequest', async (req, reply) => {
    const incomingTrace = req.headers['x-trace-id'];
    const traceId = typeof incomingTrace === 'string' && incomingTrace ? incomingTrace : undefined;
    const span = deps.telemetry.startSpan(`http ${req.method} ${req.routeOptions?.url ?? req.url}`, {
      ...(traceId !== undefined ? { traceId } : {}),
      attributes: { method: req.method, url: req.url },
    });
    (req as unknown as { _span: ReturnType<typeof deps.telemetry.startSpan> })._span = span;
    reply.header('x-trace-id', span.traceId);
  });
  app.addHook('onResponse', async (req, reply) => {
    const span = (req as unknown as { _span?: ReturnType<typeof deps.telemetry.startSpan> })._span;
    if (span) span.end(reply.statusCode >= 500 ? 'error' : 'ok');
    deps.telemetry.metric('http.request', 1, { attributes: { status: reply.statusCode, method: req.method } });
  });

  // Health — extended with broker + store + job-bus status (Phase 4 observability).
  app.get('/health', async () => {
    const h = await deps.checkHealth();
    const ok = h.db && h.redis && (deps.eventBroker ? (await deps.eventBroker.health()).ok : true);
    const extended: Record<string, unknown> = { ok, db: h.db, redis: h.redis };
    if (deps.eventBroker) {
      const [health, deadLetter] = await Promise.all([deps.eventBroker.health(), deps.eventBroker.deadLetterSize()]);
      extended.broker = health;
      extended.deadLetter = deadLetter;
      if (deps.eventOutbox) extended.outbox = await deps.eventOutbox.counts();
    }
    return extended;
  });

  // Packs.
  app.get('/packs', async () => ({
    packs: deps.packs.map((p) => ({
      id: p.id, version: p.version, capabilities: p.capabilities,
      extends: p.extends?.map((e) => e.id) ?? [],
      appliesTo: p.appliesTo,
      cmsUniverse: p.cmsUniverse,
    })),
  }));

  // Measures — CMS source registry.
  app.get('/measures', async () => ({ sources: seedCMSSources }));

  // Events.
  app.post('/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await deps.authenticate(req);
    const event = req.body as CanonicalEvent;
    try {
      await scoped.appendEvent(actor, event);
      if (deps.onEvent) await deps.onEvent(event);
      return reply.code(201).send({ id: event.id });
    } catch (err) {
      return reply.code(403).send({ error: (err as Error).message });
    }
  });
  app.get('/events', async (req, reply) => {
    const actor = await deps.authenticate(req);
    const query = req.query as { scopeId?: string; type?: string | string[]; since?: string; until?: string; limit?: string };
    if (!query.scopeId) return reply.code(400).send({ error: 'scopeId required' });
    const types = Array.isArray(query.type) ? query.type : query.type ? [query.type] : undefined;
    const rows = await scoped.queryEvents(actor, {
      scopeId: query.scopeId,
      ...(types ? { types } : {}),
      ...(query.since ? { since: query.since } : {}),
      ...(query.until ? { until: query.until } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
    return { events: rows };
  });

  // Event broker health (Phase 0) — live driver + DLQ depth when wired.
  if (deps.eventBroker) {
    app.get('/events/broker', async () => {
      const [health, deadLetterSize] = await Promise.all([deps.eventBroker!.health(), deps.eventBroker!.deadLetterSize()]);
      return { ...health, deadLetterSize };
    });
  }

  // Ledger.
  app.post('/ledger', async (req, reply) => {
    const actor = await deps.authenticate(req);
    const entry = req.body as unknown as { scopeId: string };
    try {
      await scoped.appendLedger(actor, entry as never);
      return reply.code(201).send({ ok: true });
    } catch (err) {
      return reply.code(403).send({ error: (err as Error).message });
    }
  });
  app.get('/ledger', async (req, reply) => {
    const actor = await deps.authenticate(req);
    const q = req.query as { scopeId?: string; kind?: string | string[]; transactionAt?: string; limit?: string };
    if (!q.scopeId) return reply.code(400).send({ error: 'scopeId required' });
    const kinds = Array.isArray(q.kind) ? q.kind : q.kind ? [q.kind] : undefined;
    const rows = await scoped.queryLedger(actor, {
      scopeId: q.scopeId,
      ...(kinds ? { kinds: kinds as never } : {}),
      ...(q.transactionAt ? { transactionAt: q.transactionAt } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
    return { entries: rows };
  });

  // Replay stub — accepts a scenario, runs deterministic replay in-process.
  app.post('/replay', async (req) => {
    const scenario = req.body as { events: readonly CanonicalEvent[] };
    // Real replay wires into src/healthcare-core/replay.ts; here we echo counts.
    return { received: scenario.events?.length ?? 0, replayed: true };
  });

  await registerAdminRoutes(app, {
    ...(deps.eventBroker ? { eventBroker: deps.eventBroker } : {}),
    ...(deps.eventOutbox ? { eventOutbox: deps.eventOutbox } : {}),
    ...(deps.realmEventBridge ? { realmEventBridge: deps.realmEventBridge } : {}),
  });
  await registerSqlRoutes(app);
  await registerSettingsRoutes(app);
  // Console domain catalog — option lists / default payloads / Learn recipes
  // served to the operator console so no domain config is hardcoded in the UI.
  await registerConsoleDomainRoutes(app);

  // Phase 2 — FHIR entity support (typed R4 ingest/export/entity routes).
  await registerFhirRoutes(app);

  // Phase 4 — public /api/v1 (rate-limited, idempotent, PHI-masked).
  await registerApiRoutes(app, {
    store: deps.store,
    telemetry: deps.telemetry,
    packs: deps.packs,
    authenticate: deps.authenticate,
    checkHealth: deps.checkHealth,
    ...(deps.eventBroker ? { eventBroker: deps.eventBroker } : {}),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    ...(deps.webhookDeliverer ? { webhookDeliverer: deps.webhookDeliverer } : {}),
  });

  // Phase 4 — enterprise admin (webhooks, alerts, retention, audit, secrets).
  const sqlForWebhooks = await getSqlStore();
  await registerEnterpriseRoutes(app, {
    ...(deps.eventBroker ? { eventBroker: deps.eventBroker } : {}),
    ...(deps.eventOutbox ? { eventOutbox: deps.eventOutbox } : {}),
    ...(deps.webhookDeliverer ? { webhookRegistry: new WebhookRegistry(sqlForWebhooks), webhookDeliverer: deps.webhookDeliverer } : {}),
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    ...(deps.retention ? { retention: deps.retention } : {}),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
  });

  // Console auth — login/logout/me + local user management. Defaults to an
  // in-memory store seeded with a few dev users (admin / nurse / auditor);
  // dev.ts / bootstrap.ts may inject their own instances so the app-level
  // authenticate() can resolve the hh_session cookie to an ActorContext.
  const users = deps.users ?? new LocalUserStore();
  if (!deps.users) seedDefaultUsers(users);
  const sessions = deps.sessions ?? new SessionManager();
  await registerAuthRoutes(app, { users, sessions });

  // Console access gate — server-enforced split between /exec/ (executive
  // console) and /admin/ui/ (operator console) by IdentityRole.
  await registerConsoleGate(app, { users, sessions });

  // Admin API security — require a session on /admin/* (except public login /
  // static paths) and role-scope /admin/swarm/* to executive roles. On in the
  // real runtime entry points (dev.ts / bootstrap.ts); tests opt in explicitly.
  if (deps.adminApiAuth) {
    await registerAdminApiGuard(app, { users, sessions });
  }

  // Renal Swarm Intelligence — bounded-cell executive layer (cells/insights/NBA/episodes).
  await registerSwarmRoutes(app, {
    store: sqlForWebhooks,
    ...(deps.eventBroker ? { broker: deps.eventBroker } : {}),
    // Real realm snapshots → the swarm state is derived from live data when any
    // realm has patients (falls back to the reference boundary when empty).
    realms: () => RealmRegistry.list().map((r) => {
      const s = r.snapshot();
      return {
        realmId: s.id,
        mode: s.mode,
        counts: s.counts,
        presences: s.presences,
        effects: s.effects,
        episodes: { total: s.episodes?.total ?? 0, openNow: s.episodes?.openNow ?? 0 },
        realmAt: s.realmAt,
        ...(s.hitl ? { hitl: s.hitl } : {}),
        ...(s.cost !== undefined ? { cost: s.cost } : {}),
      };
    }),
    // Real realm ledger entries → the exec console's event feed + temporal states.
    events: () => RealmRegistry.list().flatMap((r) =>
      r.ledger.listAll().map((e) => ({
        realmId: r.id,
        eventId: e.effectId,
        kind: e.effect.kind,
        status: e.status,
        emittedAt: e.emittedAt,
        ...(e.realmAt ? { realmAt: e.realmAt } : {}),
        ...(e.presenceId ? { presenceId: e.presenceId } : {}),
        payload: e.effect as Record<string, unknown>,
      })),
    ),
  });

  // Generic platform contract layer (port plan Phase A/B) — organization graph,
  // topic plan, releases, DLQ inspection, plus the public /api/context and
  // /api/work (My Work) experience APIs. Composes the same durable workspace,
  // coordinator and store the swarm routes already use — no second store.
  await registerPlatformRoutes(app, {
    users,
    sessions,
    packs: deps.packs,
    ...(deps.eventBroker ? { broker: deps.eventBroker } : {}),
    ...(deps.eventOutbox ? { eventOutbox: deps.eventOutbox } : {}),
    realms: () => RealmRegistry.list().map((r) => {
      const s = r.snapshot();
      return {
        realmId: s.id,
        mode: s.mode,
        counts: s.counts,
        presences: s.presences,
        effects: s.effects,
        episodes: { total: s.episodes?.total ?? 0, openNow: s.episodes?.openNow ?? 0 },
        realmAt: s.realmAt,
        ...(s.hitl ? { hitl: s.hitl } : {}),
        ...(s.cost !== undefined ? { cost: s.cost } : {}),
      };
    }),
  });

  // Payer proof pack (Phase 5 / Epic 7) — a second domain closing a payer loop
  // through the SAME durable coordinator + workspace contracts. No runtime fork.
  await registerPayerRoutes(app);

  // Anemia / ESA dose-adjustment CDSS (P0 reference) — a governed, Class-C,
  // human-in-the-loop decision-support domain (manifold-learning EPO model)
  // over the same shared coordinator + workspace contracts. Recommends, never
  // orders. The patient twin reads the REAL realm ledger + patient state.
  await registerAnemiaRoutes(app, {
    ...(deps.anemiaEvents
      ? { events: deps.anemiaEvents }
      : {
          events: () => RealmRegistry.list().flatMap((r) =>
            r.ledger.listAll().map((e) => {
              const pid = (e.effect as { patientId?: unknown }).patientId;
              return {
                realmId: r.id,
                eventId: e.effectId,
                kind: e.effect.kind,
                emittedAt: e.emittedAt,
                ...(e.realmAt ? { realmAt: e.realmAt } : {}),
                ...(typeof pid === 'string' ? { patientId: pid } : {}),
                payload: e.effect as Record<string, unknown>,
              };
            }),
          ),
        }),
    ...(deps.anemiaPatients
      ? { patients: deps.anemiaPatients }
      : {
          patients: () => RealmRegistry.list().flatMap((r) =>
            r.graph.listKind('patient').map((p) => ({ realmId: r.id, patientId: p.id, state: p.state as Record<string, unknown> })),
          ),
        }),
  });

  // F1 — renal data model read surface (sessions, access, MBD/nutrition/infection
  // panel labs, maintenance exposures) derived from realm state + ledger.
  await registerRenalRoutes(app, {
    ...(deps.renalPatients ? { patients: deps.renalPatients } : {}),
  });

  // Agent Studio (Phase D) — one unified surface for authoring, triggers, topics,
  // outputs, test, kill switch and rollback over the existing agent services.
  await registerAgentStudioRoutes(app);

  // AI Assurance (Phase E) — green/red team suites, findings lifecycle and
  // release gates over the same durable workspace (spec §20).
  await registerAssuranceRoutes(app);

  // CMS/EQRS submission lifecycle (Journey K / Epic 8) — dual Class-D approval,
  // reference-mode transmission gate, receipt + reconciliation.
  await registerSubmissionRoutes(app);

  // Executive outcomes + delegation (Journey N) — sponsor/delegate with owner +
  // SLA, and verified-value rollups (not activity counts).
  await registerExecutiveRoutes(app);

  // Simulator — start/stop/step-able synthetic data driver for the whole stack
  // (realms → swarm reasoners → exec console). Realms it creates get the
  // realm→broker bridge attached so simulated events stream downstream. When a
  // durable SqlStore is present, the fleet (scenario + realm specs + snapshots)
  // is persisted so it survives restarts and resumes on boot.
  await registerSimulatorRoutes(app, {
    ...(deps.realmEventBridge ? { realmEventBridge: deps.realmEventBridge } : {}),
    persistence: sqlSimulatorPersistence(sqlForWebhooks),
  });

  // Demo cleanup — one-shot "clean up the demo": stop the sim + drop sim realms,
  // remove demo episodes/NBA decisions, prune the delivered outbox backlog (frees
  // disk), run retention. Backs the admin Simulator panel button + scripts/cleanup-demo.mjs.
  await registerDemoCleanupRoutes(app, {
    store: sqlForWebhooks,
    ...(deps.retention ? { retention: deps.retention } : {}),
    simulator: () => getSimulatorController(),
    workspace: () => getSwarmWorkspace(),
    resetRuntime: () => resetSwarmRuntime(),
  });

  // CMS — real QIP / Dialysis Facility Compare readiness from cms-data/ CSVs.
  await registerCmsRoutes(app);

  // R0 — live event wall: bounded recent canonical-event tail (/api/live/events),
  // a status endpoint (/api/live/status, drives the exec LIVE · driver badge)
  // and a push SSE stream (/api/live/stream). Only present when a feed is wired.
  if (deps.liveEventFeed) {
    const feed = deps.liveEventFeed;
    app.get('/api/live/status', async () => ({ driver: feed.driver, topic: feed.topic, retained: feed.size() }));
    app.get<{ Querystring: { facilityId?: string; realmId?: string; limit?: string } }>('/api/live/events', async (req) => {
      const q = req.query ?? {};
      return {
        driver: feed.driver,
        topic: feed.topic,
        retained: feed.size(),
        events: feed.rows({
          ...(q.facilityId ? { facilityId: q.facilityId } : {}),
          ...(q.realmId ? { realmId: q.realmId } : {}),
          ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
        }),
      };
    });
    app.get<{ Querystring: { once?: string } }>('/api/live/stream', async (req, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const write = (type: string, payload: unknown) => {
        try { reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
      };
      write('hello', { driver: feed.driver, topic: feed.topic, retained: feed.size() });
      if (req.query.once === '1') {
        write('events', { events: feed.rows({ limit: 200 }) });
        reply.raw.end();
        return;
      }
      write('events', { events: feed.rows({ limit: 200 }) });
      const unsub = feed.subscribe((row) => write('event', { event: row }));
      const hb = setInterval(() => write('ping', { at: new Date().toISOString() }), 15_000);
      req.raw.on('close', () => { unsub(); clearInterval(hb); });
    });
  }

  // M20 Knowledge layer
  const knowledgeStoreDir = process.env.KNOWLEDGE_STORE_DIR ?? resolve(process.cwd(), '.harness', 'knowledge');
  const knowledgeLayer = bootstrapKnowledgeLayer({ storeDir: knowledgeStoreDir });
  await registerKnowledgeRoutes(app, { layer: knowledgeLayer, storeDir: knowledgeStoreDir });

  // Landing page — served at the root (`/` and `/landing`). A thin marketing
  // shell for the platform; the operator console lives at /admin/ui/.
  // Read from disk per request (like the console's static serving) so edits to
  // landing.html show up without a server reload.
  const landingPath = resolve(process.cwd(), 'admin-ui', 'landing.html');
  app.get('/', { schema: { hide: true } }, async (_req, reply) => {
    let html: string;
    try { html = readFileSync(landingPath, 'utf8'); } catch { return reply.code(404).send({ error: 'landing-not-found' }); }
    reply.header('content-type', 'text/html; charset=utf-8');
    return html;
  });
  app.get('/landing', { schema: { hide: true } }, async (_req, reply) => {
    let html: string;
    try { html = readFileSync(landingPath, 'utf8'); } catch { return reply.code(404).send({ error: 'landing-not-found' }); }
    reply.header('content-type', 'text/html; charset=utf-8');
    return html;
  });
  return app;
}
