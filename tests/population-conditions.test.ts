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

// S3 — the condition vocabulary.
//
// Every display string in `MEASURED` below was extracted verbatim from a generated
// 150-patient Synthea population (seed 424242, reference date 20260601, 215 distinct
// `Condition.code.coding[0].display` values). They are pinned rather than paraphrased
// because the whole mapping is keyed on display text: if Synthea renames a concept
// upstream, this fixture is what goes stale, and a failure here names the display that
// moved instead of silently reassigning patients between cohorts.
//
// Two of these cases are regression tests for defects the measurement found — see the
// header of `conditions.ts`. They are marked, so a future reader can see that the
// multi-rule behaviour and the uncertainty guard are deliberate rather than incidental.

import { describe, expect, it } from 'vitest';

import {
  conditionLabel,
  isRecognisedCondition,
  problemListFromConditions,
  problemsForCondition,
  PROBLEM_VOCABULARY,
} from '../src/population/synthea/conditions.js';

/** Verbatim displays from the measured population → the terms they must produce. */
const MEASURED: ReadonlyArray<[string, readonly string[]]> = [
  // ---- renal -----------------------------------------------------------------
  ['End-stage renal disease (disorder)', ['ESRD']],
  ['Chronic kidney disease stage 1 (disorder)', ['CKD']],
  ['Chronic kidney disease stage 2 (disorder)', ['CKD']],
  ['Chronic kidney disease stage 3 (disorder)', ['CKD']],
  ['Chronic kidney disease stage 4 (disorder)', ['CKD']],
  ['History of renal transplant (situation)', ['CKD']],
  ['Kidney transplant failure and rejection (disorder)', ['CKD']],
  // Not present in the sample; pinned so the ESRD rule's stage-5 pattern is covered.
  ['Chronic kidney disease stage 5 (disorder)', ['ESRD', 'CKD']],
  // ⚠ REGRESSION — the first-match-only defect. Matches the CKD rule AND the DM2
  // rule, and both must contribute: 17 patients in the sample carry this display, and
  // dropping DM2 from it stripped the type 2 diabetes flag from all of them.
  ['Disorder of kidney due to diabetes mellitus (disorder)', ['CKD', 'DM2']],
  // ---- metabolic / cardiac ---------------------------------------------------
  ['Diabetes mellitus type 2 (disorder)', ['DM2']],
  ['Microalbuminuria due to type 2 diabetes mellitus (disorder)', ['DM2']],
  ['Proteinuria due to type 2 diabetes mellitus (disorder)', ['DM2']],
  ['Neuropathy due to type 2 diabetes mellitus (disorder)', ['DM2']],
  ['Nonproliferative diabetic retinopathy due to type II diabetes mellitus', ['DM2']],
  ['Essential hypertension (disorder)', ['HTN']],
  ['Hyperlipidemia (disorder)', ['Hyperlipidemia']],
  ['Hypertriglyceridemia (disorder)', ['Hyperlipidemia']],
  ['Ischemic heart disease (disorder)', ['CAD']],
  ['Myocardial infarction (disorder)', ['CAD']],
  ['History of myocardial infarction (situation)', ['CAD']],
  ['Acute ST segment elevation myocardial infarction (disorder)', ['CAD']],
  ['Acute non-ST segment elevation myocardial infarction (disorder)', ['CAD']],
  ['Chronic congestive heart failure (disorder)', ['CHF']],
  ['Heart failure (disorder)', ['CHF']],
  // ---- infection -------------------------------------------------------------
  ['Sepsis (disorder)', ['Sepsis-risk']],
  ['Septic shock (disorder)', ['Sepsis-risk']],
  ['Sepsis caused by virus (disorder)', ['Sepsis-risk']],
  ['Disease caused by severe acute respiratory syndrome coronavirus 2 (disorder)', ['Sepsis-risk']],
  // ---- oncology --------------------------------------------------------------
  ['Non-small cell lung cancer (disorder)', ['NSCLC']],
  ['Non-small cell carcinoma of lung, TNM stage 1 (disorder)', ['NSCLC']],
  ['Malignant neoplasm of breast (disorder)', ['Breast cancer']],
  ['Malignant neoplasm of colon (disorder)', ['Colorectal cancer']],
  ['Overlapping malignant neoplasm of colon (disorder)', ['Colorectal cancer']],
  // Synthea's prostate module emits BOTH of these on the same 3 patients, which is
  // why the rule allows "malignant" to be optional: in this generator the bare
  // `Neoplasm of prostate` is a malignancy carrier, not a benign finding. Verified by
  // co-occurrence, not assumed.
  ['Neoplasm of prostate (disorder)', ['Prostate cancer']],
  ['Carcinoma in situ of prostate (disorder)', ['Prostate cancer']],
  // ---- generic ---------------------------------------------------------------
  ['Anemia (disorder)', ['Anemia']],
  // Both terms, and that is the correct reading rather than a leak: "anaemia OF
  // chronic kidney disease" states that the patient has chronic kidney disease. The
  // more specific rule (CKD-anemia) is declared first so the attribution leads.
  ['Anemia of chronic kidney disease (disorder)', ['CKD-anemia', 'CKD']],
];

