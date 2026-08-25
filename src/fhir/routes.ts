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

// FHIR routes (Phase 2) — ingest bundles into a realm, export a realm as R4,
// and read individual entities as FHIR resources.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RealmRegistry } from '../realm/index.js';
import type { EntityKind } from '../realm/types.js';
import { getSqlStore } from '../server/sql/index.js';
import { parseBundle } from './fhir-bundle.js';
import { RESOURCE_TO_KIND, KIND_TO_RESOURCES } from './mapping.js';
import { ingestCanonicalEvents } from './canonical.js';
import { ingestFhirBundle, lookupBundleIngest, recordBundleIngest, BundleTooLargeError } from './bundle-ingest.js';
import { exportRealmBundle, serializeRealmEntity } from './export.js';
import { cdsHooksToCards, type CdsHooksRequest } from './cds-hooks.js';
import { FhirClient } from './client.js';
import { FhirSubscriptionPump } from './subscription.js';
import { R4_RESOURCES } from './r4-inventory.js';
import { FhirEmulator, emulatorSearchBundle, seedFhirDataset } from './emulator.js';
import { TYPED_FHIR_RESOURCES, type FhirCtx } from './types.js';

// Process-wide in-process FHIR emulator (EHR-bridge test double). Seeded via
// POST /admin/fhir/emulator/seed; the subscription poll points its FhirClient
// at the /fhir-mock/:resourceType search endpoint for a real live pull.
const fhirEmulator = new FhirEmulator();

export interface RegisterFhirRoutesOptions {
  /** Optional store override (defaults to the process-wide SqlStore). */
  store?: Awaited<ReturnType<typeof getSqlStore>>;
}

