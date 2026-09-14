/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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
import { TYPED_FHIR_RESOURCES, type FhirCtx, type FhirResource } from './types.js';
import { terminologyReport, validateCodings } from './code-registry.js';
import {
  PROPOSAL_EXPIRY_MINUTES,
  ProposalPublisher,
  proposalStats,
  type ProposalLifecycle,
  type ProposalTransport,
} from './proposal.js';
import {
  resolveProposalTransport,
  writePolicyFor,
  type TransportResolution,
} from '../server/proposal-transport.js';
import { ProposalSweeper } from '../server/proposal-sweeper.js';
import type { SecretsProvider } from '../control-plane/secrets.js';
import {
  IdentifierSystemRegistry,
  PatientIdentityService,
  demographicsFromPatient,
  type IdentifierKind,
  type IdentifiedEntity,
  type IdentifierSystem,
  type IdentityMethod,
  type LocalPatientDemographics,
  type PatientCrossReference,
} from './identity.js';
import type { IdentitySnapshot } from './canonical.js';
import { getSwarmWorkspace } from '../server/swarm-routes.js';

/** F4 — the code-fidelity half of the coverage report (see /fhir/terminology/report). */
function codeFidelityReport(): Record<string, unknown> {
  const report = terminologyReport();
  return {
    total: report.total,
    verified: report.verified,
    local: report.local,
    byDomain: report.byDomain,
    needsSignOff: report.needsSignOff,
    note:
      'Every code the write path emits resolves through the terminology registry. `local` entries are ' +
      'declared in our own code systems because no authoritative concept was verified — they need ' +
      'terminology sign-off before a production integration.',
  };
}

// Process-wide in-process FHIR emulator (EHR-bridge test double). Seeded via
// POST /admin/fhir/emulator/seed; the subscription poll points its FhirClient
// at the /fhir-mock/:resourceType search endpoint for a real live pull.
const fhirEmulator = new FhirEmulator();

// F9.3 — the expiry sweeper. Configured when the FHIR surface registers (it needs
// the workspace), but STARTED by the entry point: a route module must not decide
// whether a background timer runs.
let proposalSweeper: ProposalSweeper | null = null;

export interface RegisterFhirRoutesOptions {
  /** Optional store override (defaults to the process-wide SqlStore). */
  store?: Awaited<ReturnType<typeof getSqlStore>>;
  /** Resolves `binding:NAME` credential refs for outbound publishes (F9). */
  secrets?: SecretsProvider;
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
      // F4 — code fidelity. Every code the write path emits resolves through the
      // terminology registry; what is still `local` needs terminology sign-off
      // before a production integration.
      codeFidelity: codeFidelityReport(),
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

  /* ------------------------------------------------ F3 identity resolution */

  /**
   * Resolve an inbound Patient against a realm's population WITHOUT writing
   * anything. This is the endpoint a registration console calls to show the
   * human an ambiguous outcome and let them decide.
   */
  app.post<{ Body: { realmId: string; patient: unknown; minConfidence?: number; allowDemographics?: boolean } }>(
    '/admin/fhir/identity/resolve',
    async (req, reply) => {
      const { realmId, patient } = req.body ?? {};
      const realm = RealmRegistry.get(realmId);
      if (!realm) return reply.code(404).send({ error: 'realm-not-found' });
      if (!patient) return reply.code(400).send({ error: 'patient-required' });
      const ws = getSwarmWorkspace();
      if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });

      // Resolve THROUGH the service, not the bare function: the service is what
      // folds our own cross-references into the population. Calling the pure
      // matcher directly silently drops the `cross-reference` rung, so a patient
      // we had already linked would read as unknown.
      const snapshot = await identitySnapshotFor(realmId);
      const service = new PatientIdentityService(snapshot.registry, ws.identityLinkStore());
      const resolution = await service.resolve(demographicsFromPatient(patient), snapshot.population, {
        realmId,
        ...(typeof req.body.minConfidence === 'number' ? { minConfidence: req.body.minConfidence } : {}),
        ...(typeof req.body.allowDemographics === 'boolean' ? { allowDemographics: req.body.allowDemographics } : {}),
      });