/** Verbatim displays that must match NOTHING, and why. */
const UNMATCHED: ReadonlyArray<[string, string]> = [
  // Administrative / care-process statements — not clinical problems.
  ['Medication review due (situation)', 'administrative'],
  // Social determinants, deliberately outside the vocabulary (plan §4.6).
  ['Stress (finding)', 'social'],
  ['Social isolation (finding)', 'social'],
  ['Full-time employment (finding)', 'social'],
  ['Part-time employment (finding)', 'social'],
  ['Unemployed (finding)', 'social'],
  ['Has a criminal record (finding)', 'social'],
  // Dental — real, but no platform problem term exists.
  ['Gingivitis (disorder)', 'out of scope'],
  ['Primary dental caries (disorder)', 'out of scope'],
  // ⚠ REGRESSION — the uncertainty guard. `Suspected` + a clinical concept is a
  // differential, not a diagnosis. `Suspected disease caused by SARS-CoV-2` was the
  // single largest contributor to `Sepsis-risk` in the sample (17 patients) before the
  // guard; `Suspected prostate cancer` was being recorded as prostate cancer.
  ['Suspected disease caused by Severe acute respiratory coronavirus 2 (situation)', 'differential'],
  ['Suspected prostate cancer (situation)', 'differential'],
  ['Suspected lung cancer (situation)', 'differential'],
];

describe('condition vocabulary (S3, measured fixtures)', () => {
  it.each(MEASURED)('maps %j → %j', (display, terms) => {
    expect(problemsForCondition(display)).toEqual(terms);
  });

  it.each(UNMATCHED)('leaves %j unmatched (%s)', (display) => {
    expect(problemsForCondition(display)).toEqual([]);
    expect(isRecognisedCondition(display)).toBe(false);
  });

  it('is insensitive to case, as Synthea\'s own casing varies', () => {
    expect(problemsForCondition('END-STAGE RENAL DISEASE (DISORDER)')).toEqual(['ESRD']);
    expect(problemsForCondition('suspected prostate cancer (situation)')).toEqual([]);
  });

  it('handles undefined and empty input', () => {
    expect(problemsForCondition(undefined)).toEqual([]);
    expect(problemsForCondition('')).toEqual([]);
    expect(isRecognisedCondition(undefined)).toBe(false);
  });

  it('collects terms from every matching rule, in vocabulary order', () => {
    // Guards the fix generally, not just for the one display that exposed it: if
    // `problemsForCondition` ever reverts to a first-match search this fails, because
    // CKD is declared after CKD-anemia and DM2 after both.
    const order = PROBLEM_VOCABULARY.flatMap((r) => r.terms).filter((t, i, a) => a.indexOf(t) === i);
    const got = problemsForCondition('Disorder of kidney due to diabetes mellitus (disorder)');
    expect(got.length).toBeGreaterThan(1);
    expect([...got]).toEqual(order.filter((t) => got.includes(t)));
  });

  it('keeps a specificity-bearing rule ahead of the general one it refines', () => {
    // CKD stage 5 is both ESRD and CKD; ESRD is declared first so it leads. Ordering
    // is not cosmetic — the ESRD term is what the renal cohort gates on.
    const got = problemsForCondition('Chronic kidney disease stage 5 (disorder)');
    expect(got[0]).toBe('ESRD');
  });

  it('does not attribute a bare anaemia finding to kidney disease', () => {
    // The generic rule is declared last and matches only the exact display, so a bare
    // "Anemia" is never promoted to CKD-anemia — attributing it would overclaim.
    expect(problemsForCondition('Anemia (disorder)')).toEqual(['Anemia']);
    expect(problemsForCondition('Anemia (disorder)')).not.toContain('CKD-anemia');
  });
});

