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
 * Except as expressly permitted by a written license agreement,
 * no person or organization may copy, modify, distribute, or use this file.
 *
 ******************************************************************************/

// FHIR Bundle ingestion orchestrator (Phase A + B).
//
// Turns a FHIR Bundle POST into real realm mutations with proper semantics:
//   • Phase A — reference resolution + structural-first ordering:
//       - builds a bundle reference index (fullUrl / urn:uuid / Type/id / #contained)
//       - rewrites references to `Type/id` so effect-able resources never create
//         phantom entities
//       - applies structural resources before effect-able ones (order-independent)
//   • Phase B — Bundle.type semantics + per-entry responses:
//       - `transaction` → ATOMIC: snapshot before, roll back the realm (registry
//         swap + restoreSnapshot) on any entry failure, return transaction-response
//       - `batch` → independent entries, per-entry status, batch-response
//       - `collection` → legacy unordered apply (still reference-correct now)
//       - `message` → FHIR message envelope (MessageHeader + payloads), returns
//         a message-response Bundle (Phase C `$process-message`-ish)
//       - honors entry.request.method (POST/PUT/DELETE/GET) + If-None-Exist dedup
//   • Phase C — dry-run previews, entry-count guard, and a bundle.id/content-hash
//     idempotency ledger (reconcile instead of duplicate).

import { createHash } from 'node:crypto';
import type { Realm } from '../realm/realm.js';
import type { EmittedEffect, EntityKind, EntityRecord, RealmMode } from '../realm/types.js';
import type { Bundle, BundleEntry, FhirCtx, FhirResource, OperationOutcome } from './types.js';
import {
  ingestResource, isStructuralKind, linkResolutionFor, planInboundMerge, remoteRefId, resolveInboundPatient,
  type FhirIngestOptions, type IdentitySnapshot,
} from './canonical.js';
import { correctionFrom } from './identity.js';
import { buildBundleRefIndex, resolveBundleReferences } from './fhir-bundle.js';
import { entityKindFromResource, RESOURCE_TO_KIND } from './mapping.js';
import { captureSnapshot, restoreSnapshot, type RealmSnapshotV1 } from '../realm/realm-snapshot.js';
import { RealmRegistry } from '../realm/registry.js';
import { RealmHypergraph } from '../realm/hypergraph-bridge.js';
import { buildHealthcareHypergraphSchema } from '../../packs/healthcare-core/hypergraph.js';

export type BundleIngestMode = 'collection' | 'transaction' | 'batch' | 'message';

/** Max entries accepted in a single bundle (size guard, Phase C). */
export const MAX_BUNDLE_ENTRIES = 500;

export class BundleTooLargeError extends Error {
  constructor(entries: number) {
    super(`bundle-too-large: ${entries} entries exceeds max ${MAX_BUNDLE_ENTRIES}`);
    this.name = 'BundleTooLargeError';
  }
}

/** SHA-256 of the serialized bundle — used for idempotency/reconcile dedup. */
export function bundleContentHash(bundle: Bundle): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

// ---- In-memory bundle idempotency ledger (keyed by realmId|bundle.id) ----
// Re-sending the same bundle (same id + same content hash) returns the previous
// result without re-applying side effects; same id + different content → conflict.
interface LedgerEntry { hash: string; result: IngestBundleResult; at: string }
const bundleLedger = new Map<string, LedgerEntry>();

export function lookupBundleIngest(realmId: string, bundle: Bundle): { duplicate: boolean; conflict?: boolean; result?: IngestBundleResult } {
  if (!bundle.id) return { duplicate: false };
  const existing = bundleLedger.get(`${realmId}|${bundle.id}`);
  if (!existing) return { duplicate: false };
  const hash = bundleContentHash(bundle);
  if (existing.hash !== hash) return { duplicate: true, conflict: true };
  return { duplicate: true, result: existing.result };
}

export function recordBundleIngest(realmId: string, bundle: Bundle, result: IngestBundleResult): void {
  if (!bundle.id) return;
  bundleLedger.set(`${realmId}|${bundle.id}`, { hash: bundleContentHash(bundle), result, at: new Date().toISOString() });
}

/** Test hook. */
export function clearBundleIngestLedger(): void { bundleLedger.clear(); }

export interface BundleEntryOutcome {
  index: number;
  requestMethod?: string;
  requestUrl?: string;
  status: number;
  location?: string;
  resourceType?: string;
  id?: string;
  issue?: { severity: 'error' | 'warning' | 'information'; code: string; diagnostics?: string };
}