      // (F3) An ambiguous answer is not merely a refusal — it is WORK. Refusing
      // the write is the safe half; without this the same encounter is refused
      // forever and no human is ever told which patient it might be. Recorded
      // idempotently per (realm, remote system, remote patient id), so re-running
      // the same feed is ONE queue entry rather than one per run.
      //
      // Only `ambiguous` files a task. `unresolved` is not a decision anyone can
      // make — it needs data (an identifier, a demographic) that nobody in the
      // chart can supply — so it stays a refusal with its reason attached.
      if (resolution.status === 'ambiguous') {
        const demographics = demographicsFromPatient(patient);
        await ws.recordIdentityAmbiguity({
          realmId,
          remoteSystem: remoteSystemOf(demographics),
          remotePatientId: remotePatientIdOf(demographics, patient),
          incoming: demographics,
          candidates: resolution.candidates.map((c) => ({
            localPatientId: c.localPatientId, confidence: c.confidence, method: c.method, reasons: c.reasons,
          })),
          reasons: resolution.reasons,
        });
      }

      return {
        ...resolution,
        // Stated plainly so a caller cannot mistake 'resolved' for 'safe to write
        // blind': an ambiguous or unresolved answer means NO write.
        writesBlocked: resolution.blocksWrite,
      };
    },
  );

  /** Cross-references for a realm — the evidence behind every resolved patient. */
  app.get<{ Params: { realmId: string } }>('/admin/fhir/identity/links/:realmId', async (req, reply) => {
    const ws = getSwarmWorkspace();
    if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
    const links = await ws.listCrossReferences(req.params.realmId);
    return {
      realmId: req.params.realmId,
      count: links.length,
      unverified: links.filter((l) => !l.verified && !l.supersededBy).length,
      links,
    };
  });

  /**
   * Record a link, verify an inferred one, or merge a duplicate.
   *
   * A human-created link is `verified: true` by construction — that is the whole
   * point of the manual path.
   */
  app.post<{ Body: {
    realmId?: string; localPatientId?: string; remoteSystem?: string; remotePatientId?: string;
    confidence?: number; method?: string; verified?: boolean; actor?: string;
    merge?: { fromLocalPatientId: string; toLocalPatientId: string };
  } }>('/admin/fhir/identity/link', async (req, reply) => {
    const body = req.body ?? {};
    const actor = body.actor ?? 'operator';
    const ws = getSwarmWorkspace();
    if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
    const service = new PatientIdentityService(new IdentifierSystemRegistry(await identifierSystemsWithDurable(ws)), ws.identityLinkStore());

    if (body.merge) {
      const moved = await service.mergeInto(body.merge.fromLocalPatientId, body.merge.toLocalPatientId, actor);
      return { ok: true, merged: moved.length, links: moved };
    }
    if (!body.localPatientId || !body.remoteSystem || !body.remotePatientId) {
      return reply.code(400).send({ error: 'localPatientId-remoteSystem-remotePatientId-required' });
    }
    const link = await linkIdentity({
      ws,
      localPatientId: body.localPatientId,
      remoteSystem: body.remoteSystem,
      remotePatientId: body.remotePatientId,
      actor,
      ...(body.realmId ? { realmId: body.realmId } : {}),
      ...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
      ...(body.method ? { method: body.method as IdentityMethod } : {}),
      ...(typeof body.verified === 'boolean' ? { verified: body.verified } : {}),
    });
    return { ok: true, link };
  });

  /** The identifier systems in force — defaults plus this deployment's additions. */
  app.get('/admin/fhir/identity/systems', async (_req, reply) => {
    const ws = getSwarmWorkspace();
    if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
    const durable = await ws.listIdentifierSystems();
    return {
      systems: await identifierSystemsWithDurable(ws),
      durableCount: durable.length,
      note: 'Add a connection-specific system with POST { system, kind, entityKind, authoritative, label } or an assigner OID via { oid }.',
    };
  });

  app.post<{ Body: { system?: string; oid?: string; kind?: string; entityKind?: string; authoritative?: boolean; label?: string } }>(
    '/admin/fhir/identity/systems',
    async (req, reply) => {
      const body = req.body ?? {};
      const ws = getSwarmWorkspace();
      if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
      if (body.oid) {
        const entry = new IdentifierSystemRegistry().registerOid(body.oid, {
          ...(body.entityKind ? { entityKind: body.entityKind as IdentifiedEntity } : {}),
          ...(typeof body.authoritative === 'boolean' ? { authoritative: body.authoritative } : {}),
          ...(body.label ? { label: body.label } : {}),
        });
        await ws.saveIdentifierSystem(entry);
        return { ok: true, system: entry };
      }
      if (!body.system) return reply.code(400).send({ error: 'system-or-oid-required' });
      const entry = {
        system: body.system,
        kind: (body.kind as IdentifierKind | undefined) ?? 'other',
        entityKind: (body.entityKind as IdentifiedEntity | undefined) ?? 'patient',
        authoritative: body.authoritative ?? false,
        label: body.label ?? body.system,
      };
      await ws.saveIdentifierSystem(entry);
      return { ok: true, system: entry };
    },
  );
  /* ------------------------------------------------ F9 proposals (D1) */

  // F9.3 — build the expiry sweeper. Its transport is resolved PER SWEEP, so a
  // connection configured (or corrected) after boot is honoured without a restart,
  // and an unconfigured one fails closed instead of falling back to the emulator.
  configureProposalSweeper({
    resolveTransport: async () => {
      const ws = getSwarmWorkspace();
      if (!ws) return { kind: 'none', reason: 'the workspace is not available' };
      const connection = await ws.getFhirIntegration();
      return resolveProposalTransport({
        ...(connection ? { connection } : {}),
        emulator: fhirEmulator,
        ...(opts.secrets ? { authCtx: { secrets: opts.secrets } } : {}),
      });
    },
  });

  /**
   * Publish a proposal for an effect.
   *
   * The preflight gates are DERIVED, not taken from the caller: a client that
   * could assert `identityVerified: true` would make the guardrail advisory. The
   * only inputs accepted are the clinical facts (the resource, the effect it came
   * from, the policy) and an explicit approval reference.
   */
  app.post<{ Body: {
    realmId?: string; connectionId?: string; effectId?: string; effectKind?: string; patientId?: string;
    resource?: unknown; policy?: 'shadow' | 'bound' | 'off'; approvedBy?: string;
    vendor?: { supportsWrite?: boolean; supportsProvenance?: boolean; supportsCdsHooks?: boolean };
  } }>('/admin/fhir/proposals', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.realmId || !body.effectId || !body.effectKind || !body.patientId || !body.resource) {
      return reply.code(400).send({ error: 'realmId-effectId-effectKind-patientId-resource-required' });
    }
    const ws = getSwarmWorkspace();
    if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });

    const resource = body.resource as FhirResource;
    // (F3) identity: a VERIFIED cross-reference, derived from the linkage store.
    const links = await ws.listCrossReferences(body.realmId);
    const identityVerified = links.some((l) => l.localPatientId === body.patientId && l.verified && !l.supersededBy);
    // (F4) every coding must be one we own.
    const codings = validateCodings(resource);
    const badCodings = codings.filter((c) => !c.ok);

    // F9.2 — the wire comes from the CONFIGURED connection, not from a hardcoded
    // emulator. Before this the emulator was used unconditionally, so a `bound`
    // proposal never reached the EMR an operator had configured.
    const connection = await ws.getFhirIntegration();
    const resolution = resolveProposalTransport({
      connection,
      emulator: fhirEmulator,
      ...(opts.secrets ? { authCtx: { secrets: opts.secrets } } : {}),
    });

    // A `bound` write with nowhere to go is REFUSED, not quietly downgraded to
    // `shadow`: the operator asked for a write and must not be told they got one.
    const requested = body.policy ?? writePolicyFor(connection, body.effectKind);
    const policy: 'shadow' | 'bound' | 'off' =
      requested === 'bound' && resolution.kind === 'none' ? 'off' : requested;

    const publisher = new ProposalPublisher(
      ws.proposalStore(),
      resolution.kind === 'none'
        ? { send: async () => ({ ok: false as const, error: resolution.reason, retryable: false }) }
        : resolution.transport,
      () => new Date().toISOString(),
    );
    const outcome = await publisher.publish({
      realmId: body.realmId,
      connectionId: body.connectionId ?? connection.id,
      effectId: body.effectId,
      effectKind: body.effectKind,
      patientId: body.patientId,
      resource,
      preflight: {
        identityVerified,
        codesValidated: badCodings.length === 0,
        approvalRecorded: Boolean(body.approvedBy),
      },
      policy,
      vendor: {
        // Asked of the resolved connection rather than assumed: a vendor that
        // cannot take a write must degrade, not silently succeed. `none` is the
        // only resolution with nowhere to write — an emulator-backed connection
        // counts, because pointing the connection at our own double is an
        // explicit instruction to write THERE.
        supportsWrite: body.vendor?.supportsWrite ?? resolution.kind !== 'none',
        supportsProvenance: body.vendor?.supportsProvenance ?? true,
        supportsCdsHooks: body.vendor?.supportsCdsHooks ?? false,
      },
    });
    return {
      ...outcome,
      preflightDetail: {
        identityVerified,
        codesChecked: codings.length,
        invalidCodings: badCodings,
        transport: resolution.kind,
        ...(resolution.kind === 'none'
          ? { transportReason: resolution.reason }
          : { transportLabel: resolution.label, transportBaseUrl: resolution.baseUrl }),
      },
    };
  });

  /** The proposal register, filterable by lifecycle / kind / connection / patient. */
  app.get<{ Querystring: { realmId?: string; lifecycle?: string; effectKind?: string; connectionId?: string; patientId?: string } }>(
    '/admin/fhir/proposals',
    async (req, reply) => {
      const ws = getSwarmWorkspace();
      if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
      const rows = await ws.listProposals({
        ...(req.query.realmId ? { realmId: req.query.realmId } : {}),
        ...(req.query.lifecycle ? { lifecycle: req.query.lifecycle as never } : {}),
        ...(req.query.effectKind ? { effectKind: req.query.effectKind } : {}),
        ...(req.query.connectionId ? { connectionId: req.query.connectionId } : {}),
        ...(req.query.patientId ? { patientId: req.query.patientId } : {}),
      });
      return { count: rows.length, proposals: rows };
    },
  );

  /** Adoption: the never-actioned rate per kind. Reported, never auto-acted on. */
  app.get('/admin/fhir/proposals/stats', async (_req, reply) => {
    const ws = getSwarmWorkspace();
    if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
    const rows = await ws.listProposals({});
    return {
      ...proposalStats(rows),
      expiryWindowsMinutes: PROPOSAL_EXPIRY_MINUTES,
      note:
        'neverActionedRate is denominated on proposals that REACHED a clinician and expired. A refused ' +
        'proposal was never offered; a retracted one was withdrawn by an operator.',
    };
  });

  /** An operator withdraws a proposal. Distinct from expiry, and recorded as such. */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/fhir/proposals/:id/retract',
    async (req, reply) => {
      const reason = req.body?.reason;
      if (!reason) return reply.code(400).send({ error: 'reason-required' });
      const ws = getSwarmWorkspace();
      if (!ws) return reply.code(503).send({ error: 'workspace-unavailable' });
      const updated = await ws.retractProposal(req.params.id, reason, new Date().toISOString());
      if (!updated) return reply.code(404).send({ error: 'proposal-not-found' });
      return { ok: true, proposal: updated };
    },
  );

  /** Run the expiry sweeper now. THE TIMER CALLS THE SAME CODE (F9.3). */
  app.post('/admin/fhir/proposals/sweep', async (_req, reply) => {
    const sweeper = getProposalSweeper();
    if (!sweeper) return reply.code(503).send({ error: 'sweeper-unavailable' });
    return sweeper.sweepNow();
  });

  /**
   * Is anything actually retiring stale proposals?
   *
   * An unscheduled sweeper is indistinguishable from a working one until an
   * operator looks, so this reports the timer, the last sweep, and the wire the
   * retractions would travel down.
   */
  app.get('/admin/fhir/proposals/sweeper', async (_req, reply) => {
    const sweeper = getProposalSweeper();
    if (!sweeper) return reply.code(503).send({ error: 'sweeper-unavailable' });
    const ws = getSwarmWorkspace();
    const connection = ws ? await ws.getFhirIntegration() : undefined;
    const resolution = resolveProposalTransport({
      ...(connection ? { connection } : {}),
      emulator: fhirEmulator,
      ...(opts.secrets ? { authCtx: { secrets: opts.secrets } } : {}),
    });
    return {
      ...sweeper.status(),
      resolvedTransport: resolution.kind,
      ...(resolution.kind === 'none'
        ? { transportReason: resolution.reason }
        : { transportLabel: resolution.label, transportBaseUrl: resolution.baseUrl }),
    };
  });
}

