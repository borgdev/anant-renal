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

// Pack manifest loader (Phase 3, platform contract v1).
//
// The first test in this file is the one that matters most: it loads every
// manifest in the REPOSITORY. Nothing parsed these files before, and
// `packs/revenue-cycle/manifest.yaml` had been syntactically invalid YAML
// (`facility_kinds:\n    - *`) for as long as it has existed — an empty alias
// no parser accepts. A manifest is the artifact a second specialty arrives
// through, so "it does not parse" is not a documentation nit.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPackManifest,
  loadPackManifests,
  packIdsWithManifests,
  manifestAsDomainPack,
  manifestAsSpecialtySections,
  declaredEventTypes,
  resourceDeclarations,
} from '../src/control-plane/pack-manifest.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A throwaway pack directory with a manifest, so the loader can be driven
 *  against a shape the repository does not happen to contain. */
function fixtureRepo(manifestYaml: string, packId = 'fixture-pack', extraFile?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pack-manifest-'));
  const dir = join(root, 'packs', packId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.yaml'), manifestYaml, 'utf8');
  if (extraFile) writeFileSync(join(dir, extraFile), 'export const x = 1;\n', 'utf8');
  return root;
}

const MINIMAL = `id: fixture-pack
version: 1.2.3
extends:
  - id: healthcare-core
    version_range: ^0.2.0
applies_to:
  organization_kinds: [provider]
capabilities:
  - thing-doing
required_controls:
  - access-policy
`;

describe('the repository’s own manifests', () => {
  it('every manifest parses, and none carries a blocking issue', () => {
    const { manifests, issues } = loadPackManifests(REPO_ROOT);
    const blocking = issues.filter((i) => i.blocking);

    // The failure message has to name the file, or the next person spends an
    // afternoon finding it. `revenue-cycle` is why this test exists.
    expect(blocking.map((i) => `${i.packId}: ${i.detail}`)).toEqual([]);
    expect(packIdsWithManifests(REPO_ROOT).length).toBeGreaterThanOrEqual(14);
    expect(manifests.length).toBe(packIdsWithManifests(REPO_ROOT).length);
  });

  it('a manifest may not claim an id other than its directory', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    for (const m of manifests) {
      expect(m.path).toBe(`packs/${m.id}/manifest.yaml`);
    }
  });

  it('the declared specialty packs point at modules that exist', () => {
    const { manifests } = loadPackManifests(REPO_ROOT);
    const declared = manifests.filter((m) => Object.keys(m.specialty).length > 0);
    // `care-management` joined this set when G3 declared the cross-pack hand-off
    // it participates in, and it declares workflows ONLY — no ontology, no
    // measures, no lens. A specialty block is not a claim to be a specialty, and
    // listing the members is what makes that visible rather than inferred.
    // `oncology-provider` is the opposite case: it was installed and declared
    // nothing at all, so it now declares a full surface.
    expect(declared.map((m) => m.id).sort()).toEqual([
      'care-management', 'ckd-navigation', 'dialysis-provider', 'oncology-provider', 'payer',
    ]);

    for (const m of declared) {
      for (const decl of resourceDeclarations(m)) {
        if (!decl.module) continue;
        // resolveManifestResources already checks this; asserting it again here
        // is what makes the guarantee legible at the call site.
        expect(decl.module).toMatch(/\.ts$/);
      }
    }
  });
});

