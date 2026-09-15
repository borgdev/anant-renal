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

// What the manifests collectively own — and the invariants that only make sense
// across packs.
//
// One manifest can be read in isolation; the platform's vocabulary cannot. Two
// packs can each be individually conformant while colliding on a concept id, and
// a workflow can subscribe to an event no manifest declares. Neither is visible
// from a per-pack view, and both are exactly the coupling that makes a
// multi-specialty platform expensive to unwind later.
//
// So this module resolves the set once and answers five questions:
//
//   vocabulary   does any concept id come from two packs?            (collision)
//   events       does every subscribed event type have an owner?     (orphan)
//   workflows    do both ends of a cross-pack workflow declare it?   (one-sided)
//   measures     is a CMS-bound measure declared in cmsUniverse?     (unbacked)
//   lens         does a specialty nav id shadow a platform nav id?    (shadow)
//
// The platform nav ids are supplied by the caller rather than imported, because
// they live in the console. A pack must not be able to claim a platform
// navigation slot by declaring one.
// ─────────────────────────────────────────────────────────────────────────────

import type { PackManifest, PackResourceDeclaration, PackResourceKind } from './pack-manifest.js';
import { declaredEventTypes, resourceDeclarations } from './pack-manifest.js';

export type ResourceIssueCode =
  | 'concept-collision'
  | 'concept-collision-with-platform'
  | 'orphan-event'
  | 'shared-event-type'
  | 'one-sided-cross-pack-workflow'
  | 'unknown-cross-pack-target'
  | 'unbacked-cms-measure'
  | 'lens-shadows-platform-nav'
  | 'unknown-lens-view'
  | 'duplicate-artifact-id';

export interface ResourceIssue {
  readonly code: ResourceIssueCode;
  /** The pack the issue is REPORTED against — the one that must change. */
  readonly packId: string;
  readonly detail: string;
  readonly blocking: boolean;
}

/** One resolved artifact, with the pack that declared it. */
export interface ResolvedResource extends PackResourceDeclaration {
  readonly packId: string;
}

export interface PackResourceReport {
  readonly packId: string;
  readonly ontology: { readonly id: string; readonly version: string; readonly concepts: readonly string[] } | null;
  readonly eventTypes: readonly string[];
  readonly workflows: readonly string[];
  readonly measures: readonly string[];
  readonly lens: {
    readonly id: string;
    readonly label: string;
    readonly nav: readonly string[];
    /** Platform views this lens surfaces, in display order. */
    readonly views: readonly { readonly id: string; readonly label: string }[];
  } | null;  readonly issues: readonly ResourceIssue[];
  /** No blocking issue → the pack's declared surface is real. */
  readonly resolved: boolean;
}

export interface ResourceRegistry {
  readonly resources: readonly ResolvedResource[];
  readonly byPack: readonly PackResourceReport[];
  readonly issues: readonly ResourceIssue[];
  /** Every canonical event type with the pack that owns it. */
  readonly eventOwners: Readonly<Record<string, string>>;
  readonly resolvedPacks: number;
  readonly blockedPacks: readonly string[];
}

export interface ResourceRegistryInput {
  readonly manifests: readonly PackManifest[];
  /**
   * Nav ids the platform itself renders. A specialty may ADD navigation; it may
   * not take a platform slot, or a pack could silently replace platform
   * navigation with its own.
   */
  readonly platformNavIds?: readonly string[];
  /** Concepts the platform owns and no pack may redefine. */
  readonly platformConcepts?: readonly string[];
  /**
   * Views the shell can render. A lens may surface only these; a view id outside
   * the set is a declaration the console cannot draw, and an empty tab is a
   * worse answer than a refusal.
   */
  readonly renderableViews?: readonly string[];
}

function emptyReport(packId: string): PackResourceReport {
  return {
    packId,
    ontology: null,
    eventTypes: [],
    workflows: [],
    measures: [],
    lens: null,
    issues: [],
    resolved: true,
  };
}