export interface IngestBundleResult {
  bundleType: Bundle['type'];
  mode: BundleIngestMode;
  applied: number;
  skipped: number;
  rolledBack: boolean;
  /** True when this run was a dry-run preview (applied to a snapshot, then rolled back). */
  dryRun: boolean;
  entries: BundleEntryOutcome[];
  /** transaction/batch/message-response Bundle (null for plain collection). */
  response: Bundle | null;
  summary: {
    hydrated: number;
    persisted: number;
    effectsApplied: number;
    effectsRejected: number;
    structuralUpserts: number;
    skipped: string[];
  };
  /**
   * Corrections ACKNOWLEDGED but deliberately not applied as clinical facts
   * (`entered-in-error` retractions and `Patient.link` merges). Recorded rather
   * than dropped: a retraction that leaves no trace is indistinguishable from
   * one that never arrived.
   */
  corrections: string[];
}

export interface IngestBundleOptions {
  /** Durable fhir_resources mirror. */
  store?: { saveFhirResource?(row: Record<string, unknown>): Promise<unknown> };
  presenceInit?: { agentSpecId?: string; role?: string; clearance?: string; facilityId?: string; unitId?: string; purposeOfUse?: string[] };
  defaultUnitId?: string;
  /** Preview mode — apply against a snapshot, then roll back and report what WOULD happen. */
  dryRun?: boolean;
  /**
   * F3 — resolve inbound patients against the local population.
   *
   * Omit it and an inbound `Patient` is adopted by its remote id, which is only
   * safe for a same-system replay. An EMR feed MUST supply this, or a patient
   * whose MRN the harness has not seen before silently becomes a second chart.
   */
  identity?: IdentitySnapshot;
}

function reasonPhrase(status: number): string {
  switch (status) {
    case 200: return 'OK';
    case 201: return 'Created';
    case 204: return 'No Content';
    case 400: return 'Bad Request';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 422: return 'Unprocessable Entity';
    default: return '';
  }
}

function kindOf(resource: FhirResource): EntityKind | undefined {
  return RESOURCE_TO_KIND[resource.resourceType] ?? entityKindFromResource(resource.resourceType);
}

function errorOutcome(index: number, entry: BundleEntry | undefined, code: string, diagnostics?: string): BundleEntryOutcome {
  return {
    index,
    ...(entry?.request?.method ? { requestMethod: entry.request.method } : {}),
    ...(entry?.request?.url ? { requestUrl: entry.request.url } : {}),
    status: 422,
    ...(entry?.resource?.resourceType ? { resourceType: entry.resource.resourceType } : {}),
    ...(entry?.resource?.id ? { id: entry.resource.id } : {}),
    issue: { severity: 'error', code, ...(diagnostics ? { diagnostics } : {}) },
  };
}

function successOutcome(index: number, entry: BundleEntry | undefined, status: number, location?: string): BundleEntryOutcome {
  return {
    index,
    ...(entry?.request?.method ? { requestMethod: entry.request.method } : {}),
    ...(entry?.request?.url ? { requestUrl: entry.request.url } : {}),
    status,
    ...(location ? { location } : {}),
    ...(entry?.resource?.resourceType ? { resourceType: entry.resource.resourceType } : {}),
    ...(entry?.resource?.id ? { id: entry.resource.id } : {}),
  };
}

/** Roll a realm back to a snapshot by swapping it in the registry (stop → restore → start). */
function rollbackRealm(snapshot: RealmSnapshotV1, realmId: string): void {
  const old = RealmRegistry.get(realmId);
  if (!old) return;
  const hg = old.hypergraph ? new RealmHypergraph(buildHealthcareHypergraphSchema(), realmId) : undefined;
  RealmRegistry.remove(realmId);
  const restored = restoreSnapshot(snapshot, () => RealmRegistry.create({ id: realmId, mode: snapshot.realm.mode as RealmMode, ...(hg ? { hypergraph: hg } : {}) }));
  restored.start();
}

