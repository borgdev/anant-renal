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

// G6 — specialty bindings: where a specialty APPLIES and where it is SHOWN.
//
// The tests that matter most here are the ones about the three questions staying
// separate. A model where one flag answers all three is the defect this whole
// slice exists to prevent, so `show` and `applied` are asserted independently
// everywhere rather than as a pair.

import { describe, it, expect } from 'vitest';
import {
  SCOPE_WILDCARD,
  SPECIALTY_BINDING_SEP,
  isUsableBindingScope,
  specialtyBindingId,
  parseSpecialtyBindingId,
  bindingMatchesViewer,
  resolveSpecialtyBindings,
  shownSpecialties,
  bindingIssues,
  hasBlockingBindingIssue,
  type SpecialtyBindingLike,
} from '../src/control-plane/specialty-bindings.js';

const RENAL = 'dialysis-provider';
const PAYER = 'payer';
const ONCOLOGY = 'oncology-provider';
const INSTALLED = [RENAL, PAYER, ONCOLOGY];

function binding(over: Partial<SpecialtyBindingLike> & { scope: string; packId: string }): SpecialtyBindingLike {
  return {
    id: specialtyBindingId(over.scope, over.packId),
    applied: true,
    show: true,
    entitled: true,
    ...over,
  };
}

const resolve = (bindings: SpecialtyBindingLike[], viewerScopeIds: string[], legacyActivePackId?: string) =>
  resolveSpecialtyBindings({
    bindings,
    installedPackIds: INSTALLED,
    viewerScopeIds,
    ...(legacyActivePackId !== undefined ? { legacyActivePackId } : {}),
  });

const byId = (rows: ReturnType<typeof resolve>) => new Map(rows.map((r) => [r.packId, r]));

