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

// Cross-pack resource invariants (Phase 3, platform contract v1).
//
// One manifest can be read in isolation; the platform's vocabulary cannot. Two
// packs can each be individually conformant while colliding on a concept id,
// and a workflow can subscribe to an event no manifest declares. Neither is
// visible from a per-pack view, and both are the coupling that a multi-specialty
// platform cannot cheaply unwind once a second specialty ships.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPackManifests, manifestDrift, type PackManifest, type PackManifestSpecialty } from '../src/control-plane/pack-manifest.js';
import {
  buildResourceRegistry,
  resourceReportFor,
  packOwnsEvent,
  resourcesByKind,
  type ResourceIssueCode,
} from '../src/control-plane/pack-resources.js';
import { PLATFORM_NAV_IDS, PLATFORM_CONCEPTS, PLATFORM_LENS_VIEWS, PLATFORM_VIEW_KINDS, validateSpecialtyPack } from '../src/control-plane/pack-contract.js';
import { manifestAsDomainPack, manifestAsSpecialtySections } from '../src/control-plane/pack-manifest.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Build a manifest in memory — the invariants are about the SET, so a fixture
 *  should be able to state exactly the two packs it is reasoning about. */
function manifest(id: string, specialty: PackManifestSpecialty, extra: Partial<PackManifest> = {}): PackManifest {
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
    ...extra,
  };
}

function resolve(manifests: readonly PackManifest[]) {
  return buildResourceRegistry({
    manifests,
    platformNavIds: PLATFORM_NAV_IDS,
    platformConcepts: PLATFORM_CONCEPTS,
    renderableViews: PLATFORM_LENS_VIEWS,
    renderableViewKinds: PLATFORM_VIEW_KINDS,
  });
}

function codes(registry: ReturnType<typeof resolve>): ResourceIssueCode[] {
  return registry.issues.map((i) => i.code);
}

function blocking(registry: ReturnType<typeof resolve>) {
  return registry.issues.filter((i) => i.blocking);
}

describe('the installed set', () => {
  it('resolves every declared pack with no blocking issue', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const registry = resolve(manifests);

    expect(blocking(registry).map((i) => `${i.packId}: ${i.detail}`)).toEqual([]);
    expect(registry.blockedPacks).toEqual([]);
    expect(registry.resolvedPacks).toBe(manifests.length);

    // The three declared packs must own real, resolvable surfaces.
    for (const id of ['dialysis-provider', 'payer', 'ckd-navigation']) {
      const report = resourceReportFor(registry, id);
      expect(report, `${id} has no resource report`).not.toBeNull();
      expect(report!.ontology).not.toBeNull();
      expect(report!.eventTypes.length).toBeGreaterThan(0);
      expect(report!.lens).not.toBeNull();
      expect(report!.resolved).toBe(true);
    }
  });

  it('every event type a specialty subscribes to has an owner', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const registry = resolve(manifests);
    const declared = new Set(Object.keys(registry.eventOwners));

    for (const m of manifests) {
      for (const w of m.specialty.workflows ?? []) {
        for (const type of w.events ?? []) {
          expect(declared.has(type), `${m.id}/${w.id} subscribes to undeclared "${type}"`).toBe(true);
        }
      }
    }
  });

  it('reports the declared surface through the contract, and is honest about a gap', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const registry = resolve(manifests);

    const levelOf = (packId: string): { level: string; missing: readonly string[]; usable: boolean } => {
      const m = manifests.find((x) => x.id === packId)!;
      const report = resourceReportFor(registry, packId)!;
      // Supplied exactly as the route supplies it, INCLUDING drift — two tests
      // asserting different levels for one pack is the disagreement this slice
      // exists to prevent.
      const c = validateSpecialtyPack(
        { ...manifestAsDomainPack(m), ...manifestAsSpecialtySections(m) },
        { resolution: report, manifestDrift: manifestDrift(manifestAsDomainPack(m), m) },
      );
      expect(c.checks.find((x) => x.id === 'resource-resolution')?.status).toBe('pass');
      expect(c.checks.find((x) => x.id === 'manifest-drift')?.status, `${packId} has manifest drift`).toBeUndefined();
      return { level: c.level, missing: c.missingSections, usable: c.usable };
    };

    // dialysis-provider and payer declare all five sections.
    expect(levelOf('dialysis-provider').level).toBe('conformant');
    expect(levelOf('payer').level).toBe('conformant');

    // ckd-navigation declares no measures, and that is a true statement about it
    // rather than a defect — so the contract reports `partial` and names the gap
    // instead of failing the pack or, worse, silently calling it conformant.
    const ckd = levelOf('ckd-navigation');
    expect(ckd.level).toBe('partial');
    expect(ckd.missing).toEqual(['measures']);
    expect(ckd.usable).toBe(true);
  });

  it('groups resolved artifacts by kind', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const registry = resolve(manifests);
    const byKind = resourcesByKind(registry);

    expect(byKind.ontology).toHaveLength(3);
    expect(byKind['ui-lens']).toHaveLength(3);
    // dialysis-provider is the deepest specialty in the repo.
    expect(byKind.workflows.length).toBeGreaterThanOrEqual(9);
    expect(byKind.measures).toHaveLength(2);
  });
});

