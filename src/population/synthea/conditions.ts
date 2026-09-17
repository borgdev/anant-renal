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

// S3 — Synthea's condition vocabulary → the platform's problem list.
//
// This is the file that decides which specialties a seeded patient belongs to, and
// §4.5 of the plan calls it Synthea's strongest contribution for a specific reason:
// `problemList` is the ONE piece of patient state the trajectory engine never
// overwrites. `labs` and `lastVitals` are re-patched from the model every tick, so a
// seeded lab value is an initial condition consumed on tick 1 — but a problem list
// shapes the event vector for the patient's whole life in the realm. Get this wrong
// and the population is clinically empty no matter how good the labs are.
//
// ---------------------------------------------------------------------------
// WHY THIS MATCHES ON DISPLAY TEXT AND NOT ON SNOMED CODES
// ---------------------------------------------------------------------------
// The obvious implementation is a `code → term` table, and it is the wrong one here
// for two reasons.
//
// First, **a SNOMED code in a source file reads as authoritative.** The repository
// has already paid for this lesson once: `src/ontology/seeds.ts` ships seven
// miscoded concepts — LOINC `33914-3` labelled "Estimated urea Kt/V" is GFR(MDRD),
// RxNorm `104375` labelled "Epoetin alfa 4000" is lisinopril — and they survived
// because a plausible-looking code is not reviewed the way a sentence is. A mapping
// table keyed by code would need every entry verified against a terminology server
// before it could be trusted, and nothing would fail loudly if one were wrong.
//
// Second, **Synthea's own display text IS the generator's terminology.** It is
// emitted by the same clinical modules that decide whether the patient has the
// condition, so it is the most direct statement of what happened that exists in the
// artifact. Matching it cannot disagree with the generator.
//
// The cost is real and is mitigated rather than denied: the patterns below were
// derived by generating a 150-patient population and extracting every distinct
// condition display from it, and `tests/population-conditions.test.ts` pins a table
// of those verbatim displays. If Synthea renames a concept upstream, that test's
// fixture is the thing that goes stale first, and it fails visibly instead of
// silently moving patients between cohorts.
//
// ---------------------------------------------------------------------------
// TWO MAPPING BUGS THE MEASUREMENT FOUND, AND HOW
// ---------------------------------------------------------------------------
// Deriving from real output is not a formality — it caught two defects that reading
// the patterns could not, both by running the vocabulary over all 215 distinct
// displays in the sample and diffing against a second, independent matcher:
//
//   1. **First-match-only dropped `DM2`.** `problemsForCondition` used `.find()`, so
//      only the first matching rule contributed, while the `DM2` rule's own basis
//      said diabetic kidney disease "contributes DM2 AND CKD". Measured: exactly one
//      display disagreed with a match-all matcher — `Disorder of kidney due to
//      diabetes mellitus (disorder)`, 17 patients — and every one of those patients
//      silently lost their type 2 diabetes flag. Fixed by collecting from every
//      matching rule.
//   2. **`Suspected …` was read as a diagnosis.** The NSCLC rule excluded
//      `Suspected lung cancer` by hand, which held for one of the three uncertainty
//      displays the population actually contains. `Suspected disease caused by Severe
//      acute respiratory coronavirus 2` — 17 patients, the LARGEST single contributor
//      to `Sepsis-risk` — and `Suspected prostate cancer` were being recorded as things
//      the patient has. Fixed by a declared guard, so the rule that one entry was
//      written to satisfy is now true of the vocabulary rather than of that entry.
//
// Both fixes were re-measured against the same population: the corpus now agrees with
// the independent matcher on all 215 displays.

/**
 * One recognised clinical problem.
 *
 * `patterns` are matched case-insensitively against `Condition.code.coding[0].display`.
 * EVERY matching rule contributes its terms, in vocabulary order — the list is ordered
 * so a specific presentation is described before a general one, not to shadow it.
 * `Disorder of kidney due to diabetes mellitus` matches both the CKD and the DM2 rule
 * on purpose: a diabetic-kidney patient is a type 2 diabetic, and the existence of a
 * more specific rule is not evidence against the more general one.
 */
export interface ProblemRule {
  /** Platform problem-list terms this condition contributes. */
  readonly terms: readonly string[];
  readonly patterns: readonly RegExp[];
  /** Why this mapping, for a reader who has to judge it. */
  readonly basis: string;
}

/**
 * The platform's problem vocabulary.
 *
 * The renal and oncology terms are not invented here — they are the union of what
 * `StaticPatientSource` already writes (`src/population/static-source.ts`
 * `problemsFor`) and what the oncology cohort matches on
 * (`packs/oncology-provider/cohort.ts` `ONCOLOGY_PROBLEMS`). A Synthea patient
 * therefore lands in exactly the cohorts a static patient could.
 *
 * TWO KNOWN GAPS, stated rather than hidden, both of which are population-quality
 * questions for S5 and not mapping bugs:
 *
 *   • `ONCOLOGY_PROBLEMS` is `[NSCLC, Breast cancer, Colorectal cancer, RCC]`.
 *     Synthea emits prostate neoplasms and no renal-cell carcinoma at all, so a
 *     seeded population cannot satisfy the RCC arm and produces prostate patients
 *     the cohort does not currently claim. `Prostate cancer` is mapped here because
 *     it is clinically true; extending the cohort's vocabulary is the pack's call.
 *   • Synthea has no concept of dialysis vintage, access type or "underdialysed".
 *     Those stay seeder-authored in `enrich.ts`, and their absence is why a seeded
 *     population is a *baseline* rather than a dialysis population (plan §4.6).
 */