/**
 * The transport a proposal is retracted through, when no connection is set up.
 *
 * Retained for tests and for a demo against the in-process emulator; the ROUTE
 * resolves its transport from the configured connection instead. The emulator's
 * `add()` upserts on (type, id), which is what the deterministic resource id
 * depends on: a re-publish PUTs rather than duplicating.
 */
/**
 * The process-wide emulator, so the sweeper and `/fhir-mock` share one instance.
 *
 * A second emulator would be a silent data split: a bound proposal would land in
 * a structure the read-back endpoint never serves.
 */
export function getFhirEmulator(): FhirEmulator {
  return fhirEmulator;
}

/**
 * Configure the process-wide expiry sweeper (F9.3). Starting it is the entry
 * point's job, so a background timer is a decision a boot path makes.
 *
 * The workspace is resolved per sweep, not captured: `registerFhirRoutes` runs
 * BEFORE `registerSwarmRoutes`, so at this moment the workspace does not exist
 * yet. Capturing it here would leave the sweeper permanently inert.
 */
export function configureProposalSweeper(deps: {
  resolveTransport: () => Promise<TransportResolution>;
  intervalMs?: number;
}): ProposalSweeper {
  const sweeper = new ProposalSweeper({
    workspace: () => getSwarmWorkspace(),
    resolveTransport: deps.resolveTransport,
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
  });
  proposalSweeper = sweeper;
  return sweeper;
}