/** Resolve every manifest into one registry, with the cross-pack invariants applied. */
export function buildResourceRegistry(input: ResourceRegistryInput): ResourceRegistry {
  const platformNav = new Set(input.platformNavIds ?? []);
  const platformConcepts = new Set(input.platformConcepts ?? []);

  const resources: ResolvedResource[] = [];
  const reports = new Map<string, PackResourceReport>();
  const issues: ResourceIssue[] = [];
  const eventOwners: Record<string, string> = {};

  const add = (issue: ResourceIssue): void => {
    issues.push(issue);
    const report = reports.get(issue.packId);
    if (!report) return;
    reports.set(issue.packId, {
      ...report,
      issues: [...report.issues, issue],
      // Only a BLOCKING issue means the declared surface did not resolve. A
      // shared event type is informational — it is the substrate's vocabulary,
      // and two specialties reacting to one fact is the point.
      resolved: report.resolved && !issue.blocking,
    });
  };

  // ---- pre-pass: who declares which cross-pack workflow, with whom. This has
  // to be known BEFORE the collision check, because a cross-pack workflow is by
  // definition one id declared by two packs — reporting that as a collision
  // would fail the one shape the platform is trying to support.
  const workflowPartners = new Map<string, Map<string, Set<string>>>();
  for (const m of input.manifests) {
    for (const w of m.specialty.workflows ?? []) {
      const byPack = workflowPartners.get(w.id) ?? new Map<string, Set<string>>();
      byPack.set(m.id, new Set(w.crossPackWith ?? []));
      workflowPartners.set(w.id, byPack);
    }
  }
  const isMutualCrossPack = (workflowId: string, a: string, b: string): boolean => {
    const byPack = workflowPartners.get(workflowId);
    return Boolean(byPack?.get(a)?.has(b) && byPack.get(b)?.has(a));
  };

  // ---- pass 1: flatten. Also catches an artifact id declared twice by the
  // same pack, which would make "who owns this" unanswerable.
  const seenArtifactIds = new Map<string, string>();
  for (const m of input.manifests) {
    reports.set(m.id, emptyReport(m.id));
    const s = m.specialty;

    if (s.ontology) {
      reports.set(m.id, {
        ...reports.get(m.id)!,
        ontology: { id: s.ontology.id, version: s.ontology.version, concepts: s.ontology.concepts ?? [] },
      });
    }
    const events = declaredEventTypes(m);
    if (events.length) reports.set(m.id, { ...reports.get(m.id)!, eventTypes: events });
    if (s.workflows?.length) reports.set(m.id, { ...reports.get(m.id)!, workflows: s.workflows.map((w) => w.id) });
    if (s.measures?.length) reports.set(m.id, { ...reports.get(m.id)!, measures: s.measures.map((x) => x.id) });
    if (s.uiLens) {
      reports.set(m.id, {
        ...reports.get(m.id)!,
        lens: {
          id: s.uiLens.id,
          label: s.uiLens.label,
          nav: s.uiLens.nav ?? [],
          views: s.uiLens.views ?? [],
        },
      });
    }

    for (const decl of resourceDeclarations(m)) {
      const key = `${decl.kind}:${decl.id}`;
      const owner = seenArtifactIds.get(key);
      if (owner === m.id) {
        add({
          code: 'duplicate-artifact-id',
          packId: m.id,
          detail: `${decl.kind} "${decl.id}" is declared twice by this pack — "who owns this" would have two answers`,
          blocking: true,
        });
      } else if (owner && !decl.kind.startsWith('event')) {
        // Two packs owning one ontology/workflow/measure id is a collision —
        // EXCEPT a workflow the two packs mutually declare as cross-pack, which
        // is the supported shape and is checked in pass 4 instead.
        const mutual = decl.kind === 'workflows' && isMutualCrossPack(decl.id, owner, m.id);
        if (!mutual) {
          add({
            code: 'duplicate-artifact-id',
            packId: m.id,
            detail: `${decl.kind} "${decl.id}" is already declared by pack "${owner}"`,
            blocking: true,
          });
        }
      }
      seenArtifactIds.set(key, m.id);
      resources.push({ ...decl, packId: m.id });
    }
  }

  // ---- pass 2: vocabulary collisions across packs.
  const conceptOwner = new Map<string, string>();
  for (const m of input.manifests) {
    for (const concept of m.specialty.ontology?.concepts ?? []) {
      if (platformConcepts.has(concept)) {
        add({
          code: 'concept-collision-with-platform',
          packId: m.id,
          detail: `concept "${concept}" is platform vocabulary and may not be redefined by a specialty`,
          blocking: true,
        });
        continue;
      }
      const owner = conceptOwner.get(concept);
      if (owner && owner !== m.id) {
        add({
          code: 'concept-collision',
          packId: m.id,
          detail: `concept "${concept}" is also declared by pack "${owner}" — the platform would have two meanings for one id`,
          blocking: true,
        });
      }
      conceptOwner.set(concept, m.id);
    }
  }

  // ---- pass 3: every subscribed event must have an owner.
  for (const m of input.manifests) {
    for (const type of declaredEventTypes(m)) {
      const owner = eventOwners[type];
      if (!owner) {
        eventOwners[type] = m.id;
      } else if (owner !== m.id) {
        // Sharing a canonical event type is legitimate — it is the substrate's
        // vocabulary, and two specialties reacting to one fact is the point. The
        // first owner is recorded and the second is noted, not failed.
        add({
          code: 'shared-event-type',
          packId: m.id,
          detail: `event type "${type}" is also declared by pack "${owner}" — shared canonical vocabulary is allowed, but both packs owe a compatible shape`,
          blocking: false,
        });
      }
    }

    const declared = new Set(declaredEventTypes(m));
    for (const w of m.specialty.workflows ?? []) {
      for (const type of w.events ?? []) {
        if (declared.has(type)) continue;
        add({
          code: 'orphan-event',
          packId: m.id,
          detail: `workflow "${w.id}" subscribes to "${type}", which this pack does not declare in event_contracts — nothing guarantees that event exists or has this shape`,
          blocking: true,
        });
      }
    }
  }

  // ---- pass 4: a cross-pack workflow must be declared by both ends.
  const workflowOwners = new Map<string, Set<string>>();
  for (const m of input.manifests) {
    for (const w of m.specialty.workflows ?? []) {
      const owners = workflowOwners.get(w.id) ?? new Set<string>();
      owners.add(m.id);
      workflowOwners.set(w.id, owners);
    }
  }
  const manifestIds = new Set(input.manifests.map((m) => m.id));
  for (const m of input.manifests) {
    for (const w of m.specialty.workflows ?? []) {
      for (const other of w.crossPackWith ?? []) {
        if (!manifestIds.has(other)) {
          add({
            code: 'unknown-cross-pack-target',
            packId: m.id,
            detail: `workflow "${w.id}" names cross-pack partner "${other}", which is not an installed pack`,
            blocking: true,
          });
          continue;
        }
        const owners = workflowOwners.get(w.id) ?? new Set<string>();
        if (!owners.has(other)) {
          add({
            code: 'one-sided-cross-pack-workflow',
            packId: other,
            detail: `pack "${m.id}" declares workflow "${w.id}" as cross-pack with this pack, but this pack does not declare it — one side believes it is connected and the other has never heard of it`,
            blocking: true,
          });
        }
      }
    }
  }

  // ---- pass 5: a CMS-bound measure must be backed by a declared authority.
  for (const m of input.manifests) {
    const declaredCms = new Set(m.cmsUniverse.map((c) => c.id));
    for (const measure of m.specialty.measures ?? []) {
      if (!measure.cmsId) continue;
      if (!declaredCms.has(measure.cmsId)) {
        add({
          code: 'unbacked-cms-measure',
          packId: m.id,
          detail: `measure "${measure.id}" claims CMS authority "${measure.cmsId}", which is not in this pack's cms_universe — a quality claim without a declared authority is the one that ends up in a submission`,
          blocking: true,
        });
      }
    }
  }

  // ---- pass 6: a specialty lens may add navigation, never shadow it.
  for (const m of input.manifests) {
    for (const navId of m.specialty.uiLens?.nav ?? []) {
      if (platformNav.has(navId)) {
        add({
          code: 'lens-shadows-platform-nav',
          packId: m.id,
          detail: `lens nav id "${navId}" is platform navigation — a specialty lens renders inside the shared shell and may not take a platform slot`,
          blocking: true,
        });
      }
    }
  }

  // ---- pass 7: a lens may only surface a view the shell can draw. Without this
  // a specialty could declare a view no component renders, and the console would
  // show an empty tab — which reads as a broken product rather than a bad
  // declaration.
  const renderable = new Set(input.renderableViews ?? []);
  if (input.renderableViews) {
    for (const m of input.manifests) {
      for (const view of m.specialty.uiLens?.views ?? []) {
        if (renderable.has(view.id)) continue;
        add({
          code: 'unknown-lens-view',
          packId: m.id,
          detail: `lens "${m.specialty.uiLens?.id}" surfaces view "${view.id}", which the shell has no component for — a declared view must be renderable`,
          blocking: true,
        });
      }
    }
  }

  const byPack = input.manifests
    .map((m) => reports.get(m.id) ?? emptyReport(m.id))
    .map((r) => ({ ...r, issues: [...r.issues].sort((a, b) => a.code.localeCompare(b.code)) }))
    .sort((a, b) => a.packId.localeCompare(b.packId));

  return {
    resources,
    byPack,
    issues,
    eventOwners,
    resolvedPacks: byPack.filter((r) => r.resolved).length,
    blockedPacks: byPack.filter((r) => !r.resolved).map((r) => r.packId),
  };
}

/** The report for one pack, or `null` when nothing is declared under that id. */
export function resourceReportFor(registry: ResourceRegistry, packId: string): PackResourceReport | null {
  return registry.byPack.find((r) => r.packId === packId) ?? null;
}

/** Does a pack own the right to emit this canonical event type? */
export function packOwnsEvent(registry: ResourceRegistry, packId: string, eventType: string): boolean {
  return registry.eventOwners[eventType] === packId;
}

/**
 * Group the resolved artifacts by kind — what a console needs to render "this
 * pack contributes an ontology with N concepts, 3 workflows, 4 measures".
 */
export function resourcesByKind(registry: ResourceRegistry): Record<PackResourceKind, readonly ResolvedResource[]> {
  const out: Record<PackResourceKind, ResolvedResource[]> = {
    ontology: [],
    'event-contracts': [],
    workflows: [],
    measures: [],
    'ui-lens': [],
  };
  for (const r of registry.resources) out[r.kind].push(r);
  return out;
}
