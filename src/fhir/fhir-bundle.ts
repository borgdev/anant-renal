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

// FHIR Bundle helpers — build/serialize Bundles, resolve References to entity
// urns, and index resources by (resourceType, id) (Phase 2).

import type { Bundle, BundleEntry, FhirCtx, FhirResource } from './types.js';

export interface BuildBundleOptions {
  type?: Bundle['type'];
  id?: string;
  source?: string;
  lastUpdated?: string;
  total?: number;
  fullUrlBase?: string;
}

/** Build an R4 Bundle from resources (deterministic ordering by type + id). */
export function buildBundle(resources: readonly FhirResource[], opts: BuildBundleOptions = {}): Bundle {
  const sorted = [...resources].sort((a, b) => `${a.resourceType}:${a.id ?? ''}`.localeCompare(`${b.resourceType}:${b.id ?? ''}`));
  const now = new Date().toISOString();
  const fullUrlBase = opts.fullUrlBase ?? 'urn:anant:';
  const entry: BundleEntry[] = sorted.map((r) => ({
    fullUrl: `${fullUrlBase}${r.resourceType}/${r.id ?? ''}`,
    resource: r,
  }));
  return {
    resourceType: 'Bundle',
    id: opts.id ?? `bundle-${now.replace(/[^0-9]/g, '').slice(0, 14)}`,
    type: opts.type ?? 'collection',
    timestamp: opts.lastUpdated ?? now,
    meta: {
      source: opts.source ?? 'anant-health',
      lastUpdated: opts.lastUpdated ?? now,
    },
    total: opts.total ?? entry.length,
    entry,
  };
}

/** Parse a JSON FHIR bundle into a typed Bundle, validating the resourceType. */
export function parseBundle(json: unknown): Bundle {
  const b = json as Partial<Bundle>;
  if (!b || b.resourceType !== 'Bundle' || !Array.isArray(b.entry)) {
    throw new Error(`invalid-fhir-bundle: expected resourceType 'Bundle' with an entry array`);
  }
  return b as Bundle;
}

/** Index every resource in a bundle by `${resourceType}/${id}` (and bare id). */
export function indexBundle(bundle: Bundle): Map<string, FhirResource> {
  const index = new Map<string, FhirResource>();
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource;
    if (!r || typeof r.resourceType !== 'string') continue;
    const id = r.id;
    if (id) {
      index.set(`${r.resourceType}/${id}`, r);
      index.set(`#${id}`, r);
      index.set(id, r);
    }
  }
  return index;
}

/** Resolve a FHIR Reference to an entity id via the bundle index (by default). */
export function resolveReference(
  ref: { reference?: string; identifier?: { system?: string; value?: string } } | undefined,
  ctx: FhirCtx,
  bundleIndex?: ReadonlyMap<string, FhirResource>,
): string | undefined {
  if (!ref) return undefined;
  if (ref.reference) {
    // contained ref
    if (ref.reference.startsWith('#')) return ref.reference.slice(1);
    // urn:uuid / urn:anant
    if (ref.reference.startsWith('urn:')) return ref.reference;
    // Patient/123 — drop the type prefix; prefer resolving via bundle id.
    const slash = ref.reference.indexOf('/');
    const id = slash >= 0 ? ref.reference.slice(slash + 1) : ref.reference;
    return id;
  }
  if (ref.identifier?.system && ref.identifier.value) {
    const mrnSystem = ctx.identifierSystems?.['mrnSystem'] ?? 'urn:mrn';
    if (ref.identifier.system === mrnSystem || ref.identifier.system === 'http://hl7.org/fhir/sid/us-mrn') {
      return ref.identifier.value;
    }
    if (bundleIndex) {
      for (const [key, r] of bundleIndex) {
        if (key.startsWith('urn:') || key.startsWith('#')) continue;
        const identifiers = (r as { identifier?: Array<{ system?: string; value?: string }> }).identifier ?? [];
        if (identifiers.some((i) => i.system === ref.identifier?.system && i.value === ref.identifier?.value)) return r.id;
      }
    }
  }
  return undefined;
}

/** Extract a human-readable display from a Reference. */
export function referenceDisplay(ref: { display?: string; reference?: string } | undefined): string | undefined {
  return ref?.display ?? ref?.reference;
}

// ------------------------------------------------------- Phase A bundle index
// Real integrations send cross-entry references as `urn:uuid:…` / fullUrl, and
// entries may reference entities defined later in the array. Build a map from
// every reference key (fullUrl, `Type/id`, bare id, `#contained`) to the
// concrete entity, then rewrite References to `Type/id` so the realm ingest
// resolves them (no phantom entities, order-independent).

export interface BundleRefIndexEntry {
  resourceType: string;
  id: string;
}

/** Index a bundle's entries by every reference form. */
export function buildBundleRefIndex(bundle: { entry?: ReadonlyArray<{ fullUrl?: string; resource?: FhirResource }> }): Map<string, BundleRefIndexEntry> {
  const index = new Map<string, BundleRefIndexEntry>();
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource;
    if (!r || !r.id || typeof r.resourceType !== 'string') continue;
    const rec: BundleRefIndexEntry = { resourceType: r.resourceType, id: r.id };
    if (entry.fullUrl) index.set(entry.fullUrl, rec);
    index.set(`${r.resourceType}/${r.id}`, rec);
    index.set(r.id, rec);
  }
  return index;
}

/**
 * Rewrite every Reference in the given resources so `urn:…` / fullUrl /
 * `#contained` forms become `Type/id` (resolved via the bundle index).
 * Mutates resources in place; unresolvable references are left untouched.
 */
export function resolveBundleReferences(resources: readonly FhirResource[], index: ReadonlyMap<string, BundleRefIndexEntry>): void {
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj['reference'] === 'string') {
      const ref = obj['reference'] as string;
      if (ref.startsWith('urn:') || ref.startsWith('#')) {
        const entry = ref.startsWith('urn:') ? index.get(ref) : (index.get(ref) ?? index.get(ref.slice(1)));
        if (entry) obj['reference'] = `${entry.resourceType}/${entry.id}`;
      }
    }
    for (const v of Object.values(obj)) walk(v);
  };
  for (const r of resources) walk(r);
}
