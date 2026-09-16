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
// A synthetic regimen board would be easy to write and would be a lie: this
// deployment has no oncology cohort, and inventing one would put invented clinical
// recommendations behind a screen that says "Oncology". So the board is empty AND
// NAMES THE REASON, which is the discipline the rest of the platform already
// follows — `RankedActionsPanel` takes an `emptyHint` precisely because "nothing
// ranked" must never be read as "nothing to do".
//
// The reason is a real architectural fact, not a placeholder: `PackRouteDeps.patients`
// hands every pack the same projection, and that projection is renal-shaped —
// `PackPatient` carries dialysis state (access, sessions, Kt/V, dry weight). A
// non-renal specialty therefore cannot identify its own population from it. That is
// the remaining half of the G1-phase-2 note about `renalPatientInputs` being the
// platform's patient projection; it is written down here rather than papered over
// with fake patients.

import type { FastifyInstance } from 'fastify';
import type { PackRouteContribution } from '../../src/control-plane/pack-contributions.js';

const EMPTY_BOARD_REASON = [
  'No oncology cohort is enrolled in this deployment.',
  '',
  'This is not an empty worklist. The platform hands every specialty the same patient',
  'projection, and that projection is renal-shaped — PackPatient carries dialysis state',
  '(access, sessions, Kt/V, dry weight), which is how oncology would have to identify its',
  'own patients. Hoisting PackPatient to a platform shape with a specialty-neutral cohort',
  'source is what would let this board fill.',
].join('\n');

export const oncologyRoutes: PackRouteContribution = Object.freeze({
  id: 'oncology.board',
  scope: 'exec',
  prefixes: ['/admin/swarm/oncology'],
  register(app: FastifyInstance) {
    app.get('/admin/swarm/oncology/board', async () => ({
      // The board contract every `ranked-actions` view publishes. Zeroes rather
      // than absent fields, so the renderer distinguishes "nothing was considered"
      // from "the response was not a board at all".
      actions: {
        nbas: [],
        considered: 0,
        actionable: 0,
        suppressed: 0,
        kinds: [],
        unmapped: [],
        rejected: [],
      },
      // Read by the `ranked-actions` renderer and shown in place of a blank panel.
      emptyHint: EMPTY_BOARD_REASON,
    }));
  },
});
