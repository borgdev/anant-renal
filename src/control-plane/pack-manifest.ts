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

// The pack manifest is the *authoring* surface of the specialty contract.
//
// Before this module, a pack's identity lived in two places at once — a
// `manifest.yaml` on disk and a frozen `DomainPack` object in TypeScript — and
// nothing compared them. `packs/payer/manifest.yaml` advertised version 0.1.0
// with a four-capability set while `packs/payer/index.ts` shipped 0.2.0 with
// seven capabilities. Both were "the manifest". A second specialty arriving
// through registration alone would have discovered this the expensive way.
//
// So the manifest is parsed here, normalised from the on-disk snake_case into
// the `DomainPack` shape the registry already resolves, and — this is the part
// that makes a declaration worth anything — every artifact it NAMES must
// resolve to a file under `packs/<id>/`. A pack that declares an ontology it
// does not ship is not `partial`; it is wrong, and the loader says so.
//
// Resolution is deliberately filesystem-only: it can run at boot, in a test,
// and in a console request without importing a single pack, so a manifest never
// has to be trusted in order to be checked.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DomainPack } from './pack-registry.js';
import type { SpecialtySections } from './pack-contract.js';

/** The kinds of artifact a specialty section can point at. */
export type PackResourceKind = 'ontology' | 'event-contracts' | 'workflows' | 'measures' | 'ui-lens';

/** A single resolvable artifact named by a manifest. */
export interface PackResourceDeclaration {
  readonly kind: PackResourceKind;
  readonly id: string;
  /** Path relative to `packs/<packId>/`. Must exist when present. */
  readonly module?: string;
  /** Canonical event types this declaration owns. */
  readonly events?: readonly string[];
  /** The `cmsUniverse` entry this measure is bound to, by id. */
  readonly cmsId?: string;
  /** Concept identifiers (ontology) or nav ids (lens) owned by the declaration. */
  readonly names?: readonly string[];
}

/** How the manifest describes its own specialty surface. */
export interface PackManifestSpecialty {
  readonly ontology?: {
    readonly id: string;
    readonly version: string;
    readonly module?: string;
    readonly concepts?: readonly string[];
  };
  readonly eventContracts?: readonly { readonly module?: string; readonly types: readonly string[] }[];
  readonly workflows?: readonly {
    readonly id: string;
    readonly module?: string;
    readonly events?: readonly string[];
    readonly crossPackWith?: readonly string[];
  }[];
  readonly measures?: readonly {
    readonly id: string;
    readonly module?: string;
    readonly cmsId?: string;
  }[];
  readonly uiLens?: {
    readonly id: string;
    readonly label: string;
    readonly nav?: readonly string[];
    readonly views?: readonly {
      readonly id: string;
      readonly label: string;
      /** G5 — the renderer the shell uses, and the route it reads. */
      readonly kind?: string;
      readonly source?: string;
    }[];
    readonly terminology?: Readonly<Record<string, string>>;
  };
}

/** A parsed manifest: the registry shape plus the specialty surface. */
export interface PackManifest {
  readonly id: string;
  readonly version: string;
  readonly extends: readonly { readonly id: string; readonly versionRange: string }[];
  readonly appliesTo: {
    readonly organizationKinds: readonly string[];
    readonly facilityKinds?: readonly string[];
  };
  readonly capabilities: readonly string[];
  readonly cmsUniverse: readonly { readonly id: string; readonly title: string; readonly authority: string }[];
  readonly requiredControls: readonly string[];
  readonly specialty: PackManifestSpecialty;
  /** Repository-relative path of the file this came from. */
  readonly path: string;
}

export type ManifestIssueCode =
  | 'unreadable'
  | 'malformed-yaml'
  | 'missing-id'
  | 'missing-version'
  | 'id-mismatch'
  | 'unresolved-module'
  | 'empty-declaration';

export interface ManifestIssue {
  readonly code: ManifestIssueCode;
  readonly packId: string;
  readonly detail: string;
  /** True when the platform must refuse to treat this manifest as authoritative. */
  readonly blocking: boolean;
}