export async function registerFhirRoutes(app: FastifyInstance, opts: RegisterFhirRoutesOptions = {}): Promise<void> {
  const store = opts.store ?? await getSqlStore();

  function ctxFor(realmId: string, sourceId = 'fhir-api', facilityId = 'f1'): FhirCtx {
    return { realmId, facilityId, scopeId: realmId, sourceId, ingestedAt: new Date().toISOString() };
  }

  // Ingest a FHIR Bundle into a live realm (consume path).
  // Phase A: bundle-aware reference resolution + structural-first ordering.
  // Phase B: transaction (atomic, rolled back on failure) / batch / message /
  // collection semantics with per-entry status + a transaction/batch/message-response.
  // Phase C: dry-run previews, bundle.id idempotency, entry-count guard (413).
  app.post<{ Body: { realmId: string; bundle: unknown; presence?: { agentSpecId?: string; role?: string; clearance?: string; facilityId?: string; unitId?: string; purposeOfUse?: string[] }; dryRun?: boolean }; Querystring: { dryRun?: string } }>('/admin/fhir/ingest', async (req, reply) => {
    try {
      const { realmId, bundle, presence } = req.body ?? {};
      const r = RealmRegistry.get(realmId);
      if (!r) return reply.code(404).send({ error: 'realm-not-found' });
      if (!bundle) return reply.code(400).send({ error: 'bundle-required' });

      const parsed = parseBundle(bundle);
      const dryRun = req.body?.dryRun === true || req.query.dryRun === '1' || req.query.dryRun === 'true';
      const ctx = ctxFor(realmId, 'fhir-ingest', presence?.facilityId ?? 'f1');

      // bundle.id idempotency — reconcile instead of duplicating.
      const cached = lookupBundleIngest(realmId, parsed);
      if (cached.duplicate && !dryRun) {
        if (cached.conflict) return reply.code(409).send({ error: 'bundle-conflict', message: 'same bundle.id with different content' });
        return { ...cached.result!, duplicate: true };
      }

      const result = await ingestFhirBundle(r, ctx, parsed, {
        store,
        ...(presence ? { presenceInit: presence } : {}),
        ...(presence?.unitId ? { defaultUnitId: presence.unitId } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });
      recordBundleIngest(realmId, parsed, result);

      return {
        realmId,
        bundleType: result.bundleType,
        mode: result.mode,
        applied: result.applied,
        rolledBack: result.rolledBack,
        dryRun: result.dryRun,
        entries: result.entries,
        ...(result.response ? { response: result.response } : {}),
        summary: result.summary,
        // backward-compatible summary fields
        hydrated: result.summary.hydrated,
        persisted: result.summary.persisted,
        effectsApplied: result.summary.effectsApplied,
        effectsRejected: result.summary.effectsRejected,
        structuralUpserts: result.summary.structuralUpserts,
        skipped: result.summary.skipped,
      };
    } catch (err) {
      if (err instanceof BundleTooLargeError) return reply.code(413).send({ error: err.message });
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Export a realm as a FHIR Bundle (produce path).
  app.get<{ Params: { realmId: string }; Querystring: { includeEffects?: string; includeDerived?: string } }>('/admin/fhir/export/:realmId', async (req, reply) => {
    const r = RealmRegistry.get(req.params.realmId);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const ctx = ctxFor(req.params.realmId);
    const bundle = exportRealmBundle(r, ctx, {
      includeEffects: req.query.includeEffects === '1' || req.query.includeEffects === 'true',
      includeDerived: req.query.includeDerived === '1' || req.query.includeDerived === 'true',
    });
    reply.header('content-type', 'application/fhir+json');
    return bundle;
  });

  // Read a single entity as its FHIR resource(s).
  app.get<{ Params: { realmId: string; kind: EntityKind; id: string } }>('/admin/fhir/entity/:realmId/:kind/:id', async (req, reply) => {
    const r = RealmRegistry.get(req.params.realmId);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const resources = serializeRealmEntity(r, req.params.kind, req.params.id, ctxFor(req.params.realmId));
    if (resources.length === 0) return reply.code(404).send({ error: 'no-fhir-resource', kind: req.params.kind });
    reply.header('content-type', 'application/fhir+json');
    return resources.length === 1 ? resources[0] : { resourceType: 'Bundle', type: 'collection', entry: resources.map((res) => ({ resource: res })) };
  });

  // Durable mirror + mapping metadata (for the admin FHIR panel).
  app.get<{ Querystring: { realmId?: string; resourceType?: string; direction?: 'in' | 'out'; limit?: string } }>('/admin/fhir/resources', async (req) => {
    const rows = await store.listFhirResources({
      ...(req.query.realmId ? { realmId: req.query.realmId } : {}),
      ...(req.query.resourceType ? { resourceType: req.query.resourceType } : {}),
      ...(req.query.direction ? { direction: req.query.direction } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return { resources: rows.map((r) => ({ ...r, resource: JSON.parse(r.resourceJson) as unknown })) };
  });

  app.get('/admin/fhir/map', async () => ({
    resourceToKind: RESOURCE_TO_KIND,
    kindToResources: KIND_TO_RESOURCES,
  }));

  // Coverage report — typed vs mapped vs missing against the official R4 list.
  app.get('/admin/fhir/coverage', async () => {
    const typedSet = new Set(TYPED_FHIR_RESOURCES);
    const mappedSet = new Set(Object.keys(RESOURCE_TO_KIND));
    return {
      r4Total: R4_RESOURCES.length,
      typedTotal: TYPED_FHIR_RESOURCES.length,
      mappedTotal: mappedSet.size,
      missingTotal: R4_RESOURCES.filter((r) => !typedSet.has(r)).length,
      typed: TYPED_FHIR_RESOURCES.map((rt) => ({
        resourceType: rt,
        kind: RESOURCE_TO_KIND[rt] ?? null,
        mapped: mappedSet.has(rt),
      })),
      missing: R4_RESOURCES.filter((r) => !typedSet.has(r)),
      kindToResources: KIND_TO_RESOURCES,
      // AuditEvent rides the provenance/audit stream (canonical events → audit rows → R4 AuditEvent).
      auditProvenance: {
        projected: true,
        endpoint: '/admin/audit/fhir',
        note: 'Every canonical event is projected to an R4 AuditEvent via canonicalToFhirAudit and mirrored to /admin/audit/fhir as a Bundle.',
      },
    };
  });

  // CDS Hooks (Phase 5) — clinical decision support cards from a live realm.
  app.post<{ Body: CdsHooksRequest; Querystring: { realmId?: string } }>('/admin/fhir/cds-hooks', async (req, reply) => {
    const body = req.body ?? ({} as CdsHooksRequest);
    const realmId = req.query.realmId ?? (body.context as { realmId?: string } | undefined)?.realmId ?? RealmRegistry.list()[0]?.id;
    const r = realmId ? RealmRegistry.get(realmId) : undefined;
    if (!r) return reply.code(404).send({ error: 'realm-not-found', hint: 'create a realm or pass ?realmId=' });
    const response = cdsHooksToCards(body, r);
    reply.header('content-type', 'application/json');
    return response;
  });

  // In-process FHIR emulator (EHR-bridge test double).
  app.post('/admin/fhir/emulator/seed', async () => {
    const seeded = fhirEmulator.seed(seedFhirDataset());
    return { ok: true, seeded, byType: countByType(fhirEmulator.list()) };
  });
  app.get('/admin/fhir/emulator/state', async () => ({
    count: fhirEmulator.count(),
    byType: countByType(fhirEmulator.list()),
  }));
  // Public R4 search endpoint the subscription pump fetches from.
  app.get<{ Params: { resourceType: string }; Querystring: { _lastUpdated?: string; _count?: string; _sort?: string } }>('/fhir-mock/:resourceType', async (req) => {
    return emulatorSearchBundle(fhirEmulator, req.params.resourceType, req.query);
  });

  // FHIR Subscription / change-data-capture pump — poll a remote FHIR server's
  // `_lastUpdated` history, hydrate changes into CanonicalEvents for a realm, AND
  // apply them to a live realm (twin-mode keep-current). Runs one poll; the
  // cursor (`nextSince`) is returned for the next poll.
  app.post<{ Body: {
    baseUrl: string;
    bearerToken?: string;
    resourceTypes?: string[];
    realmId?: string;
    since?: string;
    facilityId?: string;
  } }>('/admin/fhir/subscription/poll', async (req, reply) => {
    const { baseUrl, bearerToken, realmId, facilityId, since, resourceTypes } = req.body ?? {};
    if (!baseUrl) return reply.code(400).send({ error: 'baseUrl-required' });
    const types = resourceTypes?.length ? resourceTypes : ['Patient', 'Observation', 'Encounter'];
    const client = new FhirClient({
      baseUrl,
      ...(bearerToken ? { bearerToken } : {}),
    });
    const targetRealm = realmId ? RealmRegistry.get(realmId) : undefined;
    const ctx = ctxFor(realmId ?? 'realm:fhir', 'fhir-subscription', facilityId ?? 'f1');
    const pump = new FhirSubscriptionPump({ client, ctx, resourceTypes: types, ...(since ? { since } : {}) });
    try {
      const result = await pump.poll();
      // Apply the fetched resources to the realm (keep-current) — structural
      // upserts + effect-able resources, mirroring the ingest route.
      let ingested = 0;
      let structural = 0;
      let skipped: string[] = [];
      if (targetRealm && result.events.length > 0) {
        const presence = targetRealm.spawnPresence({
          agentSpecId: 'fhir-subscription', runId: `fhir-poll-${Date.now()}`,
          role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
          location: { facilityId: ctx.facilityId, unitId: 'U1' },
        });
        const ing = ingestCanonicalEvents({ realm: targetRealm, ctx, presence, events: result.events });
        ingested = result.events.length;
        structural = ing.structural.length;
        skipped = ing.skipped;
      }
      return {
        ok: true,
        fetched: result.fetched,
        events: result.events.length,
        ...(targetRealm ? { ingested, structuralUpserts: structural, skipped } : {}),
        nextSince: result.nextSince,
        eventTypes: [...new Set(result.events.map((e) => e.type))],
      };
    } catch (err) {
      return reply.code(502).send({ error: 'poll-failed', message: err instanceof Error ? err.message : String(err) });
    }
  });
}

function countByType(resources: readonly { resourceType: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of resources) out[r.resourceType] = (out[r.resourceType] ?? 0) + 1;
  return out;
}
