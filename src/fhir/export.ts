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

// Realm → FHIR export (Phase 2 produce path). Serializes every realm entity to
// its R4 resource(s) and packages them into a Bundle. Also renders a single
// entity as R4 for the entity route.

import type { Realm } from '../realm/realm.js';
import type { EntityKind, EntityRecord } from '../realm/types.js';
import type { Bundle, FhirCtx, FhirResource } from './types.js';
import { buildBundle } from './fhir-bundle.js';
import { serializeEntity } from './mapping.js';
import { effectToFhirResource } from './effect-map.js';

export interface ExportOptions {
  type?: Bundle['type'];
  source?: string;
  /** Include effect-projected resources (the FHIR write path) in the export. */
  includeEffects?: boolean;
  /** Include empty/derived kinds (agent-run, presence, effect) — default excludes them. */
  includeDerived?: boolean;
}

const DERIVED_KINDS: ReadonlySet<EntityKind> = new Set(['agent-run', 'presence', 'effect', 'intent', 'approval', 'operator-directive']);

/** Serialize every realm entity → FHIR resources (skips derived/empty kinds unless asked). */
export function serializeRealm(realm: Realm, ctx: FhirCtx, opts: ExportOptions = {}): FhirResource[] {
  const resources: FhirResource[] = [];
  for (const rec of realm.graph.snapshot().entities) {
    if (!opts.includeDerived && DERIVED_KINDS.has(rec.kind)) continue;
    resources.push(...serializeEntity(rec, ctx));
  }
  if (opts.includeEffects) {
    for (const emitted of realm.ledger.listAll()) {
      resources.push(...effectToFhirResource(emitted.effect, { ctx }));
    }
  }
  return resources;
}

/** Serialize a single entity to FHIR (empty for kinds with no wire equivalent). */
export function serializeRealmEntity(realm: Realm, kind: EntityKind, id: string, ctx: FhirCtx): FhirResource[] {
  const rec = realm.graph.get(realm.graph.urnFor(kind, id));
  if (!rec) return [];
  return serializeEntity(rec as EntityRecord, ctx);
}

/** Export a whole realm as a FHIR Bundle. */
export function exportRealmBundle(realm: Realm, ctx: FhirCtx, opts: ExportOptions = {}): Bundle {
  return buildBundle(serializeRealm(realm, ctx, opts), {
    type: opts.type ?? 'collection',
    id: `bundle-${ctx.realmId.replace(/[^A-Za-z0-9-]/g, '-')}`,
    source: opts.source ?? ctx.sourceId,
    lastUpdated: new Date().toISOString(),
  });
}