export interface PackManifestLoadResult {
  readonly manifest: PackManifest | null;
  readonly issues: readonly ManifestIssue[];
}

export interface LoadPackManifestsResult {
  readonly manifests: readonly PackManifest[];
  readonly issues: readonly ManifestIssue[];
}

/* ------------------------------ normalisation ------------------------------ */

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v): v is string => v !== undefined);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normaliseExtends(value: unknown): { id: string; versionRange: string }[] {
  const out: { id: string; versionRange: string }[] = [];
  for (const raw of list(value)) {
    const r = record(raw);
    const id = str(r['id']);
    // `version_range` is the on-disk spelling; `versionRange` is accepted so a
    // manifest authored from the TypeScript shape also parses.
    const versionRange = str(r['version_range']) ?? str(r['versionRange']);
    if (id && versionRange) out.push({ id, versionRange });
  }
  return out;
}

function normaliseCmsUniverse(value: unknown): { id: string; title: string; authority: string }[] {
  const out: { id: string; title: string; authority: string }[] = [];
  for (const raw of list(value)) {
    const r = record(raw);
    const id = str(r['id']);
    const title = str(r['title']);
    const authority = str(r['authority']);
    if (id && title && authority) out.push({ id, title, authority });
  }
  return out;
}

function normaliseSpecialty(value: unknown): PackManifestSpecialty {
  const r = record(value);
  const out: {
    ontology?: PackManifestSpecialty['ontology'];
    eventContracts?: PackManifestSpecialty['eventContracts'];
    workflows?: PackManifestSpecialty['workflows'];
    measures?: PackManifestSpecialty['measures'];
    uiLens?: PackManifestSpecialty['uiLens'];
  } = {};

  const ont = record(r['ontology']);
  const ontologyId = str(ont['id']);
  if (ontologyId) {
    const concepts = strList(ont['concepts']);
    const module = str(ont['module']);
    out.ontology = {
      id: ontologyId,
      version: str(ont['version']) ?? '0.0.0',
      ...(module ? { module } : {}),
      ...(concepts.length ? { concepts } : {}),
    };
  }

  const eventContracts = list(r['event_contracts'] ?? r['eventContracts']).flatMap((raw) => {
    const e = record(raw);
    const types = strList(e['types']);
    if (!types.length) return [];
    const module = str(e['module']);
    return [{ ...(module ? { module } : {}), types }];
  });
  if (eventContracts.length) out.eventContracts = eventContracts;

  const workflows = list(r['workflows']).flatMap((raw) => {
    const w = record(raw);
    const id = str(w['id']);
    if (!id) return [];
    const module = str(w['module']);
    const events = strList(w['events']);
    const crossPackWith = strList(w['cross_pack_with'] ?? w['crossPackWith']);
    return [{
      id,
      ...(module ? { module } : {}),
      ...(events.length ? { events } : {}),
      ...(crossPackWith.length ? { crossPackWith } : {}),
    }];
  });
  if (workflows.length) out.workflows = workflows;

  const measures = list(r['measures']).flatMap((raw) => {
    const m = record(raw);
    const id = str(m['id']);
    if (!id) return [];
    const module = str(m['module']);
    const cmsId = str(m['cms_id'] ?? m['cmsId']);
    return [{ id, ...(module ? { module } : {}), ...(cmsId ? { cmsId } : {}) }];
  });
  if (measures.length) out.measures = measures;

  const lens = record(r['ui_lens'] ?? r['uiLens']);
  const lensId = str(lens['id']);
  const lensLabel = str(lens['label']);
  if (lensId && lensLabel) {
    const nav = strList(lens['nav']);
    const viewsRaw = lens['views'];
    const views = list(viewsRaw).flatMap((raw) => {
      const v = record(raw);
      const id = str(v['id']);
      if (!id) return [];
      const kind = str(v['kind']);
      const source = str(v['source']);
      // `kind` and `source` travel together and are carried only when present, so
      // an id-only view stays exactly what it was — that is the compatibility
      // path, and a parser that invented a kind for it would be guessing which
      // renderer the shell should use.
      return [{
        id,
        label: str(v['label']) ?? id,
        ...(kind ? { kind } : {}),
        ...(source ? { source } : {}),
      }];
    });
    const terminologyRaw = record(lens['terminology']);
    const terminology: Record<string, string> = {};
    for (const [k, v] of Object.entries(terminologyRaw)) {
      const s = str(v);
      if (s) terminology[k] = s;
    }
    out.uiLens = {
      id: lensId,
      label: lensLabel,
      ...(nav.length ? { nav } : {}),
      // PRESENCE, not length. `views: []` says "this lens surfaces no clinical
      // views", which is a different claim from omitting the key ("nothing
      // declared, use the shell's default"). Collapsing the empty list into
      // absence put the renal protocol strip back on a payer console — the exact
      // defect the field exists to fix.
      ...(viewsRaw !== undefined ? { views } : {}),
      ...(Object.keys(terminology).length ? { terminology } : {}),
    };
  }

  return out as PackManifestSpecialty;
}

