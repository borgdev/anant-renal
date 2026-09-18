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

// Which patients each pack is responsible for — as a DECISION, not a default.
//
// The platform falls back to "hand this pack every patient in the deployment"
// when a pack declares no cohort (`src/server/app.ts`, `cohortByPack`). That
// fallback is silent, and silence is the problem: from the outside, a pack that
// deliberately takes everyone and a pack whose author simply never declared a
// cohort are the same pack. The S4 exit criterion — "the specialty sees its own
// population" — is therefore VACUOUS for both, and a criterion that passes
// because it does not apply is worse than one that fails, because nobody looks
// at it again.
//
// This file does not invent fifteen clinical cohorts; that is a per-specialty
// judgement, and a predicate a clinician would argue about is a clinical
// position this codebase has no business asserting on a pack's behalf. What it
// does is make the absence LOUD and ATTRIBUTED. Every installed pack must appear
// in exactly one of the three lists below, so:
//
//   * adding a pack without deciding how it is scoped fails this test, with the
//     nine words "decide, do not default" attached;
//   * "takes everyone" now carries a reason, and the reason is checked to be one
//     of two kinds — structural (this pack has no patient population) or
//     blocked (the fact that would scope it does not exist in the projection).
//
// The second kind is a to-do list with a name on it rather than a number in a
// document. That is the whole point.

import { describe, expect, it } from 'vitest';
import * as packsModule from '../packs/index.js';

/** A pack descriptor as the platform actually installs it. */
interface InstalledPack {
  readonly id: string;
  readonly cohort?: { readonly id: string; readonly emptyReason?: string } | undefined;
}

const installedPacks: ReadonlyArray<readonly [string, InstalledPack]> = Object.entries(
  packsModule as Record<string, unknown>,
)
  .filter(
    ([key, value]) =>
      key.endsWith('Pack') && typeof value === 'object' && value !== null && 'id' in (value as object),
  )
  .map(([key, value]) => [key, value as unknown as InstalledPack] as const)
  .sort(([a], [b]) => a.localeCompare(b));

const installedNames = installedPacks.map(([name]) => name);

/**
 * Packs that scope themselves to a named population. The cohort is what the
 * platform filters by, so this is the only list whose members change behaviour.
 */
const declaresACohort: readonly string[] = ['oncologyProviderPack'];

/**
 * Packs that legitimately have no patient population to scope to. Taking the
 * whole deployment is the CORRECT answer for these, not a deferral.
 */
const notAPatientPopulation: Readonly<Record<string, string>> = Object.freeze({
  healthcareCorePack:
    'The substrate every other pack builds on. A cohort here would scope the platform, not a specialty.',
  cmsUniversePack:
    'A regulatory and measure catalog — CMS universes, payment systems, linkages. It describes programs, and never enrols a patient.',
});

/**
 * Packs that take the whole deployment because the FACT that would scope them is
 * not in the projection yet. Each value names the missing fact. These are
 * defects with an owner, not design decisions.
 */
const awaitingAScopingFact: Readonly<Record<string, string>> = Object.freeze({
  dialysisProviderPack:
    'ESRD on the problem list would scope it, and that IS recorded — the predicate is unwritten.',
  ckdNavigationPack:
    'CKD on the problem list would scope it, and that IS recorded — the predicate is unwritten.',
  oncologyDeepPack:
    'It would narrow the oncology cohort that already exists, but declares nothing of its own.',
  payerPack:
    'The payor fact now reaches the graph for a GENERATED population — `projection.ts` lifts it out of the claim it is nested in and `enrich.ts` writes it to `state.insurance` (see §5 S5) — but the static fixture writes no coverage at all, so it is absent for every fixture patient. Benefit membership is therefore decidable only against a population realm, and the predicate is still unwritten: a cohort selecting on it would empty on the default fixture.',
  careManagementPack: 'No risk-stratification fact in the projection.',
  behavioralHealthPack: 'No behavioural-health diagnosis reaches the recorded problem list.',
  infusionProviderPack: 'No specialty-drug administration fact in the projection.',
  homeHealthPack: 'No home-health episode fact in the projection.',
  longTermCarePack: 'No residence or custody fact in the projection.',
  radiologyPack: 'No imaging-order fact in the projection.',
  edThroughputPack: 'No encounter-arrival fact in the projection.',
  revenueCyclePack: 'No claim or remittance fact in the projection.',
  hospitalAtHomePack: 'No admission fact in the projection.',
});

const classified: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(declaresACohort.map((name) => [name, 'declares a cohort'])),
  ...Object.fromEntries(
    Object.entries(notAPatientPopulation).map(([name, why]) => [name, `takes everyone — by design: ${why}`]),
  ),
  ...Object.fromEntries(
    Object.entries(awaitingAScopingFact).map(([name, why]) => [name, `takes everyone — awaiting a fact: ${why}`]),
  ),
});

describe('every installed pack states which patients it is responsible for', () => {
  it('finds the installed packs at all', () => {
    // Without this, a typo in the filter turns every assertion below into a
    // vacuous pass over an empty array — the exact failure this file exists to
    // prevent, reproduced in its own test.
    expect(installedPacks.length).toBeGreaterThanOrEqual(10);
    expect(installedNames).toContain('oncologyProviderPack');
    expect(installedNames).toContain('dialysisProviderPack');
  });

  it('classifies every installed pack, so an undeclared one cannot pass unnoticed', () => {
    const unclassified = installedNames.filter((name) => classified[name] === undefined);
    expect(
      unclassified,
      `These packs declare no patient scope. Decide — do not default. Add each to `
        + '`declaresACohort`, `notAPatientPopulation` or `awaitingAScopingFact` with a reason.',
    ).toEqual([]);
  });

  it('classifies nothing that is not installed', () => {
    const phantom = Object.keys(classified).filter((name) => !installedNames.includes(name));
    expect(phantom, 'A classified name is not an exported pack — rename it or drop it.').toEqual([]);
  });

  it('classifies each pack exactly once', () => {
    expect(installedNames.length).toBe(Object.keys(classified).length);
  });

  it('agrees with what the packs actually carry, so the lists cannot drift from the code', () => {
    const declaring = installedPacks
      .filter(([, pack]) => pack.cohort !== undefined)
      .map(([name]) => name)
      .sort();
    expect(declaring).toEqual([...declaresACohort].sort());
  });

  it('still has both kinds of "takes everyone", so neither bucket can be emptied to make this pass', () => {
    expect(Object.keys(notAPatientPopulation).length).toBeGreaterThan(0);
    expect(
      Object.keys(awaitingAScopingFact).length,
      'This bucket is the recorded backlog. Emptying it means the work is done, not that the '
        + 'bucket was inconvenient — if it is genuinely done, delete the bucket deliberately.',
    ).toBeGreaterThan(0);
  });

  it('carries an empty-reason wherever a cohort exists, because the platform renders it', () => {
    // "No patient is enrolled here" and "nothing needs doing" render identically
    // and mean opposite things; the pack owns the string that tells them apart.
    for (const [name, pack] of installedPacks) {
      if (pack.cohort === undefined) continue;
      expect(pack.cohort.emptyReason, `${name} declares a cohort with no emptyReason`).toBeTruthy();
    }
  });
});
