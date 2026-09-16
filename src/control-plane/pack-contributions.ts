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

// A pack contributes BEHAVIOUR, not only metadata.
//
// Until this module, the specialty contract covered data: identity, ontology,
// event contracts, workflows, measures, a lens. All of it declarative, all of it
// checkable, none of it executable. A specialty's *endpoints* were registered by
// name in `src/server/app.ts`, so "a new specialty arrives through registration
// alone" was true of its metadata and false of everything an operator clicks.
//
// The shape is deliberately small — an id, a scope, the prefixes it owns, and a
// `register` — because the hard part is not the interface. It is that a pack
// must not be able to WEAKEN the platform on its way in.
//
// ── Why the prefix list is load-bearing ─────────────────────────────────────
//
// `api-auth.ts` scopes by URL PREFIX: `/admin/swarm/*` → exec roles,
// `/admin/platform/*` → ops roles, and everything else under `/admin/*` → ops.
// A pack free to register any path could therefore register one that the guard
// classifies as a different console's, or a path outside `/admin/` entirely and
// never be guarded at all. That is not a style preference; it is the difference
// between a plugin and a hole.
//
// So a contribution declares its SCOPE, the platform owns the namespace each
// scope may register under, and every declared prefix is asserted against it.
// A pack cannot reach a console the platform did not grant it, and the check is
// code rather than review.
//
// ── What a pack must not hold ───────────────────────────────────────────────
//
// Deps are passed IN (workspace, coordinator) rather than imported by the pack.
// The swarm runtime is rebuilt between registrations, so a pack that captured
// the store singleton at module load would hold a store the platform has since
// replaced — and it would be coupled to the platform's internals rather than its
// contract. Injecting also makes a pack testable against a fake.
// ─────────────────────────────────────────────────────────────────────────────

import type { FastifyInstance } from 'fastify';
import type { DomainPack } from './pack-registry.js';
import type { SwarmWorkspaceStore } from '../swarm/workspace.js';
import type { PersistentOutcomeCoordinator } from '../swarm/durable-coordinator.js';

/** Which console's authority a contribution runs under. */
export type PackRouteScope = 'exec' | 'ops';

/**
 * The URL namespace each scope may register under.
 *
 * These strings must match the prefix tests in `api-auth.ts`, because that is
 * where the role and console decision is actually made. If the guard's
 * classification changes, this table has to change with it — hence the test that
 * asserts each namespace is classified as its intended console.
 */
export const SCOPE_NAMESPACES: Readonly<Record<PackRouteScope, string>> = Object.freeze({
  exec: '/admin/swarm/',
  ops: '/admin/platform/',
});

/**
 * What the platform knows about a patient, as a pack sees it.
 *
 * Deliberately STRUCTURAL and deliberately small: the platform's patient
 * projection is the platform's business, and a pack that depended on its concrete
 * type would be coupled to a shape it does not own. Everything a specialty adds
 * on top (a protocol's features, a twin's window) is derived by the pack from
 * `state`, `medCodes` and `labs`, which is where that derivation belongs.
 *
 * `state` is a mutable record on purpose. The alternative — `Readonly<Record<…>>`
 * — reads stricter but makes this type unassignable to every existing consumer,
 * because a readonly index signature blocks assignability to a mutable one. Packs
 * are trusted code reading a projection that is re-derived on every call, so the
 * mutability is a style signal here, not a boundary. What IS load-bearing is that
 * this shape stays mutually assignable with the platform's own projection, which
 * `tests/pack-contributions.test.ts` pins at compile time.
 */
export interface PackPatient {
  readonly id: string;
  readonly realmId: string;
  readonly state: Record<string, unknown>;
  /** Medication codes seen on the ledger. */
  readonly medCodes?: readonly string[];
  /** Latest lab value per code, with when it was measured. */
  readonly labs?: Readonly<Record<string, { readonly value: number; readonly at: string }>>;
}

/**
 * One thing that happened, as the platform projects it from a realm ledger.
 *
 * This is the canonical shape, and the reason it belongs on the platform
 * side of the boundary is that SEVEN specialty modules were each deriving it
 * themselves from `RealmRegistry` — byte-identical copies of the same loop over
 * every realm's ledger, six of them named `ledgerEvents()`. Each pack declared
 * its own alias for the shape (`InfectionTwinEventInput`, `MbdTwinEventInput`, …)
 * which is why the duplication was invisible: seven names, one type.
 *
 * `payload` and the array are mutable for the same reason `PackPatient.state` is
 * (see below): a readonly index signature is not assignable to a mutable one, so
 * a stricter type here would make this projection unusable by every existing
 * consumer and force a cast at each pack boundary — the exact coupling the
 * projection exists to remove.
 */