/** The configured sweeper, or null when the FHIR surface has not registered. */
export function getProposalSweeper(): ProposalSweeper | null {
  return proposalSweeper;
}

/**
 * Record a human's decision that an inbound identity IS a particular chart
 * patient.
 *
 * ONE path, shared by the identity console and the work queue. Two ways to write
 * a cross-reference would eventually disagree about `verified` — and `verified`
 * is the flag that lets a write through, so a disagreement there is a
 * wrong-patient write.
 */
export async function linkIdentity(input: {
  ws: NonNullable<ReturnType<typeof getSwarmWorkspace>>;
  localPatientId: string;
  remoteSystem: string;
  remotePatientId: string;
  actor: string;
  realmId?: string;
  confidence?: number;
  method?: IdentityMethod;
  verified?: boolean;
}): Promise<PatientCrossReference> {
  const service = new PatientIdentityService(
    new IdentifierSystemRegistry(await identifierSystemsWithDurable(input.ws)),
    input.ws.identityLinkStore(),
  );
  return service.link({
    ...(input.realmId ? { realmId: input.realmId } : {}),
    localPatientId: input.localPatientId,
    remoteSystem: input.remoteSystem,
    remotePatientId: input.remotePatientId,
    confidence: input.confidence ?? 1,
    method: input.method ?? 'cross-reference',
    linkedBy: input.actor,
    verified: input.verified ?? true,
  });
}

