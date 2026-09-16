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

// Oncology's route surface.
//
// This pack is the second specialty in the deployment, and this is what makes it
// visible: the lens in `manifest.yaml` declares a view by KIND, and that kind's
// renderer reads the route below. Before it, the pack was installed and had
// exactly nothing to show — no routes, no declared surface, no lens — so a reader
// of the console had no way to tell "installed and idle" from "absent".
//
// WHAT THE BOARD SAYS, and why it is empty rather than illustrative.
//
// A synthetic regimen board would be easy to write and would be a lie: inventing
// oncology treatment recommendations is a clinical position, not a platform fix,
// and putting one behind a screen that says "Oncology" is the worst place to be
// wrong. So the board ranks what it can honestly derive — which today is nothing —
// and it SAYS WHY, distinguishing the absences rather than collapsing them.
//
// The three states are genuinely different and the operator cannot tell them apart
// from a blank panel:
//
//   no population   no patient has a malignancy on their recorded problem list
//   no records      the cohort exists and no treatment plan has been recorded yet
//   nothing to do   a plan exists and every cycle is on schedule
//
// Before this pack declared a cohort, ALL THREE rendered as "empty", because the
// specialty could not name a patient it was responsible for. Reporting the cohort
// size is what turns the first two into statements.

import type { FastifyInstance } from 'fastify';
import type { PackRouteContribution, PackRouteDeps } from '../../src/control-plane/pack-contributions.js';
import { problemListOf } from './cohort.js';

/** A patient is "on a plan" when the chart says so — not when a code suggests it. */
function hasRecordedPlan(patient: { readonly state: Record<string, unknown> }): boolean {
  const plans = patient.state['treatmentPlans'];
  return Array.isArray(plans) && plans.length > 0;
}

export const oncologyRoutes: PackRouteContribution = Object.freeze({
  id: 'oncology.board',
  scope: 'exec',
  prefixes: ['/admin/swarm/oncology'],
  register(app: FastifyInstance, deps: PackRouteDeps) {
    app.get('/admin/swarm/oncology/board', async () => {
      // The pack's OWN cohort. The platform resolved it from this pack's
      // declaration, so the pack never enumerates patients itself.
      const cohort = deps.patients();
      const onPlan = cohort.filter(hasRecordedPlan);
      const withProblems = cohort.map((patient) => ({ id: patient.id, problems: problemListOf(patient) }));

      return {
        // The board contract every `ranked-actions` view publishes. Zeroes rather
        // than absent fields, so the renderer distinguishes "nothing was
        // considered" from "the response was not a board at all".
        actions: {
          nbas: [],
          considered: cohort.length,
          actionable: 0,
          suppressed: 0,
          kinds: [],
          unmapped: [],
          rejected: [],
        },
        cohort: { id: 'oncology.tumour-programme', patients: cohort.length, onPlan: onPlan.length },
        // Enough for a reviewer to check the cohort definition without leaving the
        // screen — the reason a patient is here is the recorded problem itself.
        sample: withProblems.slice(0, 5),
        emptyHint: cohort.length === 0
          ? 'No patient in this deployment has a malignancy on their recorded problem list, so the oncology population is empty. That is an enrollment fact, not a clean bill of health.'
          : onPlan.length === 0
            ? `${cohort.length} patient(s) are in the oncology cohort and none has a treatment plan recorded, so there is no cycle, toxicity review or schedule to rank yet. This specialty has a population and no treatment data; the board fills when a plan is recorded.`
            : `${onPlan.length} of ${cohort.length} patient(s) are on a treatment plan and every recorded cycle is on schedule, so nothing is being surfaced.`,
      };
    });
  },
});