describe('normalisation', () => {
  it('maps the on-disk snake_case into the registry shape', () => {
    const root = fixtureRepo(MINIMAL);
    const { manifest, issues } = loadPackManifest(root, 'fixture-pack');
    expect(issues).toEqual([]);
    expect(manifest).not.toBeNull();
    const pack = manifestAsDomainPack(manifest!);

    expect(pack.id).toBe('fixture-pack');
    expect(pack.version).toBe('1.2.3');
    // `version_range` is the on-disk spelling; the registry resolves camelCase.
    expect(pack.extends).toEqual([{ id: 'healthcare-core', versionRange: '^0.2.0' }]);
    expect(pack.appliesTo.organizationKinds).toEqual(['provider']);
    expect(pack.capabilities).toEqual(['thing-doing']);
    expect(pack.requiredControls).toEqual(['access-policy']);
  });

  it('also accepts the camelCase spelling the TypeScript shape uses', () => {
    const root = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends:
  - id: healthcare-core
    versionRange: ^0.2.0
applies_to:
  organizationKinds: [payer]
  facilityKinds: [dialysis]
capabilities: [x]
required_controls: [access-policy]
`);
    const { manifest } = loadPackManifest(root, 'fixture-pack');
    const pack = manifestAsDomainPack(manifest!);
    expect(pack.extends[0]?.versionRange).toBe('^0.2.0');
    expect(pack.appliesTo.organizationKinds).toEqual(['payer']);
    expect(pack.appliesTo.facilityKinds).toEqual(['dialysis']);
  });

  it('keeps a DECLARED EMPTY view list apart from an omitted one', () => {
    // `views: []` claims "this lens surfaces no clinical views"; omitting the key
    // claims nothing at all and lets the shell use its own default. Collapsing the
    // first into the second put the renal protocol strip back on a payer console —
    // found by running it, not by reading it.
    const declaredEmpty = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends: [{ id: healthcare-core, version_range: ^0.2.0 }]
applies_to: { organization_kinds: [payer] }
capabilities: [x]
required_controls: [access-policy]
specialty:
  ui_lens:
    id: payer
    label: Payer
    views: []
`);
    const omitted = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends: [{ id: healthcare-core, version_range: ^0.2.0 }]
applies_to: { organization_kinds: [payer] }
capabilities: [x]
required_controls: [access-policy]
specialty:
  ui_lens:
    id: payer
    label: Payer
`);
    const a = loadPackManifest(declaredEmpty, 'fixture-pack').manifest!;
    const b = loadPackManifest(omitted, 'fixture-pack').manifest!;

    expect(a.specialty.uiLens?.views).toEqual([]);
    expect(a.specialty.uiLens && 'views' in a.specialty.uiLens).toBe(true);
    expect(b.specialty.uiLens?.views).toBeUndefined();
    expect(b.specialty.uiLens && 'views' in b.specialty.uiLens).toBe(false);
  });

  it('projects a specialty surface into the contract shape', () => {
    const root = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends: [{ id: healthcare-core, version_range: ^0.2.0 }]
applies_to: { organization_kinds: [provider] }
capabilities: [x]
cms_universe:
  - id: cms:thing
    title: A CMS thing
    authority: CMS
required_controls: [access-policy]
specialty:
  ontology:
    id: fixture-domain
    version: 2.0.0
    concepts: [a.one, a.two, a.three]
  event_contracts:
    - types: [treatment.completed, treatment.missed]
  workflows:
    - id: fixture.flow
      events: [treatment.completed]
  measures:
    - id: thing:rate
      cms_id: cms:thing
  ui_lens:
    id: fixture
    label: Fixture
    terminology:
      patient: Subject
`);
    const { manifest, issues } = loadPackManifest(root, 'fixture-pack');
    expect(issues).toEqual([]);

    const sections = manifestAsSpecialtySections(manifest!);
    expect(sections.ontology).toEqual({ id: 'fixture-domain', version: '2.0.0', conceptCount: 3 });
    expect(sections.eventContracts).toEqual(['treatment.completed', 'treatment.missed']);
    expect(sections.workflows).toEqual(['fixture.flow']);
    expect(sections.measures).toEqual(['thing:rate']);
    expect(sections.uiLens?.label).toBe('Fixture');

    expect(declaredEventTypes(manifest!)).toEqual(['treatment.completed', 'treatment.missed']);
    // The module-less declarations are legal: a lens and event contracts may be
    // data the shell or the substrate already owns.
    expect(resourceDeclarations(manifest!).every((d) => d.module === undefined)).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses a manifest whose id disagrees with its directory', () => {
    const root = fixtureRepo(MINIMAL.replace('id: fixture-pack', 'id: something-else'));
    const { manifest, issues } = loadPackManifest(root, 'fixture-pack');
    expect(manifest).toBeNull();
    expect(issues[0]?.code).toBe('id-mismatch');
    expect(issues[0]?.detail).toContain('packs/fixture-pack/');
  });

  it('refuses malformed YAML rather than treating it as an empty manifest', () => {
    const root = fixtureRepo('id: fixture-pack\nversion: 1.0.0\napplies_to:\n  facility_kinds:\n    - *\n');
    const { manifest, issues } = loadPackManifest(root, 'fixture-pack');
    expect(manifest).toBeNull();
    expect(issues[0]?.code).toBe('malformed-yaml');
  });

  it('refuses a manifest with no version', () => {
    const root = fixtureRepo('id: fixture-pack\napplies_to:\n  organization_kinds: [provider]\n');
    const { manifest, issues } = loadPackManifest(root, 'fixture-pack');
    expect(manifest).toBeNull();
    expect(issues[0]?.code).toBe('missing-version');
  });

  it('FAILS a declaration whose module does not exist — a declaration is not a claim', () => {
    const root = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends: [{ id: healthcare-core, version_range: ^0.2.0 }]
applies_to: { organization_kinds: [provider] }
capabilities: [x]
required_controls: [access-policy]
specialty:
  ontology:
    id: fixture-domain
    version: 1.0.0
    module: ontology.ts
`);
    const { manifest, issues } = loadPackManifest(root, 'fixture-pack');
    // The manifest parses; the ARTIFACT it names is missing.
    expect(manifest).not.toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unresolved-module');
    expect(issues[0]?.blocking).toBe(true);
    expect(issues[0]?.detail).toContain('ontology.ts');
  });

  it('accepts the same declaration once the module exists', () => {
    const root = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends: [{ id: healthcare-core, version_range: ^0.2.0 }]
applies_to: { organization_kinds: [provider] }
capabilities: [x]
required_controls: [access-policy]
specialty:
  ontology:
    id: fixture-domain
    version: 1.0.0
    module: ontology.ts
`, 'fixture-pack', 'ontology.ts');
    const { issues } = loadPackManifest(root, 'fixture-pack');
    expect(issues).toEqual([]);
  });

  it('accepts a module that names a directory', () => {
    const root = fixtureRepo(`id: fixture-pack
version: 1.0.0
extends: [{ id: healthcare-core, version_range: ^0.2.0 }]
applies_to: { organization_kinds: [provider] }
capabilities: [x]
required_controls: [access-policy]
specialty:
  measures:
    - id: thing:rate
      module: measures
`, 'fixture-pack');
    mkdirSync(join(root, 'packs', 'fixture-pack', 'measures'), { recursive: true });
    const { issues } = loadPackManifest(root, 'fixture-pack');
    expect(issues).toEqual([]);
  });

  it('reports an unreadable manifest instead of throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-manifest-'));
    const { manifest, issues } = loadPackManifest(root, 'absent');
    expect(manifest).toBeNull();
    expect(issues[0]?.code).toBe('unreadable');
    expect(issues[0]?.blocking).toBe(true);
  });
});
