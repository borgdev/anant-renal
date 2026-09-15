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

/** What the platform supplies to a pack's route contribution. */
export interface PackRouteDeps {
  /**
   * The durable workspace, resolved LAZILY. A pack must not hold the store
   * across a runtime rebuild, and it must not reach for the platform's
   * singleton — the platform decides what a pack is given.
   */
  readonly workspace: () => SwarmWorkspaceStore;
  readonly coordinator: () => PersistentOutcomeCoordinator;
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
 */
export async function registerPackRoutes(
  app: FastifyInstance,
  packs: readonly PackWithContributions[],
  deps: PackRouteDeps,
): Promise<ContributionRegistry> {
  const registry = validatePackContributions(packs);
  const blocking = blockingContributionIssues(registry);
  if (blocking.length > 0) {
    const detail = blocking.map((i) => `${i.packId}: ${i.detail}`).join('; ');
    throw new Error(`pack-route-contribution-invalid: ${detail}`);
  }

  for (const { contribution } of registry.contributions) {
    await contribution.register(app, deps);
  }
  return registry;
}
