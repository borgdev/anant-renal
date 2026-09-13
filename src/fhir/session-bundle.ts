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

/**
 * F8 — putting a whole dialysis session on the wire.
 *
 * A 4-hour session at 5-minute cadence is ~48 telemetry points; at 20-second
 * cadence it is ~720. Each point can fan out to several Observations, so a
 * session can be thousands of resources. Emitting them one request at a time is
 * both slow and, worse, **non-atomic**: a failure halfway leaves an EMR holding
 * half a session.
 *
 * So a session is emitted as a `transaction` Bundle — FHIR's atomic unit, which
 * applies completely or not at all. When a session exceeds `batchSize` it is
 * split into several transaction Bundles, and that split is stated out loud via
 * {@link bundleAtomicityNote} rather than being silently assumed atomic: three
 * transactions are three chances to half-apply.
 *
 * Every resource here carries a DERIVED id, so entries use `PUT` rather than
 * `POST` — replaying the same session overwrites rather than duplicates.
 */
import type { Bundle, BundleEntry, FhirResource } from './types.js';

/**
 * Resources per transaction Bundle once a session is too big for one request.
 *
 * Sized from MEASURED payloads, not guessed. A canonical 4-hour session at
 * 5-minute cadence measures 436 resources / 376 KiB; the worst case the cap
 * allows, 4 hours at 20-second cadence, measures 6,484 resources / ~5.6 MiB.
 * 1000 keeps the canonical session in ONE atomic transaction while forcing the
 * extreme one to split into 7 — the honest outcome, because a single 5.6 MiB
 * request will be rejected by most servers.
 */
export const TELEMETRY_BATCH_SIZE = 1000;

export interface SessionBundleOptions {
  /** Deterministic bundle id; batches append `-2`, `-3`, … */
  bundleId: string;
  timestamp?: string;
  /** Override {@link TELEMETRY_BATCH_SIZE}. */
  batchSize?: number;
}

/** `Observation/abc` when the resource has an id, else just its type. */
export function targetUrl(resource: FhirResource): string {
  const id = resource.id;
  return id ? `${resource.resourceType}/${id}` : resource.resourceType;
}

/** One `transaction` Bundle: FHIR's atomic apply-or-roll-back unit. */
export function sessionTransactionBundle(
  resources: FhirResource[],
  opts: SessionBundleOptions,
): Bundle {
  const entry: BundleEntry[] = resources.map((resource) => {
    const url = targetUrl(resource);
    return {
      fullUrl: `urn:uuid:${url.replace('/', '-')}`,
      resource,
      request: { method: 'PUT', url },
    };
  });
  return {
    resourceType: 'Bundle',
    id: opts.bundleId,
    type: 'transaction',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    total: entry.length,
    entry,
  };
}

/**
 * A session as one or more transaction Bundles.
 *
 * Returns exactly one bundle when the session fits — the common case, and the
 * only case that is atomic for the whole session.
 */
export function batchSessionBundle(
  resources: FhirResource[],
  opts: SessionBundleOptions,
): Bundle[] {
  const size = Math.max(1, Math.floor(opts.batchSize ?? TELEMETRY_BATCH_SIZE));
  if (resources.length <= size) return [sessionTransactionBundle(resources, opts)];
  const batches: Bundle[] = [];
  for (let i = 0; i < resources.length; i += size) {
    batches.push(
      sessionTransactionBundle(resources.slice(i, i + size), {
        ...opts,
        bundleId: `${opts.bundleId}-${batches.length + 1}`,
      }),
    );
  }
  return batches;
}

/** UTF-8 byte size of a bundle as it would hit the wire. */
export function payloadBytes(bundle: Bundle): number {
  return new TextEncoder().encode(JSON.stringify(bundle)).length;
}

/**
 * Total payload across the batches, plus whether the session is still atomic.
 * Callers should surface `atomic: false` — it means a partial failure is
 * possible and the session may need reconciliation.
 */
export function bundleStats(bundles: Bundle[]): {
  count: number;
  resources: number;
  bytes: number;
  atomic: boolean;
} {
  return {
    count: bundles.length,
    resources: bundles.reduce((n, b) => n + (b.entry?.length ?? 0), 0),
    bytes: bundles.reduce((n, b) => n + payloadBytes(b), 0),
    atomic: bundles.length === 1,
  };
}

/** Human-readable atomicity statement, so a split is never implicit. */
export function bundleAtomicityNote(bundles: Bundle[]): string {
  const stats = bundleStats(bundles);
  return stats.atomic
    ? `1 atomic transaction (${stats.resources} resources, ${stats.bytes} bytes)`
    : `${stats.count} transactions, ${stats.resources} resources, ${stats.bytes} bytes — ` +
        'atomicity is PER BATCH, not per session';
}
