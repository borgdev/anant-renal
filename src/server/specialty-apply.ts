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

// G6's `applied` flag, ENFORCED at the seam where the platform hands patients to
// a pack.
//
// `applied` was reported and scoped but not enforced. That is not merely
// incomplete — it is the dangerous direction, because a specialty that is
// installed but not applied still COMPUTES. Its recommendations reach the work
// queue and its twin runs over real patients, with no console surface on which
// anyone could notice. `silent-mode.ts` set the precedent that computing and
// surfacing are different claims; a display-only switch is exactly the mistake
// that precedent exists to prevent, and this is the computing half.
//
// Enforcing it needs two facts to meet SYNCHRONOUSLY inside `patients()`:
//
//   * WHO IS ASKING. Every specialty module calls `deps.patients()` with no
//     arguments, and requiring eleven modules to thread a viewer through would
//     be the platform asking a pack to know something the platform already
//     knows. So the viewer travels out-of-band, in an AsyncLocalStorage scope
//     established once per request.
//   * WHAT THE CONFIGURATION SAYS. A durable read, which cannot happen inside a
//     synchronous projection. So the binding set is SNAPSHOTTED: primed on the
//     first request that needs it and re-primed whenever a binding is written.
//
// An EMPTY snapshot means "not configured" and resolves every pack as applied —
// which is the behaviour that shipped before bindings existed, so arming this
// changes nothing until an operator writes a binding. Same reasoning as
// `no-binding` in the resolver, for the same reason: a configuration feature
// that defaults to off is the only kind an operator will try.
//
// The gate answers "is this pack applied AT ALL for this caller". It does not
// narrow the population to the applied scopes — see `appliedScopes` below.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveSpecialtyBindings, type SpecialtyBindingLike } from '../control-plane/specialty-bindings.js';
import { readCookieValue, SESSION_COOKIE, type SessionManager } from './auth/session.js';
import type { LocalUserStore } from './auth/users.js';

interface ViewerScope {
  readonly scopeIds: readonly string[];
}

const viewerScope = new AsyncLocalStorage<ViewerScope>();

let snapshot: readonly SpecialtyBindingLike[] = [];
let primed = false;

/**
 * Run `fn` with these viewer scopes in context.
 *
 * Exported for tests, which have no Fastify pipeline to establish it through —
 * and a test that had to construct one to check the gate would be testing
 * Fastify rather than the gate.
 */
export function runWithViewerScope<T>(scopeIds: readonly string[], fn: () => T): T {
  return viewerScope.run({ scopeIds }, fn);
}

/** Replace the snapshot. Called on boot, after a binding write, and by tests. */
export function setSpecialtyBindingSnapshot(bindings: readonly SpecialtyBindingLike[]): void {
  snapshot = [...bindings];
  primed = true;
}

export function specialtyBindingSnapshot(): readonly SpecialtyBindingLike[] {
  return snapshot;
}

export interface ApplyDecision {
  /** Does this pack evaluate this population for this caller? */
  readonly applied: boolean;
  /** The scopes it is applied at. `scope:*` means everywhere. */
  readonly appliedScopes: readonly string[];
  /** Why — `no-binding`, `binding`, `any-grant`, `not-installed`. Reported, never guessed. */
  readonly reason: string;
  /**
   * False when no viewer was in scope (a boot-time or out-of-band call).
   *
   * Kept as a separate field rather than folded into `applied`, because
   * "nobody asked" and "asked and the answer is yes" are different facts and a
   * caller that conflated them would report an unenforced gate as a permitted one.
   */
  readonly viewerKnown: boolean;
}

/**
 * Is `packId` applied for the caller in scope?
 *
 * Deliberately narrows the question to `applied`. `show` is the console's
 * business and `entitled` has no licensing source to read yet; a gate that
 * answered all three would be a gate nobody could reason about, and the one
 * with a clinical consequence is this one.
 */
export function applyDecisionFor(packId: string): ApplyDecision {
  const viewer = viewerScope.getStore();
  const [resolved] = resolveSpecialtyBindings({
    bindings: snapshot,
    installedPackIds: [packId],
    viewerScopeIds: viewer?.scopeIds ?? [],
  });
  if (!resolved) {
    // A pack the platform was not asked about. Applied, because nothing said
    // otherwise — the same default as a pack with no binding.
    return { applied: true, appliedScopes: ['scope:*'], reason: 'not-installed', viewerKnown: Boolean(viewer) };
  }
  return {
    applied: resolved.applied,
    appliedScopes: resolved.appliedScopes,
    reason: resolved.reason,
    viewerKnown: Boolean(viewer),
  };
}

/** The projection a pack should see, given its own apply decision. */
export function appliedPatients<T>(packId: string, patients: readonly T[]): readonly T[] {
  return applyDecisionFor(packId).applied ? patients : [];
}

/* ---------- wiring ---------- */

export interface SpecialtyApplyGateDeps {
  users: LocalUserStore;
  sessions: SessionManager;
  /** Read the durable bindings. Called at most once per process, lazily. */
  bindings: () => Promise<readonly SpecialtyBindingLike[]>;
}

function viewerFrom(req: FastifyRequest, deps: SpecialtyApplyGateDeps): ViewerScope | undefined {
  const raw = req.headers.cookie;
  const token = readCookieValue(Array.isArray(raw) ? raw[0] : raw, SESSION_COOKIE);
  if (!token) return undefined;
  const session = deps.sessions.get(token);
  if (!session) return undefined;
  const user = deps.users.get(session.username);
  if (!user) return undefined;
  return { scopeIds: user.scopeIds };
}

/**
 * Establish the viewer scope per request, and prime the binding snapshot once.
 *
 * The scope hook is a SYNCHRONOUS `onRequest` hook on purpose, and the reason is
 * worth writing down: `viewerScope.run(..., () => done())` makes the REST of the
 * pipeline — including the route handler — run inside the scope, because the
 * continuation is invoked from within it. An async hook cannot do this. An async
 * function body gets its own async context, so `enterWith()` there would set the
 * store for the hook and not for the handler, and the gate would silently
 * resolve every pack as "no viewer" — a gate that reports success and enforces
 * nothing, which is worse than no gate.
 *
 * `done()` is passed as the continuation rather than called first for the same
 * reason.
 */
export async function registerSpecialtyApplyGate(
  app: FastifyInstance,
  deps: SpecialtyApplyGateDeps,
): Promise<void> {
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    const viewer = viewerFrom(req, deps);
    if (!viewer) {
      done();
      return;
    }
    runWithViewerScope(viewer.scopeIds, () => done());
  });

  // Primed lazily rather than at boot: `registerSpecialtyApplyGate` runs during
  // registration, when the workspace may not exist yet, and a boot-time read that
  // silently failed would leave the gate UNARMED while reporting success. A
  // failed prime leaves `primed` false so the next request tries again.
  app.addHook('preHandler', async () => {
    if (primed) return;
    try {
      setSpecialtyBindingSnapshot(await deps.bindings());
    } catch {
      // The gate stays unarmed, which means every pack is applied — the
      // pre-binding behaviour, not a silently narrowed population.
    }
  });
}
