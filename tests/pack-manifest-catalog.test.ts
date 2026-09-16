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

/// <reference types="vite/client" />

// The manifest catalog, held to two claims at once.
//
// COVERAGE: every pack directory ships a manifest. Nine of twenty-three did not,
// so they declared no surface at all and the platform could only report
// `manifest.present: false` — a gap that cannot be fixed by reading the plan,
// because the plan counted directories and the runtime counts descriptors.
//
// DRIFT: every manifest agrees with the runtime descriptor. This is the property
// `scripts/generate-pack-manifests.ts` exists to make structural, so this test is
// what stops the two from diverging the moment someone hand-edits one side.
// `manifestDrift` reports rather than fails in production — deliberately, because
// the manifest is not yet authoritative — so a test is the only place the
// invariant can be absolute.

import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackManifests, manifestDrift } from '../src/control-plane/pack-manifest.js';
import type { DomainPack } from '../src/control-plane/pack-registry.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every pack entry point, as lazy loaders.
 *
 * `import.meta.glob` rather than a template-literal `import()`: Vite rewrites
 * dynamic imports at build time and a fully variable specifier cannot be
 * resolved, so `await import(`../packs/${id}/index.js`)` throws
 * "Unknown variable dynamic import" — under vitest, which uses Vite's SSR
 * transform, even though plain `tsx` accepts it. The glob is the supported
 * spelling and has the same effect.
 */
const PACK_ENTRIES = import.meta.glob<Record<string, unknown>>('../packs/*/index.js');

/** Every pack directory, in a stable order. */
function packDirectories(): string[] {
  return readdirSync(join(REPO_ROOT, 'packs'))
    .filter((name) => statSync(join(REPO_ROOT, 'packs', name)).isDirectory())
    .sort();
}

/**
 * The `DomainPack` a directory exports, or undefined when it exports none.
 *
 * Dynamic import rather than the `packs/index.ts` barrel, because the barrel is
 * the INSTALL list and this is the CATALOG: six directories carry a real
 * descriptor and are not installed, and enumerating the barrel is exactly how
 * they kept a missing manifest while the analysis reported nine.
 */
async function descriptorFor(packId: string): Promise<DomainPack | undefined> {
  const load = PACK_ENTRIES[`../packs/${packId}/index.js`];
  if (!load) return undefined;
  const mod = await load();
  for (const value of Object.values(mod)) {
    const candidate = value as Partial<DomainPack> | undefined;
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.id !== 'string' || typeof candidate.version !== 'string') continue;
    if (!Array.isArray(candidate.capabilities)) continue;
    return candidate as DomainPack;
  }
  return undefined;
}

describe('the manifest catalog', () => {
  it('every pack directory ships a manifest', async () => {
    // Reads DIRECTORIES, so a new pack cannot be added without one — the check
    // cannot be satisfied by the installed set happening to be complete.
    const { manifests } = loadPackManifests(REPO_ROOT);
    const withManifest = new Set(manifests.map((m) => m.id));
    const missing: string[] = [];
    for (const id of packDirectories()) {
      if (!withManifest.has(id)) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it('every manifest parses, and none blocks', () => {
    const { manifests, issues } = loadPackManifests(REPO_ROOT);
    expect(issues.filter((i) => i.blocking)).toEqual([]);
    expect(manifests.length).toBe(packDirectories().length);
  });

  it('every manifest agrees with the runtime descriptor it describes', async () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const byId = new Map(manifests.map((m) => [m.id, m]));
    const drifting: string[] = [];
    for (const id of packDirectories()) {
      const descriptor = await descriptorFor(id);
      const manifest = byId.get(id);
      if (!descriptor) continue;
      if (!manifest) { drifting.push(`${id}: no manifest`); continue; }
      const drift = manifestDrift(descriptor, manifest);
      if (drift.length > 0) {
        drifting.push(`${id}: ${drift.map((d) => `${d.field} (manifest "${d.manifest}" vs pack "${d.pack}")`).join('; ')}`);
      }
    }
    // Named, not counted: "3 packs drift" sends a reader to grep, and the field
    // and both values are what they actually need.
    expect(drifting).toEqual([]);
  });

  it('every manifest declares its entry, and the entry is a file that exists', async () => {
    // The property option B rests on. A loader reads this field, so a manifest
    // that omits it or points at nothing turns "a specialty is a folder" into a
    // boot-time module-not-found.
    const { manifests } = loadPackManifests(REPO_ROOT);
    const bad: string[] = [];
    for (const m of manifests) {
      if (!m.entry) { bad.push(`${m.id}: declares no entry`); continue; }
      try {
        statSync(join(REPO_ROOT, 'packs', m.id, m.entry));
      } catch {
        bad.push(`${m.id}: entry "${m.entry}" does not exist`);
      }
    }
    expect(bad).toEqual([]);
  });
});
