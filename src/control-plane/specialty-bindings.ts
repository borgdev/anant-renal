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

// ─────────────────────────────────────────────────────────────────────────────
// Specialty bindings — where a specialty APPLIES and where it is SHOWN.
//
// Before this module there was exactly one switch: `PackActivation`, a
// single-document `{ packId, by }`. Installing a pack and using a pack were the
// same fact, and "active" carried three unrelated meanings at once — which packs
// compute, which lens the console renders, and (implicitly) which specialty the
// customer bought.
//
// That is the shape that cannot serve "one artifact, N configurations". It also
// hides a clinical hazard: a specialty that is *shown* but not *applied* shows a
// lens with nothing in it, and a specialty that is *applied* but not *shown*
// computes against real patients with no surface on which anyone could notice.
// The second is the dangerous one, so the three questions are answered
// separately and named:
//
//   applied   — does this pack evaluate this population, at this scope?
//   show      — does the console render this lens?
//   entitled  — is this customer licensed for it?
//
// The precedent is already in the codebase. `src/evidence/silent-mode.ts`
// separates COMPUTING from SURFACING: silent suppresses surfacing only, leaving
// silent requires a stated reason, and `assertSilentStillComputes` is the
// invariant probe for it. **Hidden is not the same as not running**, and a model
// that could not say which one it meant would be that defect with a configuration
// file in front of it.
//
// ── The scope vocabulary is the actor's, not a new one ───────────────────────
//
// A binding's `scope` is an element of the same vocabulary `ActorContext.scopeIds`
// already uses, with `scope:*` as the wildcard. That is the check
// `api-routes.ts` and `scoped-persistence.ensureScope` already perform:
//
//     actor.scopeIds.includes(scopeId) || actor.scopeIds.includes('scope:*')
//
// Inventing a second, richer scope language here (region ⊃ facility ⊃ realm)
// would mean two answers to "may this actor see this", and the one that is wrong
// would be the one nobody re-read. So: exact membership, plus the wildcard, plus
// specificity so a scoped rule can override the global one.
//
// Consequence worth stating plainly: **a facility- or region-level binding only
// resolves for actors whose `scopeIds` actually carry that scope id.** Today
// `LocalUserStore` defaults to `['scope:*']` and realm ids are what the platform
// hands out, so a deployment that wants per-facility specialty configuration has
// to provision those scope ids first. That is a prerequisite, not a detail, and
// it is recorded in docs/platform-specialty-remaining-work.md rather than
// papered over by matching against the operating-model hierarchy here.
//
// ── Why this module stays pure ───────────────────────────────────────────────
//
// No I/O, no store, no import of the swarm runtime — so it runs at boot, in a
// route, in a console request, and in a test with a literal array. The durable
// document type lives with every other workspace kind; this module takes the
// structural subset it needs (`SpecialtyBindingLike`), which is the same reason
// `pack-manifest.ts` resolves against the filesystem rather than a pack.
// ─────────────────────────────────────────────────────────────────────────────

/** The wildcard. Any actor holding it matches every binding. */
export const SCOPE_WILDCARD = 'scope:*';

/**
 * Separator between scope and pack id in a binding's derived id.
 *
 * Chosen because neither part can contain it: a scope is a scope id (`scope:*`,
 * a realm id — which contains COLONS, so a colon is not usable as the
 * separator) and a pack id is a dotted slug. A derived id makes "one binding per
 * (scope, pack)" structural rather than something a validator has to catch.
 */
export const SPECIALTY_BINDING_SEP = '::';

/** Whether a string is usable as a binding scope. */
export function isUsableBindingScope(scope: string): boolean {
  const trimmed = scope.trim();
  if (!trimmed) return false;
  if (trimmed.includes(SPECIALTY_BINDING_SEP)) return false;
  if (/\s/.test(trimmed)) return false;
  return true;
}

/** The one builder for a binding's id. `parseSpecialtyBindingId` lives beside it
 *  so the two spellings can never drift apart. */
export function specialtyBindingId(scope: string, packId: string): string {
  return `${scope.trim()}${SPECIALTY_BINDING_SEP}${packId.trim()}`;
}