export const PROBLEM_VOCABULARY: readonly ProblemRule[] = Object.freeze([
  {
    terms: ['ESRD'],
    patterns: [/end.?stage renal disease/i, /end.?stage kidney disease/i, /chronic kidney disease stage 5/i],
    basis: 'ESRD — the renal cohort\'s defining term, matching the static source.',
  },
  {
    terms: ['CKD-MBD'],
    patterns: [/disorder of phosphorus metabolism/i, /hyperphosphata?emia/i, /renal osteodystrophy/i, /secondary hyperparathyroidism/i],
    basis: 'CKD-MBD: phosphate/parathyroid disorders. Rare in Synthea (see §4.6).',
  },
  {
    terms: ['Hyperphosphatemia'],
    patterns: [/hyperphosphata?emia/i],
    basis: 'Reported phosphate above target; also drives the phosphate event feature.',
  },
  {
    terms: ['CKD-anemia'],
    patterns: [/anemia (?:in|due to).{0,30}(?:chronic kidney|renal|kidney)/i, /anemia of chronic kidney disease/i, /renal anemia/i],
    basis: 'Anaemia ATTRIBUTED to kidney disease. Deliberately not generic "anemia" — see the generic rule below.',
  },
  {
    terms: ['CKD'],
    patterns: [/chronic kidney disease/i, /chronic renal (?:failure|insufficiency|disease)/i, /diabetic nephropathy/i, /disorder of kidney due to diabetes/i, /kidney transplant/i, /renal transplant/i],
    basis: 'Any CKD stage, diabetic nephropathy, or transplant history — all reason over kidney function.',
  },
  {
    terms: ['DM2'],
    patterns: [/diabetes mellitus type 2/i, /type 2 diabetes/i, /type ii diabetes/i, /diabetes mellitus type ii/i, /disorder of kidney due to diabetes/i, /diabetic (?:nephropathy|retinopathy|neuropathy)/i],
    basis: 'T2DM and its microvascular complications. Diabetic kidney disease contributes DM2 AND CKD.',
  },
  {
    terms: ['HTN'],
    patterns: [/essential hypertension/i, /hypertensive (?:disorder|disease|renal)/i, /hypertension/i],
    basis: 'Hypertension — present in nearly every dialysis patient; the renal packs treat it as standard comorbidity.',
  },
  {
    terms: ['Hyperlipidemia'],
    patterns: [/hyperlipidemia/i, /hyperlipidaemia/i, /hypertriglyceridemia/i, /hypercholesterolemia/i],
    basis: 'Lipid disorder, matching the static source\'s primary-care and dialysis lists.',
  },
  {
    terms: ['CHF'],
    patterns: [/congestive heart failure/i, /heart failure/i, /left ventricular failure/i],
    basis: 'Heart failure — the fluid/IDH pack\'s principal competing risk.',
  },
  {
    terms: ['CAD'],
    patterns: [/ischemic heart disease/i, /ischaemic heart disease/i, /coronary artery disease/i, /myocardial infarction/i, /angina/i],
    basis: 'Coronary disease, matching the static source\'s hospital list.',
  },
  {
    terms: ['Sepsis-risk'],
    patterns: [/sepsis/i, /septic/i, /bactera?emia/i, /(?:severe acute respiratory|sars.?cov.?2|covid)/i],
    basis: 'Infection history. The infection pack triages on serial temperature/PCT/NLR, not on this term, but it is a real risk marker.',
  },
  // ---- oncology -------------------------------------------------------------
  {
    terms: ['NSCLC'],
    patterns: [/non.?small cell (?:lung )?(?:cancer|carcinoma)/i, /non.?small cell carcinoma of lung/i],
    basis: 'NSCLC — in ONCOLOGY_PROBLEMS. Excludes "suspected lung cancer", which is a suspicion, not a diagnosis.',
  },
  {
    terms: ['Breast cancer'],
    patterns: [/malignant neoplasm of breast/i, /carcinoma of breast/i, /breast cancer/i],
    basis: 'Breast cancer — in ONCOLOGY_PROBLEMS.',
  },
  {
    terms: ['Colorectal cancer'],
    patterns: [/(?:malignant|overlapping malignant) neoplasm of colon/i, /malignant (?:neoplasm|tumou?r) of (?:colon|rectum|colorectum)/i, /colorectal cancer/i],
    basis: 'Colorectal cancer — in ONCOLOGY_PROBLEMS.',
  },
  {
    terms: ['RCC'],
    patterns: [/malignant neoplasm of kidney/i, /renal cell carcinoma/i, /malignant tumou?r of kidney/i],
    basis: 'Renal cell carcinoma — in ONCOLOGY_PROBLEMS. Synthea emits none in the measured sample; mapped so it is not silently unmapped if a module emits one.',
  },
  {
    terms: ['Prostate cancer'],
    patterns: [/(?:malignant )?neoplasm of prostate/i, /carcinoma in situ of prostate/i, /prostate cancer/i],
    basis: 'Prostate cancer. NOT in ONCOLOGY_PROBLEMS today — see the gap note above.',
  },
  // ---- generic, last so nothing above is shadowed ---------------------------
  {
    terms: ['Anemia'],
    patterns: [/^anemia \(disorder\)$/i, /anaemia/i],
    basis: 'Generic anaemia. Kept distinct from CKD-anemia: attributing a bare "Anemia" finding to kidney disease would overclaim.',
  },
]);