/** Ingest a FHIR Bundle into a live realm with Phase A + B (+C) semantics. */
export async function ingestFhirBundle(realm: Realm, ctx: FhirCtx, bundle: Bundle, opts: IngestBundleOptions = {}): Promise<IngestBundleResult> {
  const mode: BundleIngestMode = bundle.type === 'transaction' ? 'transaction' : bundle.type === 'batch' ? 'batch' : bundle.type === 'message' ? 'message' : 'collection';

  // Phase C — size guard.
  const entryCount = bundle.entry?.length ?? 0;
  if (entryCount > MAX_BUNDLE_ENTRIES) throw new BundleTooLargeError(entryCount);

  // Phase A — reference index + normalization BEFORE any mutation.
  const refIndex = buildBundleRefIndex(bundle);
  const resources: FhirResource[] = [];
  for (const entry of bundle.entry ?? []) {
    if (entry.resource) resources.push(entry.resource);
  }
  resolveBundleReferences(resources, refIndex);

  // Snapshot for transaction atomicity AND dry-run previews. Captured BEFORE any
  // mutation (incl. the transient ingest presence) so a rollback restores the
  // exact pre-ingest realm.
  const needsSnapshot = mode === 'transaction' || opts.dryRun === true;
  const snapshot = needsSnapshot ? captureSnapshot(realm) : null;

  const presence = realm.spawnPresence({
    agentSpecId: opts.presenceInit?.agentSpecId ?? 'fhir-ingest',
    runId: `fhir-ingest-${Date.now()}`,
    role: (opts.presenceInit?.role ?? 'md') as 'md',
    clearance: (opts.presenceInit?.clearance ?? 'phi') as 'phi',
    purposeOfUse: (opts.presenceInit?.purposeOfUse ?? ['treatment']) as Array<'treatment'>,
    location: { facilityId: ctx.facilityId, unitId: opts.presenceInit?.unitId ?? 'U1' },
  });

  const n = bundle.entry?.length ?? 0;
  const outcomes: Array<BundleEntryOutcome | undefined> = new Array(n);
  const ingestOpts: FhirIngestOptions = {
    realm, ctx, presence, events: [], defaultUnitId: opts.defaultUnitId ?? 'U1',
    ...(opts.identity ? { identity: opts.identity } : {}),
  };
  const summary = { hydrated: resources.length, persisted: 0, effectsApplied: 0, effectsRejected: 0, structuralUpserts: 0, skipped: [] as string[] };
  /**
   * Corrections the sender asked for that were ACKNOWLEDGED and deliberately not
   * applied as facts. An empty list is the normal case; a non-empty one is the
   * only place a retraction or a merge shows up in the result, so it is never
   * inferred from `skipped`.
   */
  const corrections: string[] = [];
  let failed = false;

  const recordFailure = (i: number, entry: BundleEntry | undefined, code: string, diagnostics?: string): void => {
    outcomes[i] = errorOutcome(i, entry, code, diagnostics);
    if (code) summary.skipped.push(code);
    failed = true;
  };

  const isHeader = (r?: unknown): boolean => r !== undefined && typeof r === 'object' && (r as { resourceType?: string }).resourceType === 'MessageHeader';

  // Pass 0 — corrections, BEFORE anything is written.
  //
  // Two things an EMR says that must change what we do with the bundle rather
  // than be applied as if they were facts:
  //
  //   * `Patient.link: replaced-by` — two of its records are one person. Until
  //     this is applied, the merged-away remote id still resolves to the chart
  //     the EMR just retired, so every clinical fact about that patient in this
  //     very bundle lands on the dead chart.
  //   * `status: entered-in-error` — the sender is RETRACTING a value. Writing it
  //     as a fresh clinical fact is how a retracted result becomes a live one;
  //     the retraction is acknowledged and deliberately not applied.
  //
  // Superseding is not deleting: the notice is recorded either way, because
  // erasing the fact that a wrong value was once sent is exactly what an audit
  // needs to keep.
  if (opts.identity) {
    const survivorRemoteId = (resource: FhirResource): string | undefined => {
      const links = (resource as { link?: Array<{ type?: string; other?: { reference?: string; id?: string } }> }).link ?? [];
      const replaced = links.find((l) => l.type === 'replaced-by');
      return replaced ? remoteRefId(replaced.other) : undefined;
    };
    // The survivor may be in this same bundle, which is how a vendor usually
    // sends a merge: the retired record plus the record that absorbed it.
    const patientsById = new Map<string, FhirResource>();
    for (const entry of bundle.entry ?? []) {
      const r = entry.resource;
      if (r?.resourceType === 'Patient' && r.id) patientsById.set(r.id, r);
    }

    for (let i = 0; i < n; i++) {
      const entry = bundle.entry![i]!;
      const resource = entry.resource;
      if (!resource) continue;
      const notice = correctionFrom(resource);
      if (!notice) continue;

      if (notice.action === 'merge') {
        const survivorId = survivorRemoteId(resource);
        // Resolve the survivor: prefer the resource itself when the vendor sent
        // it, and fall back to a link we already hold for that remote id.
        const survivorResource = survivorId ? patientsById.get(survivorId) : undefined;
        const to = survivorResource
          ? resolveInboundPatient(survivorResource, opts.identity)
          : linkResolutionFor(opts.identity, resource, survivorId);
        const plan = planInboundMerge({
          from: resolveInboundPatient(resource, opts.identity),
          to,
        });

        if (plan.action === 'refused') {
          recordFailure(i, entry, 'patient-merge-unresolved', plan.why);
          continue;
        }
        if (plan.action === 'merged' && plan.fromLocalId && plan.toLocalId && opts.identity.applyMerge) {
          await opts.identity.applyMerge({
            fromLocalId: plan.fromLocalId,
            toLocalId: plan.toLocalId,
            mergedBy: opts.identity.mergedBy ?? 'fhir-ingest',
          });
        }
        // Either way this entry is NOT a patient to create: the EMR has said the
        // record is no longer a live chart, and creating it is the duplicate.
        corrections.push(`${resource.resourceType}/${resource.id ?? ''} · merge · ${plan.why}`);
        summary.skipped.push(`correction-merge:${plan.action}`);
        outcomes[i] = {
          ...successOutcome(i, entry, 200, `${resource.resourceType}/${resource.id ?? ''}`),
          resourceType: resource.resourceType,
          ...(resource.id ? { id: resource.id } : {}),
          issue: { severity: 'information', code: `correction-merge-${plan.action}`, diagnostics: plan.why },
        };
        continue;
      }

      corrections.push(`${resource.resourceType}/${resource.id ?? ''} · ${notice.action}`);
      summary.skipped.push(`correction-${notice.action}`);
      outcomes[i] = {
        ...successOutcome(i, entry, 200, `${resource.resourceType}/${resource.id ?? ''}`),
        resourceType: resource.resourceType,
        ...(resource.id ? { id: resource.id } : {}),
        issue: { severity: 'information', code: `correction-${notice.action}`, diagnostics: notice.reason },
      };
    }
  }

  // Pass 1 — structural resources first (so effects always reference live entities).
  for (let i = 0; i < n; i++) {
    if (outcomes[i]) continue;
    const entry = bundle.entry![i]!;
    const resource = entry.resource;
    if (!resource) { outcomes[i] = errorOutcome(i, entry, 'missing-resource', 'entry has no resource'); failed = true; continue; }
    // A message envelope's MessageHeader is not a realm entity — report it, don't fail.
    if (mode === 'message' && isHeader(resource)) { outcomes[i] = successOutcome(i, entry, 200, `MessageHeader/${resource.id ?? ''}`); continue; }
    const kind = kindOf(resource);
    if (!kind || !isStructuralKind(kind) || !resource.id) continue;
    const method = entry.request?.method ?? 'POST';
    if (method === 'GET') { outcomes[i] = successOutcome(i, entry, 200); continue; }
    if (method === 'DELETE') continue; // deferred to pass 2 (needs graph.remove)
    // If-None-Exist dedup for create: already-present → 200 (no change).
    if (method === 'POST' && entry.request?.ifNoneExist && realm.graph.get(realm.graph.urnFor(kind, resource.id))) {
      outcomes[i] = successOutcome(i, entry, 200, `${resource.resourceType}/${resource.id}`);
      continue;
    }
    if (method === 'PUT') {
      if (!realm.graph.get(realm.graph.urnFor(kind, resource.id))) {
        outcomes[i] = { ...errorOutcome(i, entry, 'entity-not-found', `PUT target ${resource.resourceType}/${resource.id} does not exist`), status: 404 };
        failed = true;
        continue;
      }
    }
    const out = ingestResource(ingestOpts, resource);
    if (out.structural) {
      summary.structuralUpserts++;
      await persistMirror(opts, ctx.realmId, resource);
      summary.persisted++;
      outcomes[i] = successOutcome(i, entry, method === 'PUT' ? 200 : 201, `${resource.resourceType}/${resource.id}`);
    } else {
      recordFailure(i, entry, out.skipped ?? 'not-applied', `structural ${resource.resourceType}/${resource.id} not applied`);
    }
  }

  // Pass 2 — effect-able resources + structural DELETE.
  for (let i = 0; i < n; i++) {
    if (outcomes[i]) continue;
    const entry = bundle.entry![i]!;
    const resource = entry.resource;
    if (!resource) continue;
    if (mode === 'message' && isHeader(resource)) { outcomes[i] = successOutcome(i, entry, 200, `MessageHeader/${resource.id ?? ''}`); continue; }
    const kind = kindOf(resource);
    const method = entry.request?.method ?? 'POST';

    if (kind && isStructuralKind(kind) && resource.id) {
      if (method === 'DELETE') {
        const removed = realm.graph.remove(realm.graph.urnFor(kind, resource.id));
        if (removed) outcomes[i] = { ...successOutcome(i, entry, 204), resourceType: resource.resourceType, id: resource.id };
        else { outcomes[i] = { ...errorOutcome(i, entry, 'entity-not-found', `DELETE target ${resource.resourceType}/${resource.id} does not exist`), status: 404 }; failed = true; }
        continue;
      }
      continue; // structural POST/PUT/GET already resolved in pass 1
    }

    if (method === 'GET') { outcomes[i] = successOutcome(i, entry, 200); continue; }
    if (method === 'DELETE') { recordFailure(i, entry, 'delete-not-supported-for-effects', `${resource.resourceType} is not a structural kind — DELETE unsupported`); continue; }

    const out = ingestResource(ingestOpts, resource);
    if (out.effects && out.effects.length > 0) {
      const rejected = out.effects.filter((e: EmittedEffect) => e.status === 'rejected');
      summary.effectsApplied += out.effects.length - rejected.length;
      summary.effectsRejected += rejected.length;
      if (rejected.length > 0) {
        recordFailure(i, entry, 'effect-rejected', `${resource.resourceType}/${resource.id ?? ''} effect rejected by governance`);
        continue;
      }
      await persistMirror(opts, ctx.realmId, resource);
      summary.persisted++;
      outcomes[i] = successOutcome(i, entry, 201, resource.id ? `${resource.resourceType}/${resource.id}` : undefined);
    } else {
      recordFailure(i, entry, out.skipped ?? 'not-applied', `${resource.resourceType} could not be mapped to an effect`);
    }
  }

  // Rollback — a failed `transaction` is atomic, and a `dryRun` preview is ALWAYS
  // rolled back so nothing is persisted.
  let rolledBack = false;
  if (opts.dryRun === true) {
    if (snapshot) { rollbackRealm(snapshot, realm.id); rolledBack = true; }
  } else if (mode === 'transaction' && failed && snapshot) {
    rollbackRealm(snapshot, realm.id);
    rolledBack = true;
  }

  const filled = outcomes.filter((o): o is BundleEntryOutcome => Boolean(o));
  const applied = filled.filter((o) => o.status >= 200 && o.status < 300).length;
  const skippedCount = filled.filter((o) => o.status >= 400).length;

  return {
    bundleType: bundle.type,
    mode,
    applied,
    skipped: skippedCount,
    rolledBack,
    dryRun: opts.dryRun === true,
    entries: filled,
    response: mode === 'transaction' || mode === 'batch' || mode === 'message' ? buildResponseBundle(bundle, filled, failed) : null,
    summary,
    corrections,
  };
}