export function parseSpecialtyBindingId(id: string): { scope: string; packId: string } | undefined {
  const at = id.indexOf(SPECIALTY_BINDING_SEP);
  if (at <= 0) return undefined;
  const scope = id.slice(0, at);
  const packId = id.slice(at + SPECIALTY_BINDING_SEP.length);
  if (!scope || !packId) return undefined;
  return { scope, packId };
}

/**
 * The structural subset of a durable binding that resolution needs.
 *
 * Deliberately not the workspace document type: a caller holding a literal
 * object, a row read from the store, or a fixture in a test all satisfy this.
 */
export interface SpecialtyBindingLike {
  readonly id: string;
  readonly scope: string;
  readonly packId: string;
  /** Does this pack evaluate this population? */
  readonly applied: boolean;
  /** Does the console render this lens? */
  readonly show: boolean;
  /** Is this customer licensed for it? */
  readonly entitled: boolean;
  /** Which lens leads when several are shown. A DISPLAY decision — it never
   *  decides what exists, only which group is first and whose terminology
   *  applies. */
  readonly primary?: boolean;
}

/** One binding's contribution to one pack's resolved flags. */
export interface BindingDecision {
  readonly bindingId: string;
  readonly scope: string;
  /** 1 = an explicit scope, 0 = the wildcard. Higher wins. */
  readonly specificity: number;
  readonly applied: boolean;
  readonly show: boolean;
  readonly entitled: boolean;
  readonly primary: boolean;
}

/** Why a flag ended up as it did — so the console can explain, not just display. */
export type ResolutionReason =
  /** An explicit binding matched the viewer. */
  | 'binding'
  /** No binding mentions this pack; the platform's install-or-not behaviour applies. */
  | 'no-binding'
  /** Several bindings matched at equal specificity and granted the flag. */
  | 'any-grant'
  /** Several bindings claimed primary; the lowest pack id was taken. */
  | 'ambiguous-primary';

export interface ResolvedSpecialty {
  readonly packId: string;
  /** True when any matched binding applies this pack for the viewer. */
  readonly applied: boolean;
  /**
   * The scopes where this pack evaluates. `scope:*` means everywhere. This is
   * the field enforcement reads: the platform owns the patient projection, so it
   * filters by these scopes when it hands patients to a pack.
   */
  readonly appliedScopes: readonly string[];
  readonly show: boolean;
  readonly entitled: boolean;
  readonly primary: boolean;
  readonly reason: ResolutionReason;
  /** Every binding that contributed, in specificity order. Empty ⇒ `no-binding`. */
  readonly decisions: readonly BindingDecision[];
}

export interface SpecialtyResolutionInput {
  readonly bindings: readonly SpecialtyBindingLike[];
  /** Every installed pack id, in the deployment's declared order. */
  readonly installedPackIds: readonly string[];
  /** The viewer's scopes, as `ActorContext.scopeIds` carries them. */
  readonly viewerScopeIds: readonly string[];
  /**
   * The legacy single-document activation (`pack-activation`), consulted ONLY for
   * packs no binding mentions.
   *
   * Absence of a binding means "not configured", never "not shown". Read the
   * other way round, adding one binding for one pack would silently dark every
   * other specialty in the deployment, which is the kind of change an operator
   * makes once and never trusts again. Bindings are OVERRIDES; the fallback
   * reproduces exactly the behaviour that shipped before them, so introducing
   * the model changes nothing until someone writes a binding.
   */
  readonly legacyActivePackId?: string | undefined;
}

/** Specificity of a binding's scope for a viewer: an explicit scope beats the
 *  wildcard, which is what makes "global default + scoped override" work. */
function scopeSpecificity(scope: string, viewerScopeIds: readonly string[]): number {
  if (scope === SCOPE_WILDCARD) return 0;
  return viewerScopeIds.includes(scope) ? 1 : 0;
}

/**
 * Does this binding apply to a viewer holding these scopes?
 *
 * `scope:*` means two different things on the two sides, and conflating them
 * makes a global default apply to nobody:
 *
 *   as a BINDING's scope  — "this rule is for everyone", so it matches any viewer
 *   as a VIEWER's scope   — "this actor is unscoped", so it matches any binding
 *
 * Both are required. The first draft implemented only the second, which meant a
 * wildcard binding resolved exclusively for super-admins and every ordinary
 * operator saw the fallback — the model would have looked correct in a test
 * written from the super-admin seat and been wrong for everyone else.
 */