/* ------------------------------- resolution -------------------------------- */

/** A module path is relative to `packs/<packId>/` and may name a directory. */
function moduleResolves(packDir: string, module: string): boolean {
  const target = join(packDir, module);
  try {
    return existsSync(target) && (statSync(target).isFile() || statSync(target).isDirectory());
  } catch {
    return false;
  }
}

/**
 * Every artifact the manifest names, with the module it lives in. The loader
 * emits one declaration per artifact so the resource registry can check
 * cross-pack invariants without re-parsing YAML.
 */
export function resourceDeclarations(manifest: PackManifest): PackResourceDeclaration[] {
  const out: PackResourceDeclaration[] = [];
  const s = manifest.specialty;

  if (s.ontology) {
    out.push({
      kind: 'ontology',
      id: s.ontology.id,
      ...(s.ontology.module ? { module: s.ontology.module } : {}),
      ...(s.ontology.concepts ? { names: s.ontology.concepts } : {}),
    });
  }

  for (const [i, group] of (s.eventContracts ?? []).entries()) {
    out.push({
      kind: 'event-contracts',
      id: `${manifest.id}:events:${i}`,
      ...(group.module ? { module: group.module } : {}),
      events: group.types,
    });
  }

  for (const w of s.workflows ?? []) {
    out.push({
      kind: 'workflows',
      id: w.id,
      ...(w.module ? { module: w.module } : {}),
      ...(w.events ? { events: w.events } : {}),
      ...(w.crossPackWith ? { names: w.crossPackWith } : {}),
    });
  }

  for (const m of s.measures ?? []) {
    out.push({
      kind: 'measures',
      id: m.id,
      ...(m.module ? { module: m.module } : {}),
      ...(m.cmsId ? { cmsId: m.cmsId } : {}),
    });
  }

  if (s.uiLens) {
    out.push({
      kind: 'ui-lens',
      id: s.uiLens.id,
      ...(s.uiLens.nav ? { names: s.uiLens.nav } : {}),
    });
  }

  return out;
}

/** Canonical event types this manifest claims ownership of. */
export function declaredEventTypes(manifest: PackManifest): string[] {
  const out = new Set<string>();
  for (const group of manifest.specialty.eventContracts ?? []) {
    for (const t of group.types) out.add(t);
  }
  return [...out];
}

/* --------------------------------- parsing --------------------------------- */

function toManifest(packId: string, path: string, raw: Record<string, unknown>): PackManifest {
  const appliesToRaw = record(raw['applies_to'] ?? raw['appliesTo']);
  const facilityKinds = strList(appliesToRaw['facility_kinds'] ?? appliesToRaw['facilityKinds']);
  const id = str(raw['id']) ?? packId;

  return {
    id,
    version: str(raw['version']) ?? '0.0.0',
    extends: normaliseExtends(raw['extends']),
    appliesTo: {
      organizationKinds: strList(appliesToRaw['organization_kinds'] ?? appliesToRaw['organizationKinds']),
      ...(facilityKinds.length ? { facilityKinds } : {}),
    },
    capabilities: strList(raw['capabilities']),
    cmsUniverse: normaliseCmsUniverse(raw['cms_universe'] ?? raw['cmsUniverse']),
    requiredControls: strList(raw['required_controls'] ?? raw['requiredControls']),
    specialty: normaliseSpecialty(raw['specialty'] ?? raw),
    path,
  };
}