async function persistMirror(opts: IngestBundleOptions, realmId: string, resource: FhirResource): Promise<void> {
  if (!opts.store?.saveFhirResource || !resource.id) return;
  const kind = kindOf(resource) ?? 'unknown';
  const id = `fhir:${resource.resourceType}:${resource.id}`;
  await opts.store.saveFhirResource({
    id,
    realmId,
    resourceType: resource.resourceType,
    kind,
    entityId: resource.id,
    resourceJson: JSON.stringify(resource),
    direction: 'in',
  });
}

/** Build a transaction-response / batch-response / message-response Bundle. */
function buildResponseBundle(request: Bundle, outcomes: BundleEntryOutcome[], failed = false): Bundle {
  // A FHIR message-response carries a single OperationOutcome summarizing processing.
  if (request.type === 'message') {
    const applied = outcomes.filter((o) => o.status >= 200 && o.status < 300).length;
    const skipped = outcomes.filter((o) => o.status >= 400).length;
    return {
      resourceType: 'Bundle',
      type: 'message-response',
      timestamp: new Date().toISOString(),
      entry: [{
        resource: {
          resourceType: 'OperationOutcome',
          issue: [{
            severity: failed ? 'error' : 'information',
            code: failed ? 'processing' : 'informational',
            diagnostics: `Message processed: ${applied} applied, ${skipped} not applied`,
          }],
        } as OperationOutcome,
      }],
    };
  }
  const type: Bundle['type'] = request.type === 'transaction' ? 'transaction-response' : 'batch-response';
  const entry: BundleEntry[] = outcomes.map((o) => ({
    ...(o.location ? { fullUrl: `urn:anant:${o.location}` } : {}),
    response: {
      status: `${o.status} ${reasonPhrase(o.status)}`.trim(),
      ...(o.location ? { location: o.location } : {}),
      ...(o.issue
        ? { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: o.issue.severity, code: o.issue.code, ...(o.issue.diagnostics ? { diagnostics: o.issue.diagnostics } : {}) }] } as OperationOutcome }
        : {}),
    },
  }));
  return {
    resourceType: 'Bundle',
    type,
    timestamp: new Date().toISOString(),
    entry,
  };
}