/**
 * Which remote SYSTEM an ambiguous inbound patient is keyed under.
 *
 * A patient with no identifier at all is still a question worth recording, so it
 * gets an explicit `unknown` system rather than being dropped — a silent skip is
 * how an ambiguous patient becomes no task at all.
 */
const UNKNOWN_REMOTE_SYSTEM = 'urn:ananthealth:unidentified-remote-system';

function remoteSystemOf(demographics: { identifiers?: Array<{ system: string; value: string }> }): string {
  return demographics.identifiers?.[0]?.system ?? UNKNOWN_REMOTE_SYSTEM;
}

function remotePatientIdOf(
  demographics: { identifiers?: Array<{ system: string; value: string }> },
  patient: unknown,
): string {
  const identifier = demographics.identifiers?.[0]?.value;
  if (identifier) return identifier;
  const id = (patient as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : 'unknown';
}

/** Defaults plus the durable additions, as one registry. */
async function identifierSystemsWithDurable(ws: NonNullable<ReturnType<typeof getSwarmWorkspace>>): Promise<IdentifierSystem[]> {
  const durable = await ws.listIdentifierSystems();
  const registry = new IdentifierSystemRegistry();
  for (const entry of durable) {
    registry.register({
      system: entry.system,
      kind: entry.kind,
      entityKind: entry.entityKind,
      authoritative: entry.authoritative,
      label: entry.label,
    });
  }
  return registry.systems();
}

/**
 * Build the identity snapshot for a realm from ITS OWN patient entities.
 *
 * The population is the realm's live patients, not a separate index: a
 * resolution answer that disagrees with the chart is worse than no answer.
 */
export async function identitySnapshotFor(realmId: string): Promise<IdentitySnapshot> {
  const realm = RealmRegistry.get(realmId);
  const ws = getSwarmWorkspace();
  const durable = ws ? await ws.listIdentifierSystems() : [];
  const registry = new IdentifierSystemRegistry();
  for (const entry of durable) {
    registry.register({
      system: entry.system,
      kind: entry.kind,
      entityKind: entry.entityKind,
      authoritative: entry.authoritative,
      label: entry.label,
    });
  }
  const population: LocalPatientDemographics[] = (realm?.graph.listKind('patient') ?? []).map((rec) => {
    const st = (rec.state ?? {}) as { name?: string; sex?: string; birthDate?: string; age?: number; mrn?: string };
    const parts = (st.name ?? '').split(' ');
    return {
      localPatientId: rec.id,
      ...(st.name ? { family: parts[parts.length - 1] ?? st.name, ...(parts.length > 1 ? { given: parts[0] } : {}) } : {}),
      ...(st.birthDate ? { birthDate: st.birthDate } : {}),
      ...(st.sex ? { sex: st.sex } : {}),
      identifiers: [{ system: 'urn:ananthealth:local-patient-id', value: rec.id }, ...(st.mrn ? [{ system: 'urn:mrn', value: st.mrn }] : [])],
    };
  });
  return { registry, population, links: ws ? await ws.listCrossReferences(realmId) : [] };
}

function countByType(resources: readonly { resourceType: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of resources) out[r.resourceType] = (out[r.resourceType] ?? 0) + 1;
  return out;
}