/**
 * Parse one manifest file.
 *
 * The directory name is authoritative for identity: a manifest at
 * `packs/payer/manifest.yaml` that calls itself something else is a `fail`, not
 * a rename, because every resolution path in this module is derived from the
 * directory.
 */
export function loadPackManifest(
  repoRoot: string,
  packId: string,
  filePath?: string,
): PackManifestLoadResult {
  const path = filePath ?? join(repoRoot, 'packs', packId, 'manifest.yaml');
  // `relative` rather than slicing the root prefix: a root with a trailing
  // separator silently ate the first character of every path it reported.
  const rel = relative(repoRoot, path) || `packs/${packId}/manifest.yaml`;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { manifest: null, issues: [{ code: 'unreadable', packId, detail: `${rel}: ${(e as Error).message}`, blocking: true }] };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { manifest: null, issues: [{ code: 'malformed-yaml', packId, detail: `${rel}: ${(e as Error).message}`, blocking: true }] };
  }

  const doc = record(raw);
  if (!str(doc['id'])) {
    return { manifest: null, issues: [{ code: 'missing-id', packId, detail: `${rel}: no id`, blocking: true }] };
  }
  if (!str(doc['version'])) {
    return { manifest: null, issues: [{ code: 'missing-version', packId, detail: `${rel}: no version`, blocking: true }] };
  }
  if (str(doc['id']) !== packId) {
    return {
      manifest: null,
      issues: [{
        code: 'id-mismatch',
        packId,
        detail: `${rel}: declares id "${str(doc['id'])}" but lives in packs/${packId}/ — the directory is authoritative`,
        blocking: true,
      }],
    };
  }

  const manifest = toManifest(packId, rel, doc);
  return { manifest, issues: resolveManifestResources(repoRoot, manifest) };
}

/**
 * Check that every module the manifest names exists under `packs/<packId>/`.
 *
 * This is the difference between a declaration and a claim. A manifest that
 * lists an ontology module it does not ship would otherwise report as a
 * conformant pack, and the gap would surface as a runtime `Cannot find module`
 * in a specialty the platform has already agreed to host.
 */
export function resolveManifestResources(repoRoot: string, manifest: PackManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const packDir = join(repoRoot, 'packs', manifest.id);

  for (const decl of resourceDeclarations(manifest)) {
    if (!decl.module) {
      // Only the modules are resolvable; a declaration without one is legal for
      // the lens (which is data the shell renders) and for event contracts
      // (which the substrate may own).
      continue;
    }
    if (!moduleResolves(packDir, decl.module)) {
      issues.push({
        code: 'unresolved-module',
        packId: manifest.id,
        detail: `${decl.kind} "${decl.id}" names module "${decl.module}", which does not exist under packs/${manifest.id}/`,
        blocking: true,
      });
    }
  }

  return issues;
}

/** The `DomainPack` view of a manifest — what the registry resolves. */
export function manifestAsDomainPack(manifest: PackManifest): DomainPack {
  return {
    id: manifest.id,
    version: manifest.version,
    extends: manifest.extends,
    appliesTo: {
      organizationKinds: manifest.appliesTo.organizationKinds,
      ...(manifest.appliesTo.facilityKinds ? { facilityKinds: manifest.appliesTo.facilityKinds } : {}),
    },
    capabilities: manifest.capabilities,
    cmsUniverse: manifest.cmsUniverse,
    requiredControls: manifest.requiredControls,
  };
}