export interface ProjectedEvent {
  /** Absent only for events the platform could not attribute to a realm. */
  readonly realmId?: string;
  readonly eventId?: string;
  readonly kind: string;
  readonly emittedAt: string;
  /**
   * Realm-clock timestamp. The clinically meaningful time in an accelerated
   * realm, where wall-clock `emittedAt` collapses months of realm time into
   * minutes — a twin that reads the wall clock sees one week and calls the
   * history insufficient.
   */
  readonly realmAt?: string;
  /** Present when the projection attributed the event to a patient. */
  readonly patientId?: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Types a pack declares for itself and the platform fills in.
 *
 * A separate field rather than an index signature on this interface, so a pack
 * cannot shadow the platform's own guarantees (`workspace`, `coordinator`,
 * `patients`, `events`) by happening to declare a key with the same name.
 */
export type PackRouteExtra = Readonly<Record<string, unknown>>;

/**
 * Read a function-valued entry out of a pack's own dependency bag.
 *
 * The bag is untyped at the platform boundary on purpose — the platform has no
 * business knowing what a specialty declares for itself — so the pack is where
 * the type is reasserted, once, next to the option it feeds. Returning
 * `undefined` for a non-function rather than throwing means a missing fixture is
 * the same case as an absent key: the module's own default applies, which is the
 * only sane reading of "the platform did not override this".
 */
export function extraFn<T>(extra: PackRouteExtra, key: string): (() => T) | undefined {
  const value = extra[key];
  return typeof value === 'function' ? (value as () => T) : undefined;
}

/** What the platform supplies to a pack's route contribution. */
export interface PackRouteDeps {
  /**
   * The durable workspace, resolved LAZILY. A pack must not hold the store
   * across a runtime rebuild, and it must not reach for the platform's
   * singleton — the platform decides what a pack is given.
   */
  readonly workspace: () => SwarmWorkspaceStore;
  readonly coordinator: () => PersistentOutcomeCoordinator;
  /**
   * The patients that exist, projected by the platform.
   *
   * Supplied rather than imported, and this is the load-bearing half of G1 phase
   * 2: a specialty module used to call `renalPatientInputs(RealmRegistry.list())`
   * itself, which meant a pack reached for a platform singleton and the platform
   * could not scope, filter or replace the population it was handing over.
   * `applied` in a specialty binding is enforced HERE, because this is where the
   * platform owns the projection.
   */
  readonly patients: () => readonly PackPatient[];
  /**
   * Everything that happened, as the platform projected it from the realm
   * ledgers. The pack maps this to whatever it reasons over; it does not decide
   * what exists or what occurred.
   */
  readonly events: () => ProjectedEvent[];
  /** The pack's own dependency bag, declared by the pack and filled by the platform. */
  readonly extra: PackRouteExtra;
}

/** One pack's route surface. */
export interface PackRouteContribution {
  /** Stable id, unique across every installed pack. */
  readonly id: string;
  /** The console whose authority these endpoints run under. */
  readonly scope: PackRouteScope;
  /**
   * Every path prefix this contribution registers under. Declared rather than
   * discovered: the platform asserts each one sits inside the scope's namespace,
   * which is what stops a pack registering an unguarded or cross-console path.
   */
  readonly prefixes: readonly string[];
  register(app: FastifyInstance, deps: PackRouteDeps): Promise<void> | void;
}

/** A pack that contributes behaviour. */
export type PackWithContributions = DomainPack & {
  readonly routes?: readonly PackRouteContribution[];
};

export type ContributionIssueCode =
  | 'duplicate-contribution-id'
  | 'duplicate-prefix'
  | 'missing-prefix'
  | 'invalid-prefix'
  | 'prefix-outside-scope-namespace';

export interface ContributionIssue {
  readonly code: ContributionIssueCode;
  readonly packId: string;
  readonly detail: string;
  /** True when the platform must refuse to register this contribution. */
  readonly blocking: boolean;
}

export interface ContributionRegistry {
  readonly contributions: readonly { readonly packId: string; readonly contribution: PackRouteContribution }[];
  readonly issues: readonly ContributionIssue[];
  /** Packs that declared routes, in registration order. */
  readonly contributingPacks: readonly string[];
}