describe('conditionLabel', () => {
  it('strips Synthea\'s trailing qualifier', () => {
    expect(conditionLabel('Anemia (disorder)')).toBe('Anemia');
    expect(conditionLabel('History of renal transplant (situation)')).toBe('History of renal transplant');
    expect(conditionLabel('Sprain (morphologic abnormality)')).toBe('Sprain');
    expect(conditionLabel('Stress (finding)')).toBe('Stress');
  });

  it('leaves a display without a qualifier alone', () => {
    expect(conditionLabel('Some bare label')).toBe('Some bare label');
  });
});

describe('problemListFromConditions (S3)', () => {
  it('unions terms across conditions and deduplicates', () => {
    const result = problemListFromConditions([
      'End-stage renal disease (disorder)',
      'Chronic kidney disease stage 4 (disorder)',
      'Essential hypertension (disorder)',
      'Diabetes mellitus type 2 (disorder)',
      'Diabetes mellitus type 2 (disorder)',
    ]);
    expect(result.problems).toEqual(['ESRD', 'CKD', 'DM2', 'HTN']);
  });

  it('emits terms in vocabulary order regardless of input order', () => {
    const forward = problemListFromConditions(['Anemia (disorder)', 'End-stage renal disease (disorder)', 'Essential hypertension (disorder)']);
    const reversed = problemListFromConditions(['Essential hypertension (disorder)', 'End-stage renal disease (disorder)', 'Anemia (disorder)']);
    expect(forward.problems).toEqual(reversed.problems);
    expect(forward.problems).toEqual(['ESRD', 'HTN', 'Anemia']);
  });

  it('reports unmatched displays with their counts rather than dropping them', () => {
    const result = problemListFromConditions([
      'Medication review due (situation)',
      'Medication review due (situation)',
      'End-stage renal disease (disorder)',
      'Stress (finding)',
    ]);
    expect(result.problems).toEqual(['ESRD']);
    expect(result.unmatched).toEqual([
      { display: 'Medication review due (situation)', count: 2 },
      { display: 'Stress (finding)', count: 1 },
    ]);
  });

  it('reports which display produced which terms, for auditing', () => {
    const result = problemListFromConditions(['Disorder of kidney due to diabetes mellitus (disorder)']);
    expect(result.matched).toEqual([{ display: 'Disorder of kidney due to diabetes mellitus (disorder)', terms: ['CKD', 'DM2'] }]);
    expect(result.unmatched).toEqual([]);
  });

  it('ignores undefined displays', () => {
    const result = problemListFromConditions([undefined, 'Anemia (disorder)', undefined]);
    expect(result.problems).toEqual(['Anemia']);
    expect(result.unmatched).toEqual([]);
  });

  it('returns an empty list for a patient with no recognised conditions', () => {
    // The measured normal case: most Synthea conditions in a general population are
    // administrative or social, so a patient can easily carry conditions and no
    // platform problem at all.
    const result = problemListFromConditions(['Medication review due (situation)', 'Full-time employment (finding)']);
    expect(result.problems).toEqual([]);
    expect(result.unmatched).toHaveLength(2);
  });

  it('classifies a suspected differential as unmatched, not as a diagnosis', () => {
    const result = problemListFromConditions(['Suspected prostate cancer (situation)']);
    expect(result.problems).toEqual([]);
    expect(result.unmatched.map((u) => u.display)).toEqual(['Suspected prostate cancer (situation)']);
  });
});