describe('vocabulary collisions', () => {
  it('refuses one concept id owned by two packs', () => {
    const registry = resolve([
      manifest('a-pack', { ontology: { id: 'a', version: '1.0.0', concepts: ['shared.concept', 'a.only'] } }),
      manifest('b-pack', { ontology: { id: 'b', version: '1.0.0', concepts: ['shared.concept'] } }),
    ]);
    expect(codes(registry)).toEqual(['concept-collision']);
    // Report against the pack that made the SECOND claim — that is the one that
    // has to change.
    expect(registry.issues[0]?.packId).toBe('b-pack');
    expect(registry.issues[0]?.detail).toContain('a-pack');
    expect(registry.blockedPacks).toEqual(['b-pack']);
  });

  it('refuses a concept the platform owns', () => {
    const registry = resolve([
      manifest('a-pack', { ontology: { id: 'a', version: '1.0.0', concepts: [PLATFORM_CONCEPTS[0]!] } }),
    ]);
    expect(codes(registry)).toEqual(['concept-collision-with-platform']);
    expect(registry.issues[0]?.blocking).toBe(true);
  });

  it('allows two packs to share a canonical event type, and says so', () => {
    const registry = resolve([
      manifest('a-pack', { eventContracts: [{ types: ['treatment.completed'] }] }),
      manifest('b-pack', { eventContracts: [{ types: ['treatment.completed'] }] }),
    ]);
    expect(codes(registry)).toEqual(['shared-event-type']);
    // Sharing the substrate's vocabulary is the point of a canonical plane —
    // two specialties reacting to one fact must not be a failure.
    expect(registry.issues[0]?.blocking).toBe(false);
    expect(registry.blockedPacks).toEqual([]);
    expect(packOwnsEvent(registry, 'a-pack', 'treatment.completed')).toBe(true);
    expect(packOwnsEvent(registry, 'b-pack', 'treatment.completed')).toBe(false);
  });

  it('refuses one pack declaring the same artifact id twice', () => {
    const registry = resolve([
      manifest('a-pack', {
        workflows: [{ id: 'a.flow', events: [] }, { id: 'a.flow', events: [] }],
      }),
    ]);
    expect(codes(registry)).toEqual(['duplicate-artifact-id']);
    expect(registry.issues[0]?.packId).toBe('a-pack');
  });

  it('refuses two packs owning one workflow id', () => {
    const registry = resolve([
      manifest('a-pack', { workflows: [{ id: 'shared.flow' }] }),
      manifest('b-pack', { workflows: [{ id: 'shared.flow' }] }),
    ]);
    expect(codes(registry)).toEqual(['duplicate-artifact-id']);
    expect(registry.issues[0]?.packId).toBe('b-pack');
  });
});

describe('workflow subscriptions', () => {
  it('refuses a workflow subscribed to an event the pack never declared', () => {
    const registry = resolve([
      manifest('a-pack', {
        eventContracts: [{ types: ['treatment.completed'] }],
        workflows: [{ id: 'a.flow', events: ['treatment.completed', 'lab.result-arrived'] }],
      }),
    ]);
    expect(codes(registry)).toEqual(['orphan-event']);
    expect(registry.issues[0]?.detail).toContain('lab.result-arrived');
    expect(registry.issues[0]?.blocking).toBe(true);
  });

  it('accepts a workflow subscribed only to declared events', () => {
    const registry = resolve([
      manifest('a-pack', {
        eventContracts: [{ types: ['treatment.completed'] }],
        workflows: [{ id: 'a.flow', events: ['treatment.completed'] }],
      }),
    ]);
    expect(registry.issues).toEqual([]);
    expect(registry.resolvedPacks).toBe(1);
  });
});

