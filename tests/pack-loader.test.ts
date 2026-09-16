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

// The pack loader, and the two properties that make it usable at boot.
//
// FAILURE ISOLATION: a pack is third-party-shaped code arriving in our process. A
// boot that dies because one pack has a syntax error takes the platform down for
// specialties that are not even applied — so a pack that cannot load is REPORTED
// and skipped. The report is what keeps that honest: a silently skipped pack is
// the "absent pack still served" defect from the other direction, and an operator
// reading a green console would have no way to tell.
//
// ORDERING: the hand-written install list encoded `extends` order implicitly, by
// putting the substrate first. That is fine while a human maintains the list and a
// trap the moment one is generated, so the loader owns it.
//
// The fixtures are `.mjs` on purpose — the loader dynamic-imports whatever path a
// manifest names, and a plain JavaScript entry proves it is not quietly relying on
// being run under `tsx`.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstalledPacks, orderByDependency, packDirectories } from '../src/control-plane/pack-loader.js';
import type { DomainPack } from '../src/control-plane/pack-registry.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function descriptor(id: string, over: Partial<DomainPack> = {}): string {
  const pack: DomainPack = {
    id,
    version: '1.0.0',
    extends: [],
    appliesTo: { organizationKinds: ['provider'] },
    capabilities: ['x'],
    cmsUniverse: [],
    requiredControls: ['access-policy'],
    ...over,
  };
  return `export const ${id.replace(/[^A-Za-z0-9]/g, '_')}Pack = ${JSON.stringify(pack)};\n`;
}

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pack-loader-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

const manifestYaml = (id: string, entry: string): string => `id: ${id}\nversion: 1.0.0\nentry: ${entry}\n`;

describe('the pack loader — the real catalog', () => {
  it('loads every pack directory from its own manifest', async () => {
    const { packs, issues } = await loadInstalledPacks(REPO_ROOT);
    expect(issues).toEqual([]);
    // Every directory with a manifest, which the catalog test separately pins.
    expect(packs.length).toBe(packDirectories(REPO_ROOT).length);
    expect(packs.length).toBeGreaterThan(20);
    expect(packs.map((p) => p.id)).toContain('dialysis-provider');
  });

  it('places a pack AFTER everything it extends', async () => {
    const { packs } = await loadInstalledPacks(REPO_ROOT);
    const position = new Map(packs.map((p, i) => [p.id, i]));
    const inverted: string[] = [];
    for (const pack of packs) {
      for (const dep of pack.extends) {
        const target = position.get(dep.id);
        if (target === undefined) continue; // not installed here; the registry owns that verdict
        if (target > position.get(pack.id)!) inverted.push(`${pack.id} extends ${dep.id}`);
      }
    }
    expect(inverted).toEqual([]);
  });

  it('is deterministic — the same catalog twice is the same order', async () => {
    const a = await loadInstalledPacks(REPO_ROOT);
    const b = await loadInstalledPacks(REPO_ROOT);
    expect(a.packs.map((p) => p.id)).toEqual(b.packs.map((p) => p.id));
  });
});

