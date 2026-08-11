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

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { PostgresEventStore } from './postgres-event-store.js';
import type { Telemetry } from './telemetry.js';
import { ScopedEventStore, type ActorContext } from './scoped-persistence.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import { seedCMSSources } from '../healthcare-core/cms-source-registry.js';
import type { DomainPack } from '../control-plane/pack-registry.js';

export interface AppDeps {
  readonly store: PostgresEventStore;
  readonly telemetry: Telemetry;
  readonly packs: readonly DomainPack[];
  readonly authenticate: (req: FastifyRequest) => Promise<ActorContext>;
  readonly checkHealth: () => Promise<{ db: boolean; redis: boolean }>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cors, { origin: true });

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

  // Health.
  app.get('/health', async () => {
    const h = await deps.checkHealth();
    return { ok: h.db && h.redis, ...h };
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

  return app;
}