describe('cross-pack workflows', () => {
  it('refuses a workflow whose partner has never heard of it', () => {
    const registry = resolve([
      manifest('a-pack', {
        eventContracts: [{ types: ['treatment.completed'] }],
        workflows: [{ id: 'handoff.flow', events: ['treatment.completed'], crossPackWith: ['b-pack'] }],
      }),
      manifest('b-pack', {}),
    ]);
    expect(codes(registry)).toEqual(['one-sided-cross-pack-workflow']);
    // Reported against the SILENT side: one side believes it is connected and
    // the other has never heard of it.
    expect(registry.issues[0]?.packId).toBe('b-pack');
    expect(registry.issues[0]?.detail).toContain('a-pack');
  });

  it('accepts a workflow both ends declare', () => {
    const registry = resolve([
      manifest('a-pack', {
        eventContracts: [{ types: ['treatment.completed'] }],
        workflows: [{ id: 'handoff.flow', events: ['treatment.completed'], crossPackWith: ['b-pack'] }],
      }),
      manifest('b-pack', {
        eventContracts: [{ types: ['treatment.completed'] }],
        workflows: [{ id: 'handoff.flow', events: ['treatment.completed'], crossPackWith: ['a-pack'] }],
      }),
    ]);
    expect(blocking(registry)).toEqual([]);
    expect(registry.resolvedPacks).toBe(2);
  });

  it('refuses a cross-pack partner that is not installed', () => {
    const registry = resolve([
      manifest('a-pack', { workflows: [{ id: 'handoff.flow', crossPackWith: ['ghost-pack'] }] }),
    ]);
    expect(codes(registry)).toEqual(['unknown-cross-pack-target']);
    expect(registry.issues[0]?.detail).toContain('ghost-pack');
  });
});

describe('measure authority', () => {
  it('refuses a CMS-bound measure with no declared authority', () => {
    const registry = resolve([
      manifest('a-pack', {
        measures: [{ id: 'esrd-qip:ktv', cmsId: 'esrd-qip' }, { id: '0057-f:api', cmsId: 'cms:0057-f' }],
      }, { cmsUniverse: [{ id: 'esrd-qip', title: 'ESRD QIP', authority: 'CMS' }] }),
    ]);
    expect(codes(registry)).toEqual(['unbacked-cms-measure']);
    // A quality claim without a declared authority is the one that ends up in a
    // submission, so the unbacked measure is named exactly.
    expect(registry.issues[0]?.detail).toContain('0057-f:api');
    expect(registry.issues[0]?.detail).toContain('cms:0057-f');
  });

  it('accepts a measure bound to a declared authority', () => {
    const registry = resolve([
      manifest('a-pack', {
        measures: [{ id: 'esrd-qip:ktv', cmsId: 'esrd-qip' }],
      }, { cmsUniverse: [{ id: 'esrd-qip', title: 'ESRD QIP', authority: 'CMS' }] }),
    ]);
    expect(registry.issues).toEqual([]);
  });

  it('does not demand an authority for a measure that claims none', () => {
    const registry = resolve([manifest('a-pack', { measures: [{ id: 'local:thing' }] })]);
    expect(registry.issues).toEqual([]);
  });
});

describe('the specialty lens', () => {
  it('refuses a lens that takes a platform navigation slot', () => {
    const registry = resolve([
      manifest('a-pack', { uiLens: { id: 'a', label: 'A', nav: ['my-work', 'a-specific'] } }),
    ]);
    expect(codes(registry)).toEqual(['lens-shadows-platform-nav']);
    expect(registry.issues[0]?.detail).toContain('my-work');
  });

  it('accepts a lens that adds navigation of its own', () => {
    const registry = resolve([
      manifest('a-pack', { uiLens: { id: 'a', label: 'A', nav: ['a-intake', 'a-review'] } }),
    ]);
    expect(registry.issues).toEqual([]);
  });

  it('refuses a lens that surfaces a view the shell cannot draw', () => {
    const registry = resolve([
      manifest('a-pack', {
        uiLens: { id: 'a', label: 'A', views: [{ id: 'protocols', label: 'Cockpit' }, { id: 'made-up', label: 'Imaginary' }] },
      }),
    ]);
    // An empty tab reads as a broken product, so an undrawable view is refused
    // rather than rendered as blank.
    expect(codes(registry)).toEqual(['unknown-lens-view']);
    expect(registry.issues[0]?.detail).toContain('made-up');
    expect(registry.issues[0]?.blocking).toBe(true);
  });

  it('accepts a lens that surfaces only renderable views', () => {
    const registry = resolve([
      manifest('a-pack', { uiLens: { id: 'a', label: 'A', views: [{ id: 'protocols', label: 'Cockpit' }] } }),
    ]);
    expect(registry.issues).toEqual([]);
  });
});