/** Strip Synthea's trailing qualifier — every display ends `(disorder)` / `(finding)` / `(situation)`. */
export function conditionLabel(display: string): string {
  return display.replace(/\s*\((?:disorder|finding|situation|procedure|morphologic abnormality|event)\)\s*$/i, '').trim();
}

/**
 * A display that states a suspicion rather than a diagnosis.
 *
 * Synthea files a differential as its own `Condition`, and a problem list is a
 * statement of what a patient HAS. See the header for the measurement that put this
 * guard here: a `Suspected …` display is not a finding, whatever terminology follows.
 *
 * Deliberately narrow — a leading uncertainty word, not a substring search, so
 * `Sepsis caused by virus` is unaffected while `Suspected … SARS-CoV-2` is not read as
 * a sepsis history.
 */
const UNCERTAINTY_PREFIX = /^\s*(?:suspected|possible|probable|questionable|differential|rule[ -]?out|ruled[ -]?out)\b/i;

/**
 * Every term in the vocabulary, in declaration order, deduplicated.
 *
 * Derived rather than retyped: the ordering IS the sort order callers depend on, so
 * it has to come from the same list the rules do.
 */
const VOCABULARY_ORDER: readonly string[] = PROBLEM_VOCABULARY.flatMap((r) => r.terms).filter((t, i, all) => all.indexOf(t) === i);

/**
 * The platform problem terms a single condition display contributes.
 *
 * An empty result means EITHER the display is unrecognised or it states a suspicion;
 * both are reported by `problemListFromConditions` as unmatched, which is how a
 * coverage gap stays visible instead of becoming a silent zero.
 */
export function problemsForCondition(display: string | undefined): readonly string[] {
  if (!display || UNCERTAINTY_PREFIX.test(display)) return [];
  const terms = new Set<string>();
  for (const rule of PROBLEM_VOCABULARY) {
    if (rule.patterns.some((p) => p.test(display))) for (const t of rule.terms) terms.add(t);
  }
  if (terms.size === 0) return [];
  return VOCABULARY_ORDER.filter((t) => terms.has(t));
}

/** Whether a condition display is recognised at all. */
export function isRecognisedCondition(display: string | undefined): boolean {
  return problemsForCondition(display).length > 0;
}

export interface ProblemListResult {
  /** Deduplicated, in vocabulary order so the output is deterministic. */
  readonly problems: readonly string[];
  /**
   * Displays that matched NO rule, with their counts.
   *
   * Reported rather than dropped: an unmapped condition is the only signal that a
   * whole clinical area is missing from the vocabulary, and a silent drop would make
   * a population that is thin for one specialty look identical to one that is thin
   * for all of them.
   */
  readonly unmatched: ReadonlyArray<{ display: string; count: number }>;
  /** Displays matched, with the terms they produced, for auditing the mapping. */
  readonly matched: ReadonlyArray<{ display: string; terms: readonly string[] }>;
}

/**
 * Project a patient's conditions into the platform's problem list.
 *
 * Input is `{ display }` rather than a `Condition` resource so this stays pure and
 * testable without FHIR — `enrich.ts` does the graph read and passes displays here.
 */
export function problemListFromConditions(displays: readonly (string | undefined)[]): ProblemListResult {
  const terms = new Set<string>();
  const unmatchedCounts = new Map<string, number>();
  const matchedTerms = new Map<string, readonly string[]>();

  for (const display of displays) {
    if (!display) continue;
    const found = problemsForCondition(display);
    if (found.length === 0) {
      unmatchedCounts.set(display, (unmatchedCounts.get(display) ?? 0) + 1);
      continue;
    }
    matchedTerms.set(display, found);
    for (const t of found) terms.add(t);
  }

  // Deterministic order: vocabulary order, so a populated list is reproducible and
  // a diff between two runs is meaningful.
  const ordered = VOCABULARY_ORDER.filter((t) => terms.has(t));

  return {
    problems: ordered,
    unmatched: [...unmatchedCounts.entries()].map(([display, count]) => ({ display, count })).sort((a, b) => b.count - a.count || a.display.localeCompare(b.display)),
    matched: [...matchedTerms.entries()].map(([display, t]) => ({ display, terms: t })).sort((a, b) => a.display.localeCompare(b.display)),
  };
}
