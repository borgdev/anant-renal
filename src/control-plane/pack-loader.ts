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

// Option B — a specialty is a FOLDER.
//
// `dev.ts` and `bootstrap.ts` each held a hand-written list of sixteen pack
// imports. That is the last place the platform names a specialty in code, and it
// is the thing Phase 3's exit criterion is about: "a new specialty can be
// introduced through pack registration only". With the list in TypeScript,
// introducing one meant editing the platform's composition root — Phase 5's
// "requires pack package work, not core architecture changes" cannot be asserted
// while that is true.
//
// The manifest supplies the ENTRY (`entry: index.ts`), so the manifest is what
// says where a specialty's code lives. A loader that guessed `index.ts` would
// work for every pack that exists today and fail for the first one arranged
// differently — which is how an assumption like that becomes a boot-time
// `Cannot find module` in a deployment that already agreed to host the pack.
//
// FAILURE ISOLATION is the other half, and it is not defensive padding: a pack is
// third-party-shaped code arriving in our process, and a boot that dies because
// one pack has a syntax error takes the whole platform down for a specialty that
// is not even applied. A pack that cannot be loaded is REPORTED and skipped, and
// `buildApp` still gets a working set. The report is what makes that honest
// rather than silent — a skipped pack that nobody is told about is the "absent
// pack still served" defect from the other direction.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPackManifest } from './pack-manifest.js';
import type { DomainPack } from './pack-registry.js';

export interface PackLoadIssue {
  readonly packId: string;
  readonly code: 'no-manifest' | 'unreadable-manifest' | 'no-entry' | 'import-failed' | 'no-descriptor' | 'id-mismatch';
  readonly detail: string;
  /** True when the platform must not pretend the pack is installed. */
  readonly fatal: boolean;
}

export interface LoadedPacks {
  /** Load in dependency order — `extends` targets before their dependants. */
  readonly packs: readonly DomainPack[];
  /** Every pack that did NOT load, with why. Empty is a real answer. */
  readonly issues: readonly PackLoadIssue[];
}

/** Every pack directory, in a stable order. */
export function packDirectories(repoRoot: string): string[] {
  const packsDir = join(repoRoot, 'packs');
  try {
    return readdirSync(packsDir)
      .filter((name) => statSync(join(packsDir, name)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/** The `DomainPack` a module exports, if it exports one. */
function descriptorIn(mod: Record<string, unknown>): DomainPack | undefined {
  for (const value of Object.values(mod)) {
    const candidate = value as Partial<DomainPack> | undefined;
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.id !== 'string' || typeof candidate.version !== 'string') continue;
    if (!Array.isArray(candidate.capabilities) || !Array.isArray(candidate.requiredControls)) continue;
    return candidate as DomainPack;
  }
  return undefined;
}

/**
 * Order packs so `extends` targets precede their dependants.
 *
 * The hand-written list encoded this implicitly, by putting `healthcare-core`
 * first and everything else after it. An implicit ordering is fine while a human
 * maintains the list and a trap the moment one is generated, so the loader owns
 * it: alphabetical within each dependency level, so the result is deterministic
 * and does not depend on `readdir` order.
 *
 * A dependency on a pack that is not being loaded is not an error here — the
 * DESTINATION list may legitimately be partial (a deployment can install a
 * specialty without its optional companion), and `resolvePacks` already owns
 * that verdict. Inventing a failure here would refuse a set the registry accepts.
 */
export function orderByDependency(packs: readonly DomainPack[]): DomainPack[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const ordered: DomainPack[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const visit = (pack: DomainPack): void => {
    if (placed.has(pack.id) || visiting.has(pack.id)) return;
    visiting.add(pack.id);
    for (const dep of pack.extends) {
      const target = byId.get(dep.id);
      if (target) visit(target);
    }
    visiting.delete(pack.id);
    placed.add(pack.id);
    ordered.push(pack);
  };

  for (const pack of [...packs].sort((a, b) => a.id.localeCompare(b.id))) visit(pack);
  return ordered;
}

/**
 * Load every installed pack from its manifest.
 *
 * `only` restricts the set to the ids given — the hook a deployment that installs
 * a subset needs, and the reason "installed" stays a deployment decision. With no
 * `only`, every directory that ships a manifest is installed, which is what makes
 * adding a specialty a folder rather than a code change.
 */
export async function loadInstalledPacks(
  repoRoot: string,
  opts: { only?: readonly string[] } = {},
): Promise<LoadedPacks> {
  const packs: DomainPack[] = [];
  const issues: PackLoadIssue[] = [];
  const wanted = opts.only ? new Set(opts.only) : undefined;
  // Every requested id that the scan actually reached. Anything requested and not
  // seen names a pack the catalog does not have, which must be LOUD: an operator
  // installs a specialty by adding its id, and a request that silently does
  // nothing is indistinguishable from a specialty that is installed, applied and
  // simply has no surface — the worst of the possible readings.
  const seen = new Set<string>();

  for (const packId of packDirectories(repoRoot)) {
    if (wanted && !wanted.has(packId)) continue;
    seen.add(packId);
    const dir = join(repoRoot, 'packs', packId);

    if (!existsSync(join(dir, 'manifest.yaml'))) {
      // Only worth reporting when it was ASKED FOR. A directory with no manifest
      // in a full scan is not installed by definition, not a failure.
      if (wanted) issues.push({ packId, code: 'no-manifest', detail: `${packId} was requested but ships no manifest.yaml`, fatal: true });
      continue;
    }

    const { manifest, issues: manifestIssues } = loadPackManifest(repoRoot, packId);
    const blocking = manifestIssues.filter((i) => i.blocking);
    if (!manifest || blocking.length > 0) {
      issues.push({
        packId,
        code: 'unreadable-manifest',
        detail: blocking.map((i) => i.detail).join('; ') || 'manifest did not load',
        fatal: true,
      });
      continue;
    }

    const entryPath = join(dir, manifest.entry);
    if (!existsSync(entryPath)) {
      issues.push({ packId, code: 'no-entry', detail: `entry "${manifest.entry}" does not exist in packs/${packId}/`, fatal: true });
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      // `pathToFileURL` rather than a bare path: Node resolves a computed
      // specifier as a package name, so a relative path silently becomes a module
      // lookup. The file URL is unambiguous on every platform.
      mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
    } catch (e) {
      issues.push({ packId, code: 'import-failed', detail: e instanceof Error ? e.message : String(e), fatal: true });
      continue;
    }

    const descriptor = descriptorIn(mod);
    if (!descriptor) {
      issues.push({ packId, code: 'no-descriptor', detail: `${manifest.entry} exports no DomainPack descriptor`, fatal: true });
      continue;
    }
    if (descriptor.id !== packId) {
      // The directory is authoritative everywhere else in this subsystem, so a
      // pack that names itself something else is refused rather than renamed.
      issues.push({ packId, code: 'id-mismatch', detail: `exports a descriptor for "${descriptor.id}"`, fatal: true });
      continue;
    }
    packs.push(descriptor);
  }

  if (wanted) {
    for (const packId of [...wanted].sort()) {
      if (seen.has(packId)) continue;
      issues.push({ packId, code: 'no-manifest', detail: `packs/${packId}/ does not exist in this catalog`, fatal: true });
    }
  }

  return { packs: orderByDependency(packs), issues };
}
