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

// Public API surface (Phase 4) — /api/v1/*, rate-limited + documented via
// OpenAPI. Keeps /admin/* internal. Rides the same ActorContext clearance /
// scope gates; PHI reads below restricted-phi are masked; writes honor
// Idempotency-Key. Every event append is projected to the audit mirror and
// fanned out to webhooks.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RealmRegistry } from '../realm/index.js';
import type { EntityKind } from '../realm/types.js';
import { serializeRealmEntity, exportRealmBundle } from '../fhir/export.js';
import { parseBundle } from '../fhir/fhir-bundle.js';
import { ingestFhirBundle, lookupBundleIngest, recordBundleIngest } from '../fhir/bundle-ingest.js';
import type { FhirCtx } from '../fhir/types.js';
import { seedCMSSources } from '../healthcare-core/cms-source-registry.js';
import type { DomainPack } from '../control-plane/pack-registry.js';
import type { PostgresEventStore } from './postgres-event-store.js';
import type { Telemetry } from './telemetry.js';
import { ScopedEventStore, type ActorContext } from './scoped-persistence.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { EventBroker } from './event-broker.js';
import type { SqlStore } from './sql/sql-store.js';
import { getSqlStore } from './sql/index.js';
import { IdempotencyRegistry } from './idempotency.js';
import { canonicalToAuditRow } from './audit.js';
import { buildDsar } from './dsar.js';
import { maskPhi, canReadPhi } from './mask.js';
import type { WebhookDeliverer } from './webhooks.js';

export interface ApiRoutesDeps {
  readonly store: PostgresEventStore;
  readonly telemetry: Telemetry;
  readonly packs: readonly DomainPack[];
  readonly authenticate: (req: FastifyRequest) => Promise<ActorContext>;
  readonly checkHealth: () => Promise<{ db: boolean; redis: boolean }>;
  readonly eventBroker?: EventBroker;
  /** Write-path hook (outbox → broker). */
  readonly onEvent?: (event: CanonicalEvent) => Promise<void>;
  /** Phase 4 — webhook fan-out on event append. */
  readonly webhookDeliverer?: WebhookDeliverer;
}