/**
 * Validate every declared contribution before a single route is registered.
 *
 * Ordering is deliberate: identity and prefix collisions first (so the reader's
 * first failure is the one that matters), then the namespace assertion, which is
 * the one with a security consequence.
 */
export function validatePackContributions(packs: readonly PackWithContributions[]): ContributionRegistry {
  const contributions: { packId: string; contribution: PackRouteContribution }[] = [];
  const issues: ContributionIssue[] = [];
  const seenIds = new Map<string, string>();
  const seenPrefixes = new Map<string, string>();

  for (const pack of packs) {
    for (const contribution of pack.routes ?? []) {
      const owner = seenIds.get(contribution.id);
      if (owner) {
        issues.push({
          code: 'duplicate-contribution-id',
          packId: pack.id,
          detail: `contribution id "${contribution.id}" is already declared by pack "${owner}"`,
          blocking: true,
        });
      } else {
        seenIds.set(contribution.id, pack.id);
      }

      if (!contribution.prefixes.length) {
        // A contribution that registers nothing declarable cannot be checked
        // against the guard, so it cannot be proven safe.
        issues.push({
          code: 'missing-prefix',
          packId: pack.id,
          detail: `contribution "${contribution.id}" declares no prefixes — the platform cannot prove its paths are guarded`,
          blocking: true,
        });
      }

      const namespace = SCOPE_NAMESPACES[contribution.scope];
      for (const prefix of contribution.prefixes) {
        if (!prefix.startsWith('/admin/')) {
          issues.push({
            code: 'invalid-prefix',
            packId: pack.id,
            detail: `contribution "${contribution.id}" declares prefix "${prefix}", which is outside /admin/ and would never reach the auth guard`,
            blocking: true,
          });
          continue;
        }

        if (namespace && !prefix.startsWith(namespace)) {
          issues.push({
            code: 'prefix-outside-scope-namespace',
            packId: pack.id,
            detail: `contribution "${contribution.id}" declares scope "${contribution.scope}" but registers "${prefix}" — that scope owns ${namespace}, and the guard decides authority by URL prefix, so this would run under another console's authority`,
            blocking: true,
          });
        }

        const otherOwner = seenPrefixes.get(prefix);
        if (otherOwner) {
          issues.push({
            code: 'duplicate-prefix',
            packId: pack.id,
            detail: `prefix "${prefix}" is already registered by pack "${otherOwner}" — two packs answering one path is an ordering accident, not a feature`,
            blocking: true,
          });
        } else {
          seenPrefixes.set(prefix, pack.id);
        }
      }

      contributions.push({ packId: pack.id, contribution });
    }
  }

  return {
    contributions,
    issues,
    contributingPacks: [...new Set(contributions.map((c) => c.packId))],
  };
}

/** A pack's blocking issues, or an empty list when it may be registered. */
export function blockingContributionIssues(registry: ContributionRegistry): readonly ContributionIssue[] {
  return registry.issues.filter((i) => i.blocking);
}

/**
 * Register every pack-contributed route.
 *
 * Throws on a blocking issue rather than skipping the offending pack. A pack
 * whose declared surface cannot be trusted is a boot-time contract violation: a
 * server that quietly starts without the endpoints a specialty declares is worse
 * than one that does not start, because the console will render the pack's views
 * and the operator will find out from the 404s.
 *
 * Deps are resolved PER CONTRIBUTION rather than passed once. The platform owes
 * different packs different things — every pack needs the patient and event
 * projections, while a few carry a ledger seam that tests inject fixtures
 * through — and a single shared object would have to grow a field per module
 * until it was the union of everything anyone needed.
 *
 * The CONTRIBUTION is passed alongside the pack id because one pack can declare
 * several contributions: the nine dialysis protocol modules all live in
 * `dialysis-provider`, so the pack id alone cannot tell them apart, and keying a
 * per-module dependency on it would hand every module the same fixture.
 */
export async function registerPackRoutes(
  app: FastifyInstance,
  packs: readonly PackWithContributions[],
  depsFor: (packId: string, contribution: PackRouteContribution) => PackRouteDeps,
): Promise<ContributionRegistry> {
  const registry = validatePackContributions(packs);
  const blocking = blockingContributionIssues(registry);
  if (blocking.length > 0) {
    const detail = blocking.map((i) => `${i.packId}: ${i.detail}`).join('; ');
    throw new Error(`pack-route-contribution-invalid: ${detail}`);
  }

  for (const { packId, contribution } of registry.contributions) {
    await contribution.register(app, depsFor(packId, contribution));
  }
  return registry;
}