/** The `SpecialtySections` view — what the Phase 0 contract validates. */
export function manifestAsSpecialtySections(manifest: PackManifest): SpecialtySections {
  const s = manifest.specialty;
  const out: {
    ontology?: SpecialtySections['ontology'];
    eventContracts?: readonly string[];
    workflows?: readonly string[];
    measures?: readonly string[];
    uiLens?: SpecialtySections['uiLens'];
  } = {};

  if (s.ontology) {
    out.ontology = {
      id: s.ontology.id,
      version: s.ontology.version,
      ...(s.ontology.concepts ? { conceptCount: s.ontology.concepts.length } : {}),
    };
  }
  const events = declaredEventTypes(manifest);
  if (events.length) out.eventContracts = events;
  if (s.workflows?.length) out.workflows = s.workflows.map((w) => w.id);
  if (s.measures?.length) out.measures = s.measures.map((m) => m.id);
  if (s.uiLens) {
    out.uiLens = {
      id: s.uiLens.id,
      label: s.uiLens.label,
      ...(s.uiLens.nav ? { nav: s.uiLens.nav } : {}),
      ...(s.uiLens.views ? { views: s.uiLens.views } : {}),
      ...(s.uiLens.terminology ? { terminology: s.uiLens.terminology } : {}),
    };
  }
  return out as SpecialtySections;
}

/** One field where the manifest and the TypeScript descriptor disagree. */
export interface ManifestDriftField {
  readonly field: string;
  readonly manifest: string;
  readonly pack: string;
}

/**
 * Compare the two homes of one pack's identity.
 *
 * A pack's identity currently lives in a `manifest.yaml` AND a frozen
 * `DomainPack` object, and until this function existed nothing compared them.
 * `packs/payer` advertised version 0.1.0 with four capabilities in its manifest
 * while shipping 0.2.0 with seven in TypeScript — both were "the manifest", and
 * whichever one a reader happened to open was the truth they got.
 *
 * The RUNTIME uses the TypeScript descriptor, so this reports drift rather than
 * failing the pack: the manifest is not yet authoritative, and pretending
 * otherwise would block a pack that works. What it must not do is stay silent.
 */
export function manifestDrift(pack: DomainPack, manifest: PackManifest): ManifestDriftField[] {
  const out: ManifestDriftField[] = [];
  const cmp = (field: string, a: string, b: string): void => {
    if (a !== b) out.push({ field, manifest: a, pack: b });
  };
  const cmpSet = (field: string, a: readonly string[], b: readonly string[]): void => {
    const left = [...a].sort().join(', ');
    const right = [...b].sort().join(', ');
    if (left !== right) out.push({ field, manifest: left || '(none)', pack: right || '(none)' });
  };

  cmp('version', manifest.version, pack.version);
  cmpSet('capabilities', manifest.capabilities, pack.capabilities);
  cmpSet('requiredControls', manifest.requiredControls, pack.requiredControls);
  cmpSet('appliesTo.organizationKinds', manifest.appliesTo.organizationKinds, pack.appliesTo.organizationKinds);
  cmpSet('cmsUniverse', manifest.cmsUniverse.map((c) => c.id), pack.cmsUniverse.map((c) => c.id));
  cmpSet(
    'extends',
    manifest.extends.map((e) => `${e.id}@${e.versionRange}`),
    pack.extends.map((e) => `${e.id}@${e.versionRange}`),
  );

  return out;
}

/** Every pack directory that ships a manifest, in a stable order. */
export function packIdsWithManifests(repoRoot: string): string[] {
  const packsDir = join(repoRoot, 'packs');
  let entries: string[];
  try {
    entries = readdirSync(packsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      try {
        return statSync(join(packsDir, name)).isDirectory() && existsSync(join(packsDir, name, 'manifest.yaml'));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Load every manifest in the repository. Unreadable ones are reported, not thrown. */
export function loadPackManifests(repoRoot: string): LoadPackManifestsResult {
  const manifests: PackManifest[] = [];
  const issues: ManifestIssue[] = [];
  for (const packId of packIdsWithManifests(repoRoot)) {
    const { manifest, issues: packIssues } = loadPackManifest(repoRoot, packId);
    issues.push(...packIssues);
    if (manifest) manifests.push(manifest);
  }
  return { manifests, issues };
}
