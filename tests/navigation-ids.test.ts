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

// G5b — the shell's vocabulary and a specialty's vocabulary are different things.
//
// ONE type used to carry both, and the cost was not stylistic. `NavigationId` was
// simultaneously:
//
//   (a) the closed set of destinations the shell's own sidebar and `switch` can
//       render, and
//   (b) the parameter type of `onNavigate` in ~21 components —
//
// and it contained `anemia`, `mbd`, `nutrition`, `infection` and the rest of ONE
// specialty's pages, by name. So "the platform knows about renal" was not an
// opinion about the code; it was a union member. Adding a specialty was a union
// member plus a `case` arm.
//
// The split is `PlatformNavId` (closed, shell-owned) vs `SpecialtyViewId` (open,
// declared by the pack). What the split BUYS is that these two questions become
// separable and therefore checkable:
//
//   * is this id the shell's own destination, or a specialty's page?
//   * if a pack declares a page the shell cannot draw, what happens?
//
// The second question had no answer, and that is the defect hiding under the type
// problem. `submenuGroups` cast every pack-declared id with `view.id as
// NavigationId`, and the render `switch` had NO `default`. So a pack declaring a
// view the shell had never heard of produced an id that type-checked, matched no
// `case`, fell out of the switch, and rendered `undefined` — a blank workspace
// under a live tab, with nothing anywhere saying why. A cast that admits unknown
// strings plus a switch with no default is a silent blank page in front of a
// clinician, and it is the reason G5b is a correctness fix rather than a tidy-up.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORM_LENS_VIEWS } from '../src/control-plane/pack-contract.js';

const EXEC = fileURLToPath(new URL('../exec-app/src', import.meta.url));

const read = (relative: string): string => readFileSync(`${EXEC}/${relative}`, 'utf8');

/** The members of the shell's closed union of its OWN destinations. */
function platformNavIds(): string[] {
  const source = read('lib/types.ts');
  const body = /export type PlatformNavId\s*=([^;]*);/.exec(source);
  expect(body, 'PlatformNavId is not a readable union — this guard cannot check it').toBeTruthy();
  return [...body![1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** The ids the sidebar actually renders — the union's other half. */
function sidebarIds(): string[] {
  const source = read('app.tsx');
  const block = /const navGroups[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  expect(block, 'navGroups is not a readable literal — this guard cannot check it').toBeTruthy();
  return [...block![1]!.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/** The `switch (activeNav)` body: the shell's own renderer dispatch. */
function renderSwitch(): string {
  const source = read('app.tsx');
  const start = source.indexOf('switch (activeNav) {');
  expect(start, 'the activeNav switch was not found — this guard cannot check it').toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('\n    }\n  })();');
  expect(end, 'the activeNav switch has no readable end — this guard cannot check it').toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe('G5b — the platform vocabulary is the shell own destinations, and only those', () => {
  it('every PlatformNavId is a destination the sidebar renders, and every nav item is in the union', () => {
    // Both directions, and each catches a different mistake. A union member with
    // no nav item is a destination that cannot be reached; a nav item outside the
    // union is a destination the renderer is not typed for. Neither is fatal on
    // its own, which is exactly why it drifts.
    const declared = platformNavIds().sort();
    const rendered = sidebarIds().sort();
    expect(declared).toEqual(rendered);
  });

  it('no SPECIALTY page is a PlatformNavId', () => {
    // THE assertion this whole change exists for. `PLATFORM_LENS_VIEWS` is the
    // server's list of the screens a renal lens declares — one specialty's pages.
    // If any of them is also a shell destination, the shell still knows the
    // specialty by name and the split is cosmetic.
    //
    // `protocols` is the single legitimate overlap, and it is not an exception to
    // the rule — it is the one id that IS the shell's: the Clinical protocols
    // sidebar entry, which is the hub the specialty strip hangs off. The
    // intersection being exactly that one id is the claim.
    const specialtyViews = PLATFORM_LENS_VIEWS.filter((id) => id !== 'protocols');
    const overlap = platformNavIds().filter((id) => specialtyViews.includes(id));
    expect(overlap).toEqual([]);
    // And the hub really is on both sides, so the assertion above is not passing
    // because `PLATFORM_LENS_VIEWS` failed to load.
    expect(PLATFORM_LENS_VIEWS).toContain('protocols');
    expect(platformNavIds()).toContain('protocols');
  });

  it('the render switch handles nothing that no vocabulary declares', () => {
    // A `case` arm for an id nothing declares is dead code that reads as a
    // feature, and it is how the renal ids got embedded in the shell in the first
    // place. Every arm must be either a platform destination or a view the
    // shipped lens list actually names.
    const arms = [...renderSwitch().matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]!);
    expect(arms.length).toBeGreaterThan(10);
    const known = new Set([...platformNavIds(), ...PLATFORM_LENS_VIEWS]);
    expect(arms.filter((arm) => !known.has(arm))).toEqual([]);
  });
});

describe('G5b — a view the shell cannot draw says so, instead of rendering nothing', () => {
  it('the switch has a default arm', () => {
    // The arm that was missing. Without it an unrecognised id falls out of the
    // switch and React renders `undefined`, so the failure mode of "this pack
    // declared a screen this console has no renderer for" was a blank workspace
    // with a live, selected tab above it.
    expect(renderSwitch()).toMatch(/default\s*:/);
  });

  it('the default arm renders a named panel with the id in it', () => {
    // Not `return null`, not an empty fragment. A blank panel is the same
    // experience as the bug this replaces; the operator has to be able to read
    // which view failed and report it.
    const fallback = /default\s*:([\s\S]*)$/.exec(renderSwitch());
    expect(fallback, 'no default arm — see the test above').toBeTruthy();
    expect(fallback![1]).toMatch(/<UnrenderableView/);
    expect(fallback![1]).toMatch(/id=\{/);
  });

  it('the panel exists and can render without a page around it', () => {
    const file = 'components/unrenderable-view.tsx';
    expect(existsSync(`${EXEC}/${file}`), `${file} is missing`).toBe(true);
    const source = read(file);
    // It has to be a real component, not a stub that returns nothing.
    expect(source).toMatch(/export default function UnrenderableView/);
    expect(source).toMatch(/return \(/);
  });

  it('the shell never claims a pack-declared id is one of its own', () => {
    // `view.id as NavigationId` is the exact line that made an unknown specialty
    // id type-check. The open type makes the cast unnecessary — but a cast is
    // still legal TypeScript, so the guard is here rather than left to review.
    const source = read('app.tsx');
    expect(source).not.toMatch(/as\s+PlatformNavId/);
    expect(source).not.toMatch(/as\s+NavigationId/);
  });

  it('a specialty view id is not narrowed to the platform union', () => {
    // The type-level half, read from the source because `exec-app` is a separate
    // Vite project this test cannot import. `SpecialtyViewId` must accept a pack's
    // own word for its own page — that is the whole point of it being open.
    const types = read('lib/types.ts');
    expect(types).toMatch(/export type SpecialtyViewId\s*=\s*string/);
    expect(types).toMatch(/export type NavTarget\s*=\s*PlatformNavId\s*\|\s*SpecialtyViewId/);
    // And the old undifferentiated name is gone, so a reader cannot reach for it.
    expect(types).not.toMatch(/export type NavigationId/);
  });
});
