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

// G5 — a specialty can add a SCREEN without a platform change.
//
// G1 was "a pack cannot contribute a route". This is the same defect one layer
// up, and harder to see, because the grouped submenu LOOKS data-driven right up
// to the point where a pack asks for a kind of screen the shell has never heard
// of. A view used to be an ID, and an id only means something because a `case`
// arm exists for it in `exec-app`.
//
// The load-bearing test in this file is the FIRST one. `PLATFORM_VIEW_KINDS`
// lives in the platform contract and `VIEW_RENDERER_KINDS` lives in the shell, so
// "may a pack declare this" and "can the shell draw it" are two lists in two
// projects with nothing but a human reading both files to keep them equal. That
// is exactly the shape of drift `tests/workspace-kinds.test.ts` was written for
// after the same pair diverged twice by hand, and the guard is the same: compare
// them, in a test, so a machine finds it instead of a clinician finding an empty
// tab.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORM_VIEW_KINDS } from '../src/control-plane/pack-contract.js';
import { buildResourceRegistry, type ResourceIssueCode } from '../src/control-plane/pack-resources.js';
import type { PackManifest, PackManifestSpecialty } from '../src/control-plane/pack-manifest.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function manifest(id: string, specialty: PackManifestSpecialty): PackManifest {
  return {
    id,
    version: '1.0.0',
    extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
    appliesTo: { organizationKinds: ['provider'] },
    capabilities: ['x'],
    cmsUniverse: [],
    requiredControls: ['access-policy'],
    specialty,
    entry: 'index.ts',
    path: `packs/${id}/manifest.yaml`,
  };
}

function resolve(manifests: readonly PackManifest[]) {
  return buildResourceRegistry({
    manifests,
    renderableViews: ['protocols'],
    renderableViewKinds: PLATFORM_VIEW_KINDS,
  });
}

const codes = (registry: ReturnType<typeof resolve>): ResourceIssueCode[] => registry.issues.map((i) => i.code);

describe('G5 — the platform and the shell agree on the view kinds', () => {
  it('every kind the platform accepts has a renderer in the shell, and no more', () => {
    // Read from source rather than imported: `exec-app` is a separate Vite project
    // with its own tsconfig, and a test that could not load it would fail for a
    // reason unrelated to the thing being checked. The list is a literal in a
    // module whose entire purpose is to be this list.
    const source = readFileSync(new URL('../exec-app/src/lib/view-kinds.ts', import.meta.url), 'utf8');
    const match = /VIEW_RENDERER_KINDS\s*=\s*\[([^\]]*)\]/.exec(source);
    expect(match, 'VIEW_RENDERER_KINDS is not a readable literal — this guard cannot check it').toBeTruthy();
    const shellKinds = [...match![1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);

    // Two directions, both failures. A kind the platform accepts with no renderer
    // is an empty tab under a heading that promises a screen. A renderer with no
    // declared kind is dead code that a reader will assume is reachable.
    expect(shellKinds.sort()).toEqual([...PLATFORM_VIEW_KINDS].sort());
  });

  it('the shipped manifests use only kinds the shell can draw', () => {
    // The guard above compares two lists. This checks the lists against the thing
    // they describe — a pack could still ship a kind neither side lists.
    const offenders: string[] = [];
    for (const pack of ['dialysis-provider', 'payer', 'ckd-navigation']) {
      const yaml = readFileSync(`${REPO_ROOT}/packs/${pack}/manifest.yaml`, 'utf8');
      for (const m of yaml.matchAll(/kind:\s*([A-Za-z0-9-]+)/g)) {
        if (!PLATFORM_VIEW_KINDS.includes(m[1]!)) offenders.push(`${pack}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('G5 — a second specialty declares a screen by KIND', () => {
  it('accepts a non-renal specialty whose view names a known kind and its own route', () => {
    // The exit criterion, stated as a fixture: nothing here is renal, and nothing
    // here requires the shell to know what oncology is. Before G5 this was a
    // blocking `unknown-lens-view` because `oncology-regimen` is not one of the
    // eleven renal ids.
    const registry = resolve([
      manifest('oncology-provider', {
        uiLens: {
          id: 'oncology',
          label: 'Oncology',
          views: [{ id: 'oncology-regimen', label: 'Regimen review', kind: 'ranked-actions', source: '/admin/swarm/oncology/state' }],
        },
      }),
    ]);
    expect(codes(registry)).toEqual([]);
    expect(registry.resolvedPacks).toBe(1);
  });

  it('refuses a kind the shell has no renderer for', () => {
    const registry = resolve([
      manifest('oncology-provider', {
        uiLens: {
          id: 'oncology',
          label: 'Oncology',
          views: [{ id: 'regimen', label: 'Regimen', kind: 'holographic-orrery', source: '/admin/swarm/oncology/state' }],
        },
      }),
    ]);
    expect(codes(registry)).toEqual(['unknown-view-kind']);
    expect(registry.issues[0]?.detail).toContain('holographic-orrery');
    expect(registry.issues[0]?.blocking).toBe(true);
  });

  it('refuses a kind with no source, rather than rendering an empty board', () => {
    // The id cannot stand in for the source. `vascular-access` is a view id whose
    // route is `/admin/swarm/access` — the shell could not derive one from the
    // other without being told the specialty exists, which is the problem.
    const registry = resolve([
      manifest('oncology-provider', {
        uiLens: { id: 'oncology', label: 'Oncology', views: [{ id: 'regimen', label: 'Regimen', kind: 'ranked-actions' }] },
      }),
    ]);
    expect(codes(registry)).toEqual(['view-kind-without-source']);
    expect(registry.issues[0]?.blocking).toBe(true);
  });

  it('keeps BOTH vocabularies live — an id-only view is still checked against the ids', () => {
    // This is the compatibility path, and it has to keep working: the eleven renal
    // declarations were NOT migrated, because on inspection they are page
    // compositions rather than boards (see `exec-app/src/lib/view-kinds.ts`). A
    // migration that replaced them would have deleted seven working pages to make
    // a table look tidier.
    const registry = resolve([
      manifest('dialysis-provider', {
        uiLens: {
          id: 'renal',
          label: 'Renal',
          views: [
            { id: 'protocols', label: 'Cockpit' },
            { id: 'made-up', label: 'Imaginary' },
          ],
        },
      }),
    ]);
    expect(codes(registry)).toEqual(['unknown-lens-view']);
  });
});
