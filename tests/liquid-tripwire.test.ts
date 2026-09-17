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

// §9.1 constraint 2 — the trip-wire, enforced.
//
// `src/liquid/` is the PLATFORM's trajectory engine, and it names dialysis
// throughout. §9.1 records that as the fourth place one specialty's medicine is
// hardcoded in a platform layer — the ones G1/G4b/G5b removed were protocols, views
// and the shell vocabulary; this one is deliberately deferred (§9.7), because the
// population work does not need it and a `state_model` declaration with exactly one
// implementation is what `PLATFORM_VIEW_KINDS` was written to avoid.
//
// A deferral with no enforcer is an omission that reads like a decision. §9.7 names
// the guard: **the first new renal constant the population work needs inside
// `src/liquid/` is the signal to stop and declare the state model properly.**
//
// This test is that guard, in the spirit of `tests/navigation-ids.test.ts`. It freezes
// the renal vocabulary the engine already carries and fails when a new one appears —
// so the next person to add one has to make the §9.1 decision consciously, in a diff,
// rather than discovering two years later that the coupling has grown.
//
// The baseline below is a COUNT of occurrences per file, not a line number, so an edit
// that moves a literal without adding one does not fail. The point is to catch growth,
// not churn.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIQUID_DIR = join(process.cwd(), 'src', 'liquid');

/**
 * Renal vocabulary the engine already carries, per file, as a multiset.
 *
 * Each entry is a literal that names one specialty's medicine inside the platform
 * layer. They are all pre-existing: this file adds none, and the count is what the
 * guard measures.
 */
const FROZEN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The event vector's feature names, `'Underdialysis'` and `'CKD-MBD'` from the
  // `problemList` reads, and the `domainId` default.
  'trajectory.ts': Object.freeze([
    'dialysis',
    'access_complication',
    'abnormal_vital_reading',
    'diet_phosphate_violation',
    'lab_marker_elevated',
    'missed_treatment',
    'CKD-MBD',
    'Underdialysis',
  ]),
  // The `domainId` default at the two `trainer.ts` call sites that name it.
  'trainer.ts': Object.freeze(['dialysis', 'dialysis']),
  // The `domainId` default on the forecast entry point.
  'forecast.ts': Object.freeze(['dialysis']),
});

/**
 * The `DIALYSIS_*` / `Dialysis*` identifier vocabulary, as DISTINCT NAMES.
 *
 * Names rather than per-file counts, and the choice is deliberate: a count breaks on
 * a rename-without-removal and on moving a type between files, so it would demand
 * baseline edits for churn and train the reader to update it without reading it. The
 * distinct set only changes when the engine gains a NEW renal name — which is the
 * event the trip-wire exists to catch.
 *
 * Measured, not estimated: `DialysisState` 22, `DIALYSIS_PROJECTION` 8, `DialysisLabs`
 * 8, `DIALYSIS_DIMENSIONS` 6, `DialysisDim` 5 across `src/liquid/*.ts`.
 */
const FROZEN_IDENTIFIERS: readonly string[] = Object.freeze([
  'DIALYSIS_DIMENSIONS',
  'DIALYSIS_PROJECTION',
  'DialysisDim',
  'DialysisLabs',
  'DialysisState',
]);

/**
 * The literal pattern, and why each part is in it.
 *
 * Deliberately narrow. `'dialysis'` as a quoted string, the five `EVENT_ORDER`
 * features, and the two `problemList` terms `#eventVector` reads by name. A broader
 * pattern would match prose in comments and make the guard fail on documentation,
 * which is the opposite of what it is for.
 */
const LITERAL_PATTERN = /'(dialysis|access_complication|abnormal_vital_reading|diet_phosphate_violation|lab_marker_elevated|missed_treatment|CKD-MBD|Underdialysis)'/g;

/** `DIALYSIS_DIMENSIONS`, `DialysisState`, `DialysisDim`, … — the type vocabulary. */
const IDENTIFIER_PATTERN = /\b(DIALYSIS_[A-Z_]+|Dialysis[A-Za-z]*)\b/g;

function liquidFiles(): string[] {
  return readdirSync(LIQUID_DIR).filter((f) => f.endsWith('.ts')).sort();
}

function countMatches(text: string, pattern: RegExp): string[] {
  // A fresh regex per call: a /g/ regex carries `lastIndex` between uses, and sharing
  // one across files silently skips matches from the second file onward.
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].map((m) => m[1]!);
}

describe('§9.1 trip-wire — no NEW renal vocabulary inside src/liquid/', () => {
  it('carries exactly the renal literals it was frozen with', () => {
    const actual: Record<string, string[]> = {};
    for (const file of liquidFiles()) {
      const found = countMatches(readFileSync(join(LIQUID_DIR, file), 'utf8'), LITERAL_PATTERN);
      if (found.length > 0) actual[file] = found.sort();
    }

    // Compared as a whole map so a failure shows what was ADDED and where, not just
    // that two strings differ.
    expect(
      actual,
      'A renal literal entered src/liquid/. §9.1 constraint 2 makes this the '
      + 'trip-wire: either declare the state model properly, or add it to FROZEN in '
      + 'this file WITH A REASON. Adding it silently is the one option the plan '
      + 'rules out.',
    ).toEqual(
      Object.fromEntries(Object.entries(FROZEN).map(([f, l]) => [f, [...l].sort()])),
    );
  });

  it('carries exactly the frozen identifier vocabulary, and no new renal name', () => {
    const names = new Set<string>();
    for (const file of liquidFiles()) {
      const found = countMatches(readFileSync(join(LIQUID_DIR, file), 'utf8'), IDENTIFIER_PATTERN);
      for (const n of found) names.add(n);
    }
    expect(
      [...names].sort(),
      'A new renal NAME entered src/liquid/ (`Dialysis*` / `DIALYSIS_*`). §9.1 '
      + 'constraint 2 makes this the trip-wire: declare the state model properly, or '
      + 'add the name here WITH A REASON.',
    ).toEqual([...FROZEN_IDENTIFIERS].sort());
  });

  // Non-vacuity. If either pattern stopped matching — a rename, a quoting change — the
  // guards above would pass against an empty map and report success while measuring
  // nothing, which is the exact failure mode this repo keeps finding.
  it('is not vacuous: both patterns still match the baseline', () => {
    expect(Object.values(FROZEN).flat().length).toBeGreaterThan(0);
    expect(FROZEN_IDENTIFIERS.length).toBeGreaterThan(0);

    const all = liquidFiles().map((f) => readFileSync(join(LIQUID_DIR, f), 'utf8')).join('\n');
    expect(countMatches(all, LITERAL_PATTERN)).toContain('missed_treatment');
    expect(new Set(countMatches(all, IDENTIFIER_PATTERN))).toContain('DIALYSIS_DIMENSIONS');
  });

  // The population layer is where the Synthea → engine mapping is allowed to live
  // (§9.1 constraint 1). This asserts the OTHER half of that rule — that the mapping
  // is actually there and not inside the engine.
  it('keeps the Synthea → event-vector mapping out of the engine', () => {
    for (const file of liquidFiles()) {
      const text = readFileSync(join(LIQUID_DIR, file), 'utf8');
      expect(text, `${file} imports the population layer`).not.toMatch(
        /from\s+'(?:\.\.\/)+population\//,
      );
    }
  });
});