export function bindingMatchesViewer(binding: SpecialtyBindingLike, viewerScopeIds: readonly string[]): boolean {
  if (binding.scope === SCOPE_WILDCARD) return true;
  if (viewerScopeIds.includes(SCOPE_WILDCARD)) return true;
  return viewerScopeIds.includes(binding.scope);
}

/**
 * Resolve the installed packs for one viewer.
 *
 * Deterministic by construction: each pack's bindings are sorted by specificity
 * then by id, so the same inputs always produce the same output — a store that
 * returns rows in a different order cannot change which lens a console opens on.
 */
export function resolveSpecialtyBindings(input: SpecialtyResolutionInput): ResolvedSpecialty[] {
  const viewer = input.viewerScopeIds;
  const byPack = new Map<string, SpecialtyBindingLike[]>();

  for (const binding of input.bindings) {
    if (!bindingMatchesViewer(binding, viewer)) continue;
    const list = byPack.get(binding.packId);
    if (list) list.push(binding);
    else byPack.set(binding.packId, [binding]);
  }

  const resolved: ResolvedSpecialty[] = input.installedPackIds.map((packId) => {
    const matched = byPack.get(packId);

    if (!matched || matched.length === 0) {
      // Not configured. Reproduce the behaviour that shipped before this model —
      // installed means applied and shown, and the activated pack leads — so
      // introducing bindings changes nothing until someone writes one.
      return {
        packId,
        applied: true,
        appliedScopes: [SCOPE_WILDCARD],
        show: true,
        entitled: true,
        primary: input.legacyActivePackId === packId,
        reason: 'no-binding' as const,
        decisions: [],
      };
    }

    const decisions: BindingDecision[] = matched
      .map((binding): BindingDecision => ({
        bindingId: binding.id,
        scope: binding.scope,
        specificity: scopeSpecificity(binding.scope, viewer),
        applied: binding.applied,
        show: binding.show,
        entitled: binding.entitled,
        primary: binding.primary === true,
      }))
      .sort((a, b) => b.specificity - a.specificity || a.bindingId.localeCompare(b.bindingId));

    // Only the winning specificity band decides. A scoped rule is an OVERRIDE of
    // the global one, not another vote beside it — otherwise "global on, this
    // facility off" would depend on how many facilities the viewer holds.
    const band = decisions.filter((d) => d.specificity === decisions[0]!.specificity);
    const primaryClaims = band.filter((d) => d.primary);

    return {
      packId,
      applied: band.some((d) => d.applied),
      // Only APPLIED bindings contribute a scope, and only from the winning band:
      // a global `applied` overridden at a realm must not widen the set back out.
      appliedScopes: Array.from(new Set(band.filter((d) => d.applied).map((d) => d.scope))).sort(),
      show: band.some((d) => d.show),
      entitled: band.some((d) => d.entitled),
      // `band` is already sorted by id, so when two bindings claim primary at the
      // same specificity exactly one wins and it is the lowest id — never the
      // store's row order. The tie is reported rather than hidden.
      primary: primaryClaims.length > 0,
      reason: primaryClaims.length > 1 ? 'ambiguous-primary' : band.length > 1 ? 'any-grant' : 'binding',
      decisions: band,
    };
  });

  // A hidden specialty can never lead. `primary` is a display decision, and
  // "display nothing" is not a way to lead.
  let settled = resolved.map((r) => (r.primary && !r.show ? { ...r, primary: false } : r));

  // Exactly one lens leads. Several packs may legitimately claim primary — a
  // renal binding and a payer contract at the same scope both want to be first —
  // so the tie is broken on the lowest binding id (never on the store's row
  // order), and the fact that it WAS broken is reported rather than hidden.
  const claimants = settled.filter((r) => r.primary);
  if (claimants.length > 1) {
    const claimKey = (r: ResolvedSpecialty): string =>
      r.decisions.find((d) => d.primary)?.bindingId ?? `~${r.packId}`;
    const winner = [...claimants].sort((a, b) => claimKey(a).localeCompare(claimKey(b)))[0]!.packId;
    settled = settled.map((r) => {
      if (!r.primary) return r;
      return r.packId === winner ? { ...r, reason: 'ambiguous-primary' } : { ...r, primary: false };
    });
  }

  // Nobody claimed it. Promote ONLY when there is nothing to choose between: one
  // shown pack is unambiguously the leader, and electing it spares every caller
  // from special-casing a set of one.
  //
  // With several shown this deliberately does NOT elect one. "First in installed
  // order" reads like a harmless default and is not: the installed list begins
  // with the SUBSTRATE pack, which is not a specialty at all, so that rule hands
  // the console to `healthcare-core` — a pack with no lens of its own — exactly
  // when the deployment has expressed no preference. A caller with a better answer
  // (the organization's operating model, say) has to be free to give it, so the
  // absence of a leader is reported rather than filled in.
  if (!settled.some((r) => r.primary)) {
    const shown = settled.filter((r) => r.show);
    if (shown.length === 1) {
      const only = shown[0]!;
      settled[settled.indexOf(only)] = { ...only, primary: true };
    }
  }

  return settled;
}

