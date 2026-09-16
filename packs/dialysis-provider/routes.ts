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

// The dialysis-provider pack's route surface, aggregated.
//
// One entry per migrated module, and this list is declared by the PACK. The
// platform learns that this pack serves `/admin/swarm/renal` by reading the pack,
// not by naming the module — which is what makes installing the pack the whole
// act of installing the endpoints, and what makes an uninstalled pack's endpoints
// 404 rather than 403. (404 is the honest answer: the route genuinely does not
// exist. A 403 would claim the caller lacks authority over a surface nobody
// registered.)
//
// Each module keeps its own `registerXRoutes(app, opts)` and exports a
// contribution that maps the platform's deps onto that function's options. The
// wrapper is where a platform-supplied value (`deps.patients`) meets a module
// option, so the module itself needs no knowledge of the platform's deps shape
// and its existing option-level test seams keep working.

import type { PackRouteContribution } from '../../src/control-plane/pack-contributions.js';
import { renalRoutes } from './renal-routes.js';

/** Every route this pack contributes, in registration order. */
export const dialysisProviderRoutes: readonly PackRouteContribution[] = Object.freeze([
  ...renalRoutes,
]);