export interface ApiRoutesResult {
  readonly idempotency: IdempotencyRegistry;
  readonly audit: (evt: CanonicalEvent, actor: ActorContext) => Promise<void>;
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiRoutesDeps): Promise<ApiRoutesResult> {
  const scoped = new ScopedEventStore(deps.store);
  const sql: SqlStore = await getSqlStore();
  const idempotency = new IdempotencyRegistry(sql);

  const audit = async (evt: CanonicalEvent, actor: ActorContext): Promise<void> => {
    try { await sql.appendAuditEvent(canonicalToAuditRow(evt, actor.actorRef)); } catch { /* best-effort */ }
  };

  await app.register(async (api) => {
    // Per-origin CORS is configured at the app level; here we rate-limit the public surface.
    await api.register(import('@fastify/rate-limit').then((m) => m.default), {
      max: Number(process.env.HH_RATE_LIMIT_MAX ?? 300),
      timeWindow: Number(process.env.HH_RATE_LIMIT_WINDOW_MS ?? 60_000),
      keyGenerator: (req: FastifyRequest) => req.ip,
    });

    api.get('/health', { schema: { tags: ['api'] } }, async () => deps.checkHealth());

    api.get('/packs', { schema: { tags: ['api'] } }, async () => ({
      packs: deps.packs.map((p) => ({ id: p.id, version: p.version, capabilities: p.capabilities, appliesTo: p.appliesTo })),
    }));

    api.get('/measures', { schema: { tags: ['api'] } }, async () => ({ sources: seedCMSSources }));

    // Realm summary (no PHI).
    api.get('/realms', { schema: { tags: ['api'] } }, async () => ({
      realms: RealmRegistry.list().map((r) => {
        const snap = r.snapshot();
        return { id: r.id, mode: r.mode, realmAt: snap.realmAt ?? null, counts: snap.counts ?? null };
      }),
    }));

    // FHIR entity read (masked below restricted-phi).
    api.get<{ Params: { realmId: string; kind: EntityKind; id: string } }>('/fhir/:realmId/:kind/:id', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      if (!actor.scopeIds.includes(req.params.realmId) && !actor.scopeIds.includes('scope:*')) return reply.code(403).send({ error: 'scope-denied' });
      const realm = RealmRegistry.get(req.params.realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      const resources = serializeRealmEntity(realm, req.params.kind, req.params.id, { realmId: req.params.realmId, facilityId: 'f1', scopeId: req.params.realmId, sourceId: 'api', ingestedAt: new Date().toISOString() });
      if (resources.length === 0) return reply.code(404).send({ error: 'no-fhir-resource' });
      const resource = resources.length === 1 ? resources[0] : { resourceType: 'Bundle', type: 'collection', entry: resources.map((res) => ({ resource: res })) };
      reply.header('content-type', 'application/fhir+json');
      return canReadPhi(actor.clearance) ? resource : maskPhi(resource, actor.clearance);
    });

    // Realm FHIR export (masked below restricted-phi).
    api.get<{ Params: { realmId: string } }>('/fhir/export/:realmId', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      if (!actor.scopeIds.includes(req.params.realmId) && !actor.scopeIds.includes('scope:*')) return reply.code(403).send({ error: 'scope-denied' });
      const realm = RealmRegistry.get(req.params.realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      const bundle = exportRealmBundle(realm, { realmId: req.params.realmId, facilityId: 'f1', scopeId: req.params.realmId, sourceId: 'api', ingestedAt: new Date().toISOString() });
      reply.header('content-type', 'application/fhir+json');
      return canReadPhi(actor.clearance) ? bundle : maskPhi(bundle, actor.clearance);
    });

    // Public FHIR Bundle ingest (Phase C) — transaction/batch/message/collection
    // dispatches on Bundle.type; gated by phi clearance + realm scope; idempotent
    // by bundle.id (same content → replay cached result; same id + diff content → 409).
    api.post<{ Body: { realmId: string; bundle: unknown; presence?: { agentSpecId?: string; role?: string; clearance?: string; facilityId?: string; unitId?: string; purposeOfUse?: string[] }; dryRun?: boolean }; Querystring: { realmId?: string; dryRun?: string } }>('/fhir', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      if (!canReadPhi(actor.clearance)) return reply.code(403).send({ error: 'clearance-denied' });
      const realmId = req.body?.realmId ?? req.query.realmId;
      if (!realmId) return reply.code(400).send({ error: 'realm-required' });
      if (!actor.scopeIds.includes(realmId) && !actor.scopeIds.includes('scope:*')) return reply.code(403).send({ error: 'scope-denied' });
      const realm = RealmRegistry.get(realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      if (!req.body?.bundle) return reply.code(400).send({ error: 'bundle-required' });
      let parsed;
      try { parsed = parseBundle(req.body.bundle); } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }

      const dryRun = req.body?.dryRun === true || req.query.dryRun === '1' || req.query.dryRun === 'true';

      // bundle.id idempotency — reconcile instead of duplicating.
      const cached = lookupBundleIngest(realmId, parsed);
      if (cached.duplicate) {
        if (cached.conflict) return reply.code(409).send({ error: 'bundle-conflict', message: 'same bundle.id with different content' });
        return { ...cached.result!, duplicate: true };
      }

      const ctx: FhirCtx = { realmId, facilityId: req.body?.presence?.facilityId ?? 'f1', scopeId: realmId, sourceId: 'api', ingestedAt: new Date().toISOString() };
      const result = await ingestFhirBundle(realm, ctx, parsed, {
        ...(req.body?.presence ? { presenceInit: req.body.presence } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });
      recordBundleIngest(realmId, parsed, result);
      const payload = {
        realmId,
        bundleType: result.bundleType,
        mode: result.mode,
        applied: result.applied,
        rolledBack: result.rolledBack,
        dryRun: result.dryRun,
        entries: result.entries,
        ...(result.response ? { response: result.response } : {}),
        summary: result.summary,
      };
      reply.header('content-type', 'application/fhir+json');
      return canReadPhi(actor.clearance) ? payload : maskPhi(payload, actor.clearance);
    });

    // Append a canonical event (idempotent via Idempotency-Key).
    api.post<{ Body: CanonicalEvent }>('/events', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      const event = req.body;
      const keyHeader = req.headers['idempotency-key'];
      const key = typeof keyHeader === 'string' && keyHeader ? keyHeader : undefined;
      const compute = async (): Promise<unknown> => {
        await scoped.appendEvent(actor, event);
        await audit(event, actor);
        if (deps.webhookDeliverer) { try { await deps.webhookDeliverer.onEvent(event); } catch { /* webhook failures are durable + async */ } }
        if (deps.onEvent) await deps.onEvent(event);
        return { id: event.id, status: 'accepted', scopeId: event.scopeId };
      };
      try {
        if (key) {
          const result = await idempotency.resolve(key, 'POST', '/api/v1/events', event, compute);
          reply.header('x-idempotent-replayed', result.replayed ? 'true' : 'false');
          return result.response;
        }
        return await compute();
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    });

    // Audit mirror read (compliance; clearance-gated).
    api.get<{ Querystring: { scopeId?: string; action?: string; limit?: string } }>('/audit', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      if (actor.clearance !== 'phi' && actor.clearance !== 'restricted-phi') return reply.code(403).send({ error: 'clearance-denied' });
      const rows = await sql.listAuditEvents({
        ...(req.query.scopeId ? { scopeId: req.query.scopeId } : {}),
        ...(req.query.action ? { action: req.query.action } : {}),
        ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      });
      return { audit: rows };
    });

    // ePHI DSAR (raw) — restricted-phi only.
    api.get<{ Params: { realmId: string; patientId: string } }>('/dsar/:realmId/:patientId', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      if (actor.clearance !== 'restricted-phi') return reply.code(403).send({ error: 'clearance-denied' });
      const realm = RealmRegistry.get(req.params.realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      const dsar = buildDsar(realm, req.params.patientId);
      if (!dsar) return reply.code(404).send({ error: 'patient-not-found' });
      return dsar.raw;
    });

    // ePHI DSAR — anonymized export (any clearance with scope).
    api.get<{ Params: { realmId: string; patientId: string } }>('/dsar/anonymized/:realmId/:patientId', { schema: { tags: ['api'] } }, async (req, reply) => {
      const actor = await deps.authenticate(req);
      if (!actor.scopeIds.includes(req.params.realmId) && !actor.scopeIds.includes('scope:*')) return reply.code(403).send({ error: 'scope-denied' });
      const realm = RealmRegistry.get(req.params.realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      const dsar = buildDsar(realm, req.params.patientId);
      if (!dsar) return reply.code(404).send({ error: 'patient-not-found' });
      return dsar.anonymized;
    });
  }, { prefix: '/api/v1' });

  return { idempotency, audit };
}