describe('G6 — specialty binding resolution', () => {
  describe('with no bindings at all', () => {
    it('reproduces the behaviour that shipped before the model, per pack', () => {
      const rows = resolve([], [SCOPE_WILDCARD], PAYER);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.applied, row.packId).toBe(true);
        expect(row.show, row.packId).toBe(true);
        expect(row.entitled, row.packId).toBe(true);
        expect(row.reason, row.packId).toBe('no-binding');
        expect(row.appliedScopes).toEqual([SCOPE_WILDCARD]);
      }
      // The legacy activation still decides which lens leads.
      expect(byId(rows).get(PAYER)!.primary).toBe(true);
      expect(byId(rows).get(RENAL)!.primary).toBe(false);
    });

    it('does not fall over when the legacy activation names a pack that is not installed', () => {
      const rows = resolve([], [SCOPE_WILDCARD], 'ghost-pack');
      expect(rows).toHaveLength(3);
      // Nothing installed matches, so nothing leads. Filling the gap with "the
      // first installed pack" would elect the substrate, which is not a specialty
      // — the caller has a better fallback and must be free to use it.
      expect(rows.filter((r) => r.primary)).toEqual([]);
    });
  });

  describe('bindings are overrides, never a switch to opt-in', () => {
    it('leaves every pack it does not mention exactly as it was', () => {
      // This is the property that makes the model safe to introduce: one binding
      // for one pack must not dark the rest of the deployment.
      const rows = byId(resolve([binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY, show: false, applied: false })], [SCOPE_WILDCARD]));
      expect(rows.get(ONCOLOGY)!.show).toBe(false);
      expect(rows.get(ONCOLOGY)!.reason).toBe('binding');
      for (const packId of [RENAL, PAYER]) {
        expect(rows.get(packId)!.show, packId).toBe(true);
        expect(rows.get(packId)!.applied, packId).toBe(true);
        expect(rows.get(packId)!.reason, packId).toBe('no-binding');
      }
    });
  });

  describe('applied and show are separate questions', () => {
    it('can show a specialty without applying it', () => {
      const rows = byId(resolve([binding({ scope: SCOPE_WILDCARD, packId: RENAL, show: true, applied: false })], [SCOPE_WILDCARD]));
      expect(rows.get(RENAL)!.show).toBe(true);
      expect(rows.get(RENAL)!.applied).toBe(false);
      expect(rows.get(RENAL)!.appliedScopes).toEqual([]);
    });

    it('can apply a specialty without showing it — the dangerous direction, and it is reported', () => {
      const bindings = [binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY, show: false, applied: true, entitled: false })];
      const rows = byId(resolve(bindings, [SCOPE_WILDCARD]));
      expect(rows.get(ONCOLOGY)!.applied).toBe(true);
      expect(rows.get(ONCOLOGY)!.show).toBe(false);
      // Applied-but-not-shown still computes, so it must be visible in the health
      // report rather than silently running.
      const issues = bindingIssues(bindings, INSTALLED);
      expect(issues.map((i) => i.code)).toContain('applied-without-entitled');
      expect(hasBlockingBindingIssue(issues)).toBe(false);
    });

    it('warns when a lens is shown with nothing applied behind it', () => {
      const issues = bindingIssues([binding({ scope: SCOPE_WILDCARD, packId: RENAL, show: true, applied: false })], INSTALLED);
      expect(issues.map((i) => i.code)).toContain('show-without-applied');
      expect(hasBlockingBindingIssue(issues)).toBe(false);
    });
  });

  describe('an explicit scope overrides the wildcard', () => {
    const global = binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY, show: false, applied: false });
    const atFacility = binding({ scope: 'facility:rb-nashville', packId: ONCOLOGY, show: true, applied: true });

    it('uses the scoped rule for a viewer that holds the scope', () => {
      const rows = byId(resolve([global, atFacility], ['facility:rb-nashville']));
      const oncology = rows.get(ONCOLOGY)!;
      expect(oncology.show).toBe(true);
      expect(oncology.applied).toBe(true);
      expect(oncology.appliedScopes).toEqual(['facility:rb-nashville']);
      expect(oncology.decisions.every((d) => d.specificity === 1)).toBe(true);
    });

    it('uses the global rule for a viewer that does not', () => {
      const rows = byId(resolve([global, atFacility], ['facility:rb-franklin']));
      const oncology = rows.get(ONCOLOGY)!;
      expect(oncology.show).toBe(false);
      expect(oncology.applied).toBe(false);
    });

    it('lets a scoped rule TURN OFF what the global rule turned on, and does not merge the scopes', () => {
      // The failure this guards: "global on, this facility off" resolving to
      // applied with the global `scope:*` still in appliedScopes — which would
      // quietly keep evaluating at the facility that switched it off.
      const rows = byId(resolve([
        binding({ scope: SCOPE_WILDCARD, packId: RENAL, applied: true, show: true }),
        binding({ scope: 'facility:rb-franklin', packId: RENAL, applied: false, show: false }),
      ], ['facility:rb-franklin']));
      const renal = rows.get(RENAL)!;
      expect(renal.applied).toBe(false);
      expect(renal.appliedScopes).toEqual([]);
    });

    it('keeps applied scopes from only the winning band when several sites apply it', () => {
      const rows = byId(resolve([
        binding({ scope: 'facility:a', packId: RENAL, applied: true, show: true }),
        binding({ scope: 'facility:b', packId: RENAL, applied: true, show: true }),
      ], ['facility:a', 'facility:b']));
      // Two explicit scopes are the same specificity, so both contribute: the
      // pack evaluates at both sites and the viewer sees it once.
      expect(rows.get(RENAL)!.appliedScopes).toEqual(['facility:a', 'facility:b']);
      expect(rows.get(RENAL)!.reason).toBe('any-grant');
    });

    it('does not apply a specialty to a viewer with no matching scope', () => {
      const rows = byId(resolve([binding({ scope: 'facility:a', packId: RENAL })], ['facility:b']));
      // The binding does not match, so the pack is simply not configured for
      // this viewer — the fallback applies, and it is named as the fallback.
      expect(rows.get(RENAL)!.reason).toBe('no-binding');
    });
  });

  describe('exactly one lens leads, deterministically', () => {
    it('takes the lowest binding id when two claim primary at equal specificity and says so', () => {
      const a = binding({ scope: 'facility:a', packId: RENAL, primary: true });
      const b = binding({ scope: 'facility:a', packId: PAYER, primary: true });
      for (const order of [[a, b], [b, a]]) {
        const rows = resolve(order, ['facility:a']);
        const primaries = rows.filter((r) => r.primary).map((r) => r.packId);
        expect(primaries).toEqual([RENAL]); // dialysis-provider sorts before payer
        expect(byId(rows).get(RENAL)!.reason).toBe('ambiguous-primary');
      }
    });

    it('elects a sole shown specialty, but refuses to choose between several', () => {
      // One shown — unambiguous, so it leads without anyone having to say so.
      const sole = resolve([
        binding({ scope: SCOPE_WILDCARD, packId: RENAL }),
        binding({ scope: SCOPE_WILDCARD, packId: PAYER, show: false, applied: false }),
        binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY, show: false, applied: false }),
      ], [SCOPE_WILDCARD]);
      expect(sole.filter((r) => r.primary).map((r) => r.packId)).toEqual([RENAL]);

      // Several shown and nobody claiming it: no leader, on purpose. This used to
      // elect the first shown pack, which in a real deployment is `healthcare-core`
      // — the substrate, with no lens of its own.
      const many = resolve([
        binding({ scope: SCOPE_WILDCARD, packId: PAYER, show: false, applied: false }),
        binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY }),
      ], [SCOPE_WILDCARD]);
      expect(many.filter((r) => r.primary)).toEqual([]);
      expect(shownSpecialties(many).map((r) => r.packId)).toEqual([RENAL, ONCOLOGY]);
    });

    it('assigns no primary at all when every specialty is hidden', () => {
      const all = INSTALLED.map((packId) => binding({ scope: SCOPE_WILDCARD, packId, show: false, applied: false }));
      const rows = resolve(all, [SCOPE_WILDCARD]);
      expect(rows.filter((r) => r.primary)).toHaveLength(0);
      expect(shownSpecialties(rows)).toEqual([]);
    });

    it('never lets a hidden specialty lead, and invents no replacement for it', () => {
      const rows = resolve([binding({ scope: SCOPE_WILDCARD, packId: RENAL, primary: true, show: false, applied: false })], [SCOPE_WILDCARD]);
      expect(byId(rows).get(RENAL)!.primary).toBe(false);
      // The claim was refused; it was not transferred to some other pack.
      expect(rows.filter((r) => r.primary)).toEqual([]);
    });
  });

  describe('determinism', () => {
    it('produces identical output for any ordering of the same bindings', () => {
      const set = [
        binding({ scope: SCOPE_WILDCARD, packId: RENAL, primary: true }),
        binding({ scope: 'facility:a', packId: RENAL, applied: false, show: false }),
        binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY, show: false, applied: false }),
        binding({ scope: 'facility:a', packId: PAYER, primary: true }),
      ];
      const forward = JSON.stringify(resolve(set, ['facility:a']));
      const reversed = JSON.stringify(resolve([...set].reverse(), ['facility:a']));
      expect(reversed).toBe(forward);
    });

    it('orders shown specialties with the primary first', () => {
      const rows = resolve([binding({ scope: SCOPE_WILDCARD, packId: ONCOLOGY, primary: true })], [SCOPE_WILDCARD]);
      const shown = shownSpecialties(rows);
      expect(shown[0]!.packId).toBe(ONCOLOGY);
      expect(shown[0]!.primary).toBe(true);
    });

    it('returns every installed pack, in the installed order', () => {
      expect(resolve([], [SCOPE_WILDCARD]).map((r) => r.packId)).toEqual(INSTALLED);
    });
  });

  describe('binding ids', () => {
    it('round-trips a scope that contains colons, which realm ids do', () => {
      const scope = 'realm:sim:renal-a';
      const id = specialtyBindingId(scope, RENAL);
      expect(parseSpecialtyBindingId(id)).toEqual({ scope, packId: RENAL });
    });

    it('accepts the wildcard and a realm scope, and refuses junk', () => {
      expect(isUsableBindingScope(SCOPE_WILDCARD)).toBe(true);
      expect(isUsableBindingScope('realm:sim:renal-a')).toBe(true);
      expect(isUsableBindingScope('facility:rb-nashville')).toBe(true);
      expect(isUsableBindingScope('')).toBe(false);
      expect(isUsableBindingScope('  ')).toBe(false);
      expect(isUsableBindingScope(`a${SPECIALTY_BINDING_SEP}b`)).toBe(false);
      expect(isUsableBindingScope('has space')).toBe(false);
    });

    it('returns undefined rather than throwing on a malformed id', () => {
      expect(parseSpecialtyBindingId('nope')).toBeUndefined();
      expect(parseSpecialtyBindingId(`${SPECIALTY_BINDING_SEP}x`)).toBeUndefined();
      expect(parseSpecialtyBindingId(`x${SPECIALTY_BINDING_SEP}`)).toBeUndefined();
    });
  });

  describe('configuration health', () => {
    it('blocks a binding that names a pack nobody installed', () => {
      const issues = bindingIssues([binding({ scope: SCOPE_WILDCARD, packId: 'ghost-pack' })], INSTALLED);
      expect(issues.map((i) => i.code)).toContain('pack-not-installed');
      expect(hasBlockingBindingIssue(issues)).toBe(true);
    });

    it('blocks two bindings for the same pack at the same scope', () => {
      const dup = [
        binding({ scope: 'facility:a', packId: RENAL }),
        binding({ scope: 'facility:a', packId: RENAL, show: false }),
      ];
      const issues = bindingIssues(dup, INSTALLED);
      expect(issues.map((i) => i.code)).toContain('duplicate-scope-and-pack');
      expect(hasBlockingBindingIssue(issues)).toBe(true);
    });

    it('blocks an unusable scope', () => {
      const issues = bindingIssues([{ ...binding({ scope: 'x', packId: RENAL }), scope: '' }], INSTALLED);
      expect(issues.map((i) => i.code)).toContain('invalid-scope');
      expect(hasBlockingBindingIssue(issues)).toBe(true);
    });

    it('reports nothing for a healthy set', () => {
      const issues = bindingIssues([
        binding({ scope: SCOPE_WILDCARD, packId: RENAL }),
        binding({ scope: 'facility:a', packId: PAYER }),
      ], INSTALLED);
      expect(issues).toEqual([]);
    });
  });

  describe('bindingMatchesViewer', () => {
    it('matches every viewer from a wildcard binding, because a global rule is for everyone', () => {
      const global = binding({ scope: SCOPE_WILDCARD, packId: RENAL });
      expect(bindingMatchesViewer(global, ['facility:a'])).toBe(true);
      expect(bindingMatchesViewer(global, ['realm:sim:renal-a'])).toBe(true);
      expect(bindingMatchesViewer(global, [])).toBe(true);
    });

    it('grants a scoped viewer every binding, and a scoped binding only its own scope', () => {
      const scoped = binding({ scope: 'facility:a', packId: RENAL });
      expect(bindingMatchesViewer(scoped, [SCOPE_WILDCARD])).toBe(true);
      expect(bindingMatchesViewer(scoped, ['facility:a'])).toBe(true);
      expect(bindingMatchesViewer(scoped, ['facility:b'])).toBe(false);
    });
  });
});