describe('what the installed lenses surface', () => {
  it('gives each lens exactly the views it declares, and none it does not', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const registry = resolve(manifests);

    const renal = resourceReportFor(registry, 'dialysis-provider')!.lens!;
    // The renal lens surfaces the protocol strip it actually has components for.
    expect(renal.views.map((v) => v.id)).toEqual(PLATFORM_LENS_VIEWS);

    // The payer lens surfaces NONE of them. This is the defect the field exists
    // to fix: the shell used to render the hardcoded dialysis protocol strip in
    // every lens, so a payer console showed Anemia & ESA, CKD-MBD and six more.
    const payer = resourceReportFor(registry, 'payer')!.lens!;
    expect(payer.views).toEqual([]);

    // And no OTHER lens may claim renal's views, or the leak simply moves.
    for (const report of registry.byPack) {
      if (report.packId === 'dialysis-provider' || !report.lens) continue;
      const leaked = report.lens.views.filter((v) => v.id === 'anemia' || v.id === 'mbd' || v.id === 'infection');
      expect(leaked, `${report.packId} surfaces renal views`).toEqual([]);
    }
  });
});

describe('the contract consumes resolution', () => {
  it('fails a pack whose declared module did not resolve', () => {
    const m = manifest('a-pack', { ontology: { id: 'a', version: '1.0.0', module: 'ontology.ts' } });
    const conformance = validateSpecialtyPack(
      { ...manifestAsDomainPack(m), ...manifestAsSpecialtySections(m) },
      { resolution: { resolved: false, issues: [{ detail: 'ontology "a" names module "ontology.ts", which does not exist', blocking: true }] } },
    );
    const check = conformance.checks.find((c) => c.id === 'resource-resolution');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('does not exist');
    // The whole point: an unresolvable declaration is nonconformant, not
    // "partial". A pack the platform cannot host must not look installable.
    expect(conformance.usable).toBe(false);
    expect(conformance.level).toBe('nonconformant');
  });

  it('does not ask the question when no resolution was supplied', () => {
    const m = manifest('a-pack', {});
    const conformance = validateSpecialtyPack({ ...manifestAsDomainPack(m), ...manifestAsSpecialtySections(m) });
    expect(conformance.checks.find((c) => c.id === 'resource-resolution')).toBeUndefined();
  });

  it('exempts the substrate from the resolution question', () => {
    const m = manifest('healthcare-core', {}, { appliesTo: { organizationKinds: ['provider'] } });
    const conformance = validateSpecialtyPack(
      { ...manifestAsDomainPack(m), ...manifestAsSpecialtySections(m) },
      { resolution: { resolved: false, issues: [{ detail: 'nope', blocking: true }] } },
    );
    expect(conformance.level).toBe('substrate');
  });

  it('reports drift between the manifest and the pack descriptor, without failing the pack', () => {
    // This is the shape `packs/payer` shipped in: a manifest claiming one
    // version and capability set while the TypeScript descriptor — which the
    // RUNTIME actually resolves — carried another. Both were "the manifest".
    const m = manifest('a-pack', {}, {
      version: '0.1.0',
      capabilities: ['one', 'two'],
    });
    const drift = manifestDrift(
      { ...manifestAsDomainPack(m), version: '0.2.0', capabilities: ['one', 'two', 'three'] },
      m,
    );

    expect(drift.map((d) => d.field).sort()).toEqual(['capabilities', 'version']);
    expect(drift.find((d) => d.field === 'version')).toMatchObject({ manifest: '0.1.0', pack: '0.2.0' });

    const conformance = validateSpecialtyPack(
      { ...manifestAsDomainPack(m), version: '0.2.0', capabilities: ['one', 'two', 'three'] },
      { manifestDrift: drift },
    );
    const check = conformance.checks.find((c) => c.id === 'manifest-drift');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('version');
    // Warn, not fail: the pack still works, but a reader must not be told one
    // thing while the platform does another.
    expect(conformance.usable).toBe(true);
  });
});
