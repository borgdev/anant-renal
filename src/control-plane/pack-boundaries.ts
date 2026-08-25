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

// Pack import-boundary enforcement.
//
// Contract:
//   • A pack's TypeScript sources (under `packs/<packId>/**`) may import from
//     `src/**` (the platform library) and from within their own directory.
//   • A pack MUST NOT import from another pack's source tree directly. Cross-
//     pack coupling is expressed via `DomainPack.extends[].id` in the pack's
//     manifest and resolved by the pack registry at load time.
//   • The healthcare-core pack is the substrate; other packs declare it in
//     `extends` and access its exports through `src/healthcare-core/**`.
//
// The enforcer walks the file system, parses each pack's imports with a
// deliberately narrow regex (ESM-only, matches static `import ... from '...'`
// specifiers), and emits `BoundaryViolation` records. It is invoked from a
// unit test so violations fail CI, and can also be called from the control
// plane at boot to refuse to serve a repository with cross-pack leakage.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface BoundaryViolation {
  readonly file: string;
  readonly importedSpecifier: string;
  readonly reason: 'cross-pack-import' | 'unresolved-pack-target' | 'undeclared-dependency';
  readonly fromPackId: string;
  readonly toPackId?: string;
}

export interface PackManifestLike {
  readonly id: string;
  readonly extends?: readonly { readonly id: string }[];
}

const IMPORT_RE = /(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"`]+)['"]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
      out.push(...walk(p));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** Extract pack id from a path like `packs/<id>/...`. Returns null if not a pack file. */
export function packIdFromPath(repoRoot: string, filePath: string): string | null {
  const rel = relative(repoRoot, filePath).split(sep);
  if (rel[0] !== 'packs' || rel.length < 2) return null;
  return rel[1] ?? null;
}

/** Extract the target pack id from an import specifier if it points into another pack. */
export function targetPackFromSpecifier(specifier: string): string | null {
  // Normalize any ../ prefixes and look for `packs/<id>/...`.
  const idx = specifier.indexOf('packs/');
  if (idx === -1) return null;
  const rest = specifier.slice(idx + 'packs/'.length);
  const seg = rest.split('/')[0];
  return seg && seg.length > 0 ? seg : null;
}

/** Run the boundary check across every pack under `<repoRoot>/packs`. */
export function checkPackBoundaries(
  repoRoot: string,
  manifests: readonly PackManifestLike[],
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const manifestById = new Map(manifests.map((m) => [m.id, m]));
  const packsDir = join(repoRoot, 'packs');

  let files: string[];
  try { files = walk(packsDir); } catch { return violations; }

  for (const file of files) {
    const fromPack = packIdFromPath(repoRoot, file);
    if (!fromPack) continue;
    const src = readFileSync(file, 'utf8');
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      if (!spec) continue;
      const toPack = targetPackFromSpecifier(spec);
      if (!toPack || toPack === fromPack) continue;
      // Any direct cross-pack import is a violation. The dependency graph
      // is declared via `extends`, and consumers must go through the
      // exported pack surface, not the neighbor pack's source tree.
      const fromManifest = manifestById.get(fromPack);
      const declared = (fromManifest?.extends ?? []).some((e) => e.id === toPack);
      violations.push({
        file: relative(repoRoot, file),
        importedSpecifier: spec,
        reason: declared ? 'cross-pack-import' : 'undeclared-dependency',
        fromPackId: fromPack,
        toPackId: toPack,
      });
    }
  }
  return violations;
}