describe('the pack loader — failure is isolated and REPORTED', () => {
  it('skips a pack whose entry does not exist, and still loads the others', async () => {
    const root = fixtureRoot({
      'packs/good/manifest.yaml': manifestYaml('good', 'index.mjs'),
      'packs/good/index.mjs': descriptor('good'),
      'packs/broken/manifest.yaml': manifestYaml('broken', 'missing.mjs'),
    });
    const { packs, issues } = await loadInstalledPacks(root);
    expect(packs.map((p) => p.id)).toEqual(['good']);
    expect(issues.map((i) => `${i.packId}:${i.code}`)).toEqual(['broken:no-entry']);
    expect(issues[0]?.fatal).toBe(true);
  });

  it('skips a pack whose module throws on import', async () => {
    const root = fixtureRoot({
      'packs/good/manifest.yaml': manifestYaml('good', 'index.mjs'),
      'packs/good/index.mjs': descriptor('good'),
      'packs/exploding/manifest.yaml': manifestYaml('exploding', 'index.mjs'),
      'packs/exploding/index.mjs': 'throw new Error("this pack is broken");\n',
    });
    const { packs, issues } = await loadInstalledPacks(root);
    expect(packs.map((p) => p.id)).toEqual(['good']);
    expect(issues.map((i) => i.code)).toEqual(['import-failed']);
    // The pack's own message is carried, not swallowed — the reason is what makes
    // the skip actionable.
    expect(issues[0]?.detail).toContain('this pack is broken');
  });

  it('skips a module that exports no descriptor, and one that names itself differently', async () => {
    const root = fixtureRoot({
      'packs/good/manifest.yaml': manifestYaml('good', 'index.mjs'),
      'packs/good/index.mjs': descriptor('good'),
      'packs/empty/manifest.yaml': manifestYaml('empty', 'index.mjs'),
      'packs/empty/index.mjs': 'export const nothing = 1;\n',
      'packs/renamed/manifest.yaml': manifestYaml('renamed', 'index.mjs'),
      'packs/renamed/index.mjs': descriptor('something-else'),
    });
    const { packs, issues } = await loadInstalledPacks(root);
    expect(packs.map((p) => p.id)).toEqual(['good']);
    // Directory is authoritative everywhere else in this subsystem, so a pack that
    // names itself something else is refused rather than renamed.
    expect(issues.map((i) => `${i.packId}:${i.code}`).sort()).toEqual(['empty:no-descriptor', 'renamed:id-mismatch']);
  });

  it('reports a requested pack that ships no manifest, and ignores unrequested ones', async () => {
    const root = fixtureRoot({ 'packs/good/manifest.yaml': manifestYaml('good', 'index.mjs'), 'packs/good/index.mjs': descriptor('good') });
    // A directory with no manifest in a FULL scan is not installed by definition,
    // not a failure. It is only a failure when someone asked for it by name.
    const full = await loadInstalledPacks(root);
    expect(full.issues).toEqual([]);
    const asked = await loadInstalledPacks(root, { only: ['ghost'] });
    expect(asked.packs).toEqual([]);
    expect(asked.issues.map((i) => i.code)).toEqual(['no-manifest']);
  });
});

describe('the pack loader — dependency order', () => {
  it('moves a substrate before its dependants regardless of input order', () => {
    const core: DomainPack = {
      id: 'healthcare-core', version: '1.0.0', extends: [],
      appliesTo: { organizationKinds: ['provider'] }, capabilities: ['x'], cmsUniverse: [], requiredControls: ['access-policy'],
    };
    const dependent: DomainPack = { ...core, id: 'payer', extends: [{ id: 'healthcare-core', versionRange: '^1.0.0' }] };
    const chained: DomainPack = { ...core, id: 'aaa-later', extends: [{ id: 'payer', versionRange: '^1.0.0' }] };
    // Deliberately the worst input order, and alphabetically the dependant comes
    // FIRST — so a plain sort by id would be wrong in a way a passing test on the
    // real catalog would not notice.
    const ordered = orderByDependency([chained, dependent, core]).map((p) => p.id);
    expect(ordered).toEqual(['healthcare-core', 'payer', 'aaa-later']);
  });

  it('is alphabetical within a level, so readdir order cannot change the result', () => {
    const mk = (id: string): DomainPack => ({
      id, version: '1.0.0', extends: [],
      appliesTo: { organizationKinds: ['provider'] }, capabilities: ['x'], cmsUniverse: [], requiredControls: ['access-policy'],
    });
    expect(orderByDependency([mk('z'), mk('a'), mk('m')]).map((p) => p.id)).toEqual(['a', 'm', 'z']);
  });

  it('does not fail on a dependency that is not being loaded', () => {
    // A deployment may install a specialty without an optional companion. The
    // registry owns that verdict; a loader that refused would reject a set the
    // registry accepts.
    const orphan: DomainPack = {
      id: 'standalone', version: '1.0.0', extends: [{ id: 'absent', versionRange: '^1.0.0' }],
      appliesTo: { organizationKinds: ['provider'] }, capabilities: ['x'], cmsUniverse: [], requiredControls: ['access-policy'],
    };
    expect(orderByDependency([orphan]).map((p) => p.id)).toEqual(['standalone']);
  });
});