/** Convenience: the packs a viewer should see a lens for, primary first. */
export function shownSpecialties(resolved: readonly ResolvedSpecialty[]): ResolvedSpecialty[] {
  return resolved
    .filter((r) => r.show)
    .slice()
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration health
 *
 * Kept as WARNINGS rather than refusals, except for the two that make a binding
 * meaningless. A configuration surface that rejects anything arguable teaches an
 * operator to work around it; one that accepts a binding naming a pack that is
 * not installed teaches them that the console lies.
 * ──────────────────────────────────────────────────────────────────────────── */

export type BindingIssueCode =
  /** The pack is not installed, so this binding can never take effect. */
  | 'pack-not-installed'
  /** Two bindings for the same pack at the same scope. */
  | 'duplicate-scope-and-pack'
  /** `show` without `applied` renders a lens with nothing behind it. */
  | 'show-without-applied'
  /** `applied` without `entitled` runs a specialty the customer is not licensed for. */
  | 'applied-without-entitled'
  /** The scope is not a usable token. */
  | 'invalid-scope';

export interface BindingIssue {
  readonly code: BindingIssueCode;
  /** Blocking issues must stop the write; the rest are reported. */
  readonly blocking: boolean;
  readonly detail: string;
  readonly bindingId?: string;
}

/**
 * Inspect a binding set against the installed packs.
 *
 * `applied` without `entitled` is a warning and not a block on purpose: it is the
 * honest state during a trial, and refusing to record it would push an operator
 * to mark the customer entitled when they are not. It still has to be visible.
 */
export function bindingIssues(
  bindings: readonly SpecialtyBindingLike[],
  installedPackIds: readonly string[],
): BindingIssue[] {
  const installed = new Set(installedPackIds);
  const issues: BindingIssue[] = [];
  const seen = new Map<string, string>();

  for (const binding of bindings) {
    const key = `${binding.scope}${SPECIALTY_BINDING_SEP}${binding.packId}`;
    const previous = seen.get(key);
    if (previous) {
      issues.push({
        code: 'duplicate-scope-and-pack',
        blocking: true,
        detail: `two bindings for ${binding.packId} at ${binding.scope}`,
        bindingId: binding.id,
      });
    } else {
      seen.set(key, binding.id);
    }

    if (!isUsableBindingScope(binding.scope)) {
      issues.push({
        code: 'invalid-scope',
        blocking: true,
        detail: `'${binding.scope}' is not a usable scope`,
        bindingId: binding.id,
      });
    }

    if (!installed.has(binding.packId)) {
      issues.push({
        code: 'pack-not-installed',
        blocking: true,
        detail: `binding names '${binding.packId}', which is not installed`,
        bindingId: binding.id,
      });
    }

    if (binding.show && !binding.applied) {
      issues.push({
        code: 'show-without-applied',
        blocking: false,
        detail: `${binding.packId} is shown at ${binding.scope} but not applied — the lens will have no patients behind it`,
        bindingId: binding.id,
      });
    }

    if (binding.applied && !binding.entitled) {
      issues.push({
        code: 'applied-without-entitled',
        blocking: false,
        detail: `${binding.packId} is applied at ${binding.scope} without an entitlement`,
        bindingId: binding.id,
      });
    }
  }

  return issues;
}

/** True when the set contains a blocking problem. Used by the write path. */
export function hasBlockingBindingIssue(issues: readonly BindingIssue[]): boolean {
  return issues.some((i) => i.blocking);
}
