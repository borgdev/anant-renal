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

// Oncology's population.
//
// Until this existed the pack received EVERY patient in the deployment and had no
// way to say which were its own — the platform had one projection and handed it to
// everyone. That is why oncology's board was empty: not because nothing needed
// doing, but because the specialty could not identify a single patient it was
// responsible for.
//
// The predicate is deliberately narrow and boring. A cohort definition a
// clinician would argue about is a clinical position, and a wrong one presented as
// code is worse than no board; "has a tumour on the problem list" is the smallest
// claim that is certainly true, and everything downstream can only narrow it.

import type { PackCohort, PackPatient } from '../../src/control-plane/pack-contributions.js';

/**
 * Problem-list entries this specialty considers its own.
 *
 * Read out of the patient's recorded problem list rather than inferred from
 * medication, lab values or trajectory — a patient is in the oncology population
 * because someone RECORDED a malignancy on their chart, which is a fact the
 * platform carries and the pack can check. Inferring membership from treatment
 * codes would enrol patients who are being investigated rather than treated.
 */
export const ONCOLOGY_PROBLEMS: readonly string[] = Object.freeze([
  'NSCLC',
  'Breast cancer',
  'Colorectal cancer',
  'RCC',
]);

/** The recorded problem list, defensively — `state` is an untyped bag on the wire. */
export function problemListOf(patient: PackPatient): readonly string[] {
  const raw = patient.state['problemList'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/** Does this patient belong to the oncology population? */
export function hasOncologyProblem(patient: PackPatient): boolean {
  return problemListOf(patient).some((problem) => ONCOLOGY_PROBLEMS.includes(problem));
}

export const oncologyCohort: PackCohort = Object.freeze({
  id: 'oncology.tumour-programme',
  includes: hasOncologyProblem,
  // Says which absence this is. A blank board, "no patients enrolled" and "no
  // treatment plan recorded yet" render identically and mean three different
  // things, and only the pack knows which one a deployment is looking at.
  emptyReason:
    'No patient in this deployment has a malignancy on their recorded problem list, so the oncology population is empty. '
    + 'That is an enrollment fact, not a clean bill of health.',
});
